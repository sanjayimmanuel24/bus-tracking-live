/**
 * Loads a GTFS static feed and builds the lookup indexes the app needs.
 *
 * Nothing downstream of this module knows where the feed came from. Point
 * `loadFeed` at a real agency's published GTFS URL and the rest of the
 * application is unchanged -- which is the whole reason for adopting the format.
 */

import { cumulativeDistances, type LatLng } from '../geo/geo.ts';
import { parseCsv, parseGtfsTime } from './csv.ts';
import type {
  GtfsAgency, GtfsRoute, GtfsShapePoint, GtfsStop, GtfsStopTime, GtfsTrip,
} from './types.ts';

/** A shape with its geometry pre-measured, ready for position interpolation. */
export interface ShapeIndex {
  shapeId: string;
  path: LatLng[];
  /** Cumulative metres at each vertex; same length as `path`. */
  cumulative: number[];
  totalMetres: number;
}

/** A trip with its stop_times resolved and sorted. */
export interface TripIndex {
  trip: GtfsTrip;
  stopTimes: GtfsStopTime[];
  shape: ShapeIndex;
  /** departure_time of the first stop, seconds after midnight. */
  startSec: number;
  /** arrival_time of the last stop, seconds after midnight. */
  endSec: number;
}

export interface TransitFeed {
  agency: GtfsAgency;
  routes: Map<string, GtfsRoute>;
  stops: Map<string, GtfsStop>;
  trips: Map<string, TripIndex>;
  shapes: Map<string, ShapeIndex>;
  /** Trip IDs grouped by block_id, ordered by start time -- one bus's day. */
  blocks: Map<string, string[]>;
  /** Block IDs grouped by route_id. */
  blocksByRoute: Map<string, string[]>;
  /** Route IDs in feed order, for stable UI ordering. */
  routeOrder: string[];
}

/**
 * Reads one GTFS file by name and returns its raw text.
 *
 * Abstracted so the same loader serves the browser (HTTP) and the server (disk).
 * A second implementation for Node would be a second place for GTFS quirks to be
 * handled differently, and eventually inconsistently.
 */
export type FeedReader = (file: string) => Promise<string>;

/** Reads a feed over HTTP, for the browser or from a published agency URL. */
export function httpFeedReader(baseUrl: string): FeedReader {
  return async (file) => {
    const res = await fetch(`${baseUrl}/${file}`);
    if (!res.ok) throw new Error(`Failed to load ${file}: HTTP ${res.status}`);
    return res.text();
  };
}

export async function loadFeed(baseUrl: string): Promise<TransitFeed> {
  return loadFeedFrom(httpFeedReader(baseUrl));
}

export async function loadFeedFrom(read: FeedReader): Promise<TransitFeed> {
  const readCsv = async (file: string) => parseCsv(await read(file));

  const [agencyRows, stopRows, routeRows, tripRows, stopTimeRows, shapeRows] = await Promise.all([
    readCsv('agency.txt'),
    readCsv('stops.txt'),
    readCsv('routes.txt'),
    readCsv('trips.txt'),
    readCsv('stop_times.txt'),
    readCsv('shapes.txt'),
  ]);

  const first = agencyRows[0];
  if (!first) throw new Error('agency.txt is empty');
  const agency: GtfsAgency = {
    agency_id: first['agency_id'] ?? '',
    agency_name: first['agency_name'] ?? '',
    agency_url: first['agency_url'] ?? '',
    agency_timezone: first['agency_timezone'] ?? 'UTC',
    agency_lang: first['agency_lang'],
  };

  const stops = new Map<string, GtfsStop>();
  for (const r of stopRows) {
    stops.set(r['stop_id']!, {
      stop_id: r['stop_id']!,
      stop_name: r['stop_name']!,
      stop_lat: Number(r['stop_lat']),
      stop_lon: Number(r['stop_lon']),
      location_type: Number(r['location_type'] ?? 0),
    });
  }

  const routes = new Map<string, GtfsRoute>();
  const routeOrder: string[] = [];
  for (const r of routeRows) {
    routes.set(r['route_id']!, {
      route_id: r['route_id']!,
      agency_id: r['agency_id']!,
      route_short_name: r['route_short_name']!,
      route_long_name: r['route_long_name']!,
      route_type: Number(r['route_type']),
      route_color: `#${(r['route_color'] || '888888').replace('#', '')}`,
      route_text_color: `#${(r['route_text_color'] || 'FFFFFF').replace('#', '')}`,
    });
    routeOrder.push(r['route_id']!);
  }

  // Group shape points, then measure each shape once.
  const shapePoints = new Map<string, GtfsShapePoint[]>();
  for (const r of shapeRows) {
    const id = r['shape_id']!;
    let list = shapePoints.get(id);
    if (!list) { list = []; shapePoints.set(id, list); }
    list.push({
      shape_id: id,
      shape_pt_lat: Number(r['shape_pt_lat']),
      shape_pt_lon: Number(r['shape_pt_lon']),
      shape_pt_sequence: Number(r['shape_pt_sequence']),
      shape_dist_traveled: Number(r['shape_dist_traveled']),
    });
  }

  const shapes = new Map<string, ShapeIndex>();
  for (const [id, pts] of shapePoints) {
    pts.sort((a, b) => a.shape_pt_sequence - b.shape_pt_sequence);
    const path = pts.map((p) => ({ lat: p.shape_pt_lat, lng: p.shape_pt_lon }));
    // Re-measure rather than trusting shape_dist_traveled: agency feeds vary in
    // whether it is metres, kilometres, miles, or simply absent.
    const cumulative = cumulativeDistances(path);
    shapes.set(id, { shapeId: id, path, cumulative, totalMetres: cumulative[cumulative.length - 1]! });
  }

  // Group stop_times by trip before constructing trips, so each trip gets its own.
  const stopTimesByTrip = new Map<string, GtfsStopTime[]>();
  for (const r of stopTimeRows) {
    const tripId = r['trip_id']!;
    let list = stopTimesByTrip.get(tripId);
    if (!list) { list = []; stopTimesByTrip.set(tripId, list); }
    list.push({
      trip_id: tripId,
      arrival_time: parseGtfsTime(r['arrival_time']!),
      departure_time: parseGtfsTime(r['departure_time']!),
      stop_id: r['stop_id']!,
      stop_sequence: Number(r['stop_sequence']),
      shape_dist_traveled: Number(r['shape_dist_traveled']),
    });
  }

  const trips = new Map<string, TripIndex>();
  const blocks = new Map<string, string[]>();

  for (const r of tripRows) {
    const tripId = r['trip_id']!;
    const stopTimes = stopTimesByTrip.get(tripId);
    if (!stopTimes || stopTimes.length < 2) continue; // Skip malformed trips.
    stopTimes.sort((a, b) => a.stop_sequence - b.stop_sequence);

    const shape = shapes.get(r['shape_id']!);
    if (!shape) throw new Error(`Trip ${tripId} references unknown shape "${r['shape_id']}"`);

    const trip: GtfsTrip = {
      route_id: r['route_id']!,
      service_id: r['service_id']!,
      trip_id: tripId,
      trip_headsign: r['trip_headsign']!,
      direction_id: Number(r['direction_id'] ?? 0),
      block_id: r['block_id'] || tripId,
      shape_id: r['shape_id']!,
    };

    trips.set(tripId, {
      trip,
      stopTimes,
      shape,
      startSec: stopTimes[0]!.departure_time,
      endSec: stopTimes[stopTimes.length - 1]!.arrival_time,
    });

    let blockTrips = blocks.get(trip.block_id);
    if (!blockTrips) { blockTrips = []; blocks.set(trip.block_id, blockTrips); }
    blockTrips.push(tripId);
  }

  // A block is one bus's working day -- order its trips chronologically.
  const blocksByRoute = new Map<string, string[]>();
  for (const [blockId, tripIds] of blocks) {
    tripIds.sort((a, b) => trips.get(a)!.startSec - trips.get(b)!.startSec);
    const routeId = trips.get(tripIds[0]!)!.trip.route_id;
    let list = blocksByRoute.get(routeId);
    if (!list) { list = []; blocksByRoute.set(routeId, list); }
    list.push(blockId);
  }
  for (const list of blocksByRoute.values()) list.sort();

  return { agency, routes, stops, trips, shapes, blocks, blocksByRoute, routeOrder };
}

/** Ordered stop names for a trip, for headsign and route-strip rendering. */
export function tripStopNames(feed: TransitFeed, tripId: string): string[] {
  const t = feed.trips.get(tripId);
  if (!t) return [];
  return t.stopTimes.map((st) => feed.stops.get(st.stop_id)?.stop_name ?? st.stop_id);
}
