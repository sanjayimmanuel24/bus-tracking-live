/**
 * A minimal in-memory `TransitFeed` for tests.
 *
 * Built by hand rather than loaded from `public/gtfs/` so that tests exercise the
 * logic under test and not the generated data -- and so a change to the network
 * definition cannot silently alter what a test is asserting.
 */

import { cumulativeDistances, type LatLng } from '../src/geo/geo.ts';
import type { ShapeIndex, TransitFeed, TripIndex } from '../src/gtfs/feed.ts';
import type { GtfsStopTime } from '../src/gtfs/types.ts';

/** Four stops in a straight north-bound line, roughly 1 km apart. */
export const FIXTURE_STOPS: { id: string; name: string; pos: LatLng }[] = [
  { id: 'S1', name: 'Alpha',  pos: { lat: 11.0000, lng: 77.0000 } },
  { id: 'S2', name: 'Bravo',  pos: { lat: 11.0090, lng: 77.0000 } },
  { id: 'S3', name: 'Charlie', pos: { lat: 11.0180, lng: 77.0000 } },
  { id: 'S4', name: 'Delta',  pos: { lat: 11.0270, lng: 77.0000 } },
];

export function makeShape(shapeId: string, path: LatLng[]): ShapeIndex {
  const cumulative = cumulativeDistances(path);
  return { shapeId, path, cumulative, totalMetres: cumulative[cumulative.length - 1]! };
}

/**
 * Build a trip departing at `startSec`, running each segment at `speedKph` with
 * `dwellSec` at intermediate stops.
 */
export function makeTrip(
  tripId: string,
  shape: ShapeIndex,
  startSec: number,
  opts: { speedKph?: number; dwellSec?: number; blockId?: string; directionId?: 0 | 1 } = {},
): TripIndex {
  const directionId = opts.directionId ?? 0;
  // Consecutive trips in a block alternate direction, so the inbound trip serves
  // the same stops in reverse -- and crucially starts where the outbound ended.
  const stops = directionId === 0 ? FIXTURE_STOPS : [...FIXTURE_STOPS].reverse();
  const speedMps = (opts.speedKph ?? 20) / 3.6;
  const dwellSec = opts.dwellSec ?? 30;

  const stopTimes: GtfsStopTime[] = [];
  let clock = startSec;

  for (let i = 0; i < shape.path.length; i++) {
    const isFirst = i === 0;
    const isLast = i === shape.path.length - 1;
    const arrival = clock;
    const departure = arrival + (isFirst || isLast ? 0 : dwellSec);

    stopTimes.push({
      trip_id: tripId,
      arrival_time: arrival,
      departure_time: departure,
      stop_id: stops[i]!.id,
      stop_sequence: i + 1,
      shape_dist_traveled: shape.cumulative[i]!,
    });

    if (!isLast) {
      const segment = shape.cumulative[i + 1]! - shape.cumulative[i]!;
      // GTFS times are whole seconds; keeping fractions here would make the
      // fixture unrepresentative of any real feed.
      clock = Math.round(departure + segment / speedMps);
    }
  }

  return {
    trip: {
      route_id: 'RT1',
      service_id: 'DAILY',
      trip_id: tripId,
      trip_headsign: stops[stops.length - 1]!.name,
      direction_id: directionId,
      block_id: opts.blockId ?? 'BLK1',
      shape_id: shape.shapeId,
    },
    stopTimes,
    shape,
    startSec: stopTimes[0]!.departure_time,
    endSec: stopTimes[stopTimes.length - 1]!.arrival_time,
  };
}

export function makeFeed(trips: TripIndex[]): TransitFeed {
  const shapes = new Map(trips.map((t) => [t.shape.shapeId, t.shape]));
  const tripMap = new Map(trips.map((t) => [t.trip.trip_id, t]));

  const blocks = new Map<string, string[]>();
  for (const t of trips) {
    const list = blocks.get(t.trip.block_id) ?? [];
    list.push(t.trip.trip_id);
    blocks.set(t.trip.block_id, list);
  }
  for (const list of blocks.values()) {
    list.sort((a, b) => tripMap.get(a)!.startSec - tripMap.get(b)!.startSec);
  }

  return {
    agency: {
      agency_id: 'TEST', agency_name: 'Test', agency_url: 'https://example.invalid',
      agency_timezone: 'Asia/Kolkata',
    },
    routes: new Map([['RT1', {
      route_id: 'RT1', agency_id: 'TEST', route_short_name: '1', route_long_name: 'Alpha to Delta',
      route_type: 3, route_color: '#1d6ef5', route_text_color: '#ffffff',
    }]]),
    stops: new Map(FIXTURE_STOPS.map((s) => [s.id, {
      stop_id: s.id, stop_name: s.name, stop_lat: s.pos.lat, stop_lon: s.pos.lng, location_type: 0,
    }])),
    trips: tripMap,
    shapes,
    blocks,
    blocksByRoute: new Map([['RT1', [...blocks.keys()]]]),
    routeOrder: ['RT1'],
  };
}
