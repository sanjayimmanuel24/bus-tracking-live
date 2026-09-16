/**
 * Compiles `data/network.ts` into a GTFS static feed under `packages/shared/gtfs/`.
 *
 * What this script derives, rather than hard-codes:
 *   - shapes.txt          route geometry + cumulative distance, in metres
 *   - stop_times.txt      arrival/departure per stop, from distance and running speed
 *   - trips.txt           a full service day of departures at the route's headway
 *   - block_id            vehicle scheduling -- which trips one bus serves in sequence
 *
 * The block assignment is a simplified first-come-first-served vehicle scheduler:
 * a bus that finishes an outbound trip waits out its layover and then takes the
 * next unassigned inbound departure from that terminus. This is what replaces the
 * prototype's modulo wrap, where a bus reaching the last stop teleported back to
 * the first. It also tells us honestly how many buses each route needs.
 *
 * Run with: npm run build:gtfs
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ROUTES, SERVICE, STOPS, type RouteDef } from '../data/network.ts';
import { cumulativeDistances, haversineMetres, type LatLng } from '../packages/shared/src/geo/geo.ts';
import { formatGtfsTime, toCsv } from '../packages/shared/src/gtfs/csv.ts';

/**
 * The feed lives in the shared package because the server publishes it and the
 * client consumes it; neither owns it.
 */
const OUT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'packages', 'shared', 'gtfs');

const AGENCY_ID = 'CBE_CITY';
const SERVICE_ID = 'DAILY';
const stopById = new Map(STOPS.map((s) => [s.id, s]));

/** Resolve a route's stop IDs to positions for the given direction. */
function stopsForDirection(route: RouteDef, directionId: 0 | 1) {
  const ids = directionId === 0 ? route.stops : [...route.stops].reverse();
  return ids.map((id) => {
    const stop = stopById.get(id);
    if (!stop) throw new Error(`Route ${route.id} references unknown stop "${id}"`);
    return stop;
  });
}

/** Headway in seconds that applies at a given time of day. */
function headwaySecAt(route: RouteDef, secondsAfterMidnight: number): number {
  const inPeak = SERVICE.peaks.some(
    (p) => secondsAfterMidnight >= p.fromSec && secondsAfterMidnight < p.toSec,
  );
  return (inPeak ? route.headwayMin.peak : route.headwayMin.offPeak) * 60;
}

interface SegmentPlan {
  /** Cumulative distance in metres from the first stop, per stop. */
  distances: number[];
  /** Seconds of running time for segment i -> i+1. */
  runTimes: number[];
  /** Total trip duration in seconds, including intermediate dwells. */
  durationSec: number;
  path: LatLng[];
}

/**
 * Derive the running plan for one direction of a route.
 *
 * Segment running time comes from real great-circle distance and the route's
 * average scheduled speed, so the timetable and the geometry can never disagree
 * -- which is precisely the inconsistency the prototype had, where the displayed
 * km/h had no relationship to how fast the marker actually moved.
 */
function planDirection(route: RouteDef, directionId: 0 | 1): SegmentPlan {
  const stops = stopsForDirection(route, directionId);
  const path: LatLng[] = stops.map((s) => ({ lat: s.lat, lng: s.lng }));
  const distances = cumulativeDistances(path);
  const speedMps = route.avgSpeedKph / 3.6;

  const runTimes: number[] = [];
  for (let i = 0; i < path.length - 1; i++) {
    const segLen = haversineMetres(path[i]!, path[i + 1]!);
    // Floor at 45s so very close stop pairs still get a plausible running time.
    runTimes.push(Math.max(45, Math.round(segLen / speedMps)));
  }

  const dwellTotal = route.dwellSec * Math.max(0, stops.length - 2);
  const durationSec = runTimes.reduce((a, b) => a + b, 0) + dwellTotal;

  return { distances, runTimes, durationSec, path };
}

interface PlannedTrip {
  routeId: string;
  directionId: 0 | 1;
  departureSec: number;
  arrivalSec: number;
  blockId: string;
  tripId: string;
}

/** A bus, tracked by when and where it next becomes available. */
interface BlockState {
  blockId: string;
  freeAtSec: number;
  /** Terminus the bus is currently sitting at: 0 = start of route, 1 = far end. */
  atEnd: 0 | 1;
}

/**
 * Generate every departure for a route across the service day, then assign each
 * to a physical bus (a "block"). Returns the trips plus the fleet size required.
 */
function scheduleRoute(route: RouteDef, plans: Record<0 | 1, SegmentPlan>): PlannedTrip[] {
  // 1. Lay out departures for each direction across the service day.
  const departures: { directionId: 0 | 1; departureSec: number }[] = [];
  for (const directionId of [0, 1] as const) {
    // Offset the inbound pattern by half a headway so the two directions interleave.
    const offset = directionId === 1 ? headwaySecAt(route, SERVICE.startSec) / 2 : 0;
    let t = SERVICE.startSec + offset;
    while (t <= SERVICE.endSec) {
      departures.push({ directionId, departureSec: Math.round(t) });
      t += headwaySecAt(route, t);
    }
  }
  departures.sort((a, b) => a.departureSec - b.departureSec);

  // 2. Assign each departure to a bus that is free and already at the right end.
  const blocks: BlockState[] = [];
  const trips: PlannedTrip[] = [];
  const perDirectionCount: Record<0 | 1, number> = { 0: 0, 1: 0 };

  for (const dep of departures) {
    const plan = plans[dep.directionId];
    const arrivalSec = dep.departureSec + plan.durationSec;

    // Prefer the bus that has been waiting longest at this terminus.
    let chosen: BlockState | undefined;
    for (const b of blocks) {
      if (b.atEnd !== dep.directionId) continue;
      if (b.freeAtSec > dep.departureSec) continue;
      if (!chosen || b.freeAtSec < chosen.freeAtSec) chosen = b;
    }

    if (!chosen) {
      chosen = {
        blockId: `${route.id}_B${String(blocks.length + 1).padStart(2, '0')}`,
        freeAtSec: dep.departureSec,
        atEnd: dep.directionId,
      };
      blocks.push(chosen);
    }

    const seq = ++perDirectionCount[dep.directionId];
    trips.push({
      routeId: route.id,
      directionId: dep.directionId,
      departureSec: dep.departureSec,
      arrivalSec,
      blockId: chosen.blockId,
      tripId: `${route.id}_D${dep.directionId}_${String(seq).padStart(3, '0')}`,
    });

    // The bus is now at the other end, and must serve its layover before departing.
    chosen.atEnd = dep.directionId === 0 ? 1 : 0;
    chosen.freeAtSec = arrivalSec + route.layoverSec;
  }

  return trips;
}

// ---------------------------------------------------------------------------

function build(): void {
  const agencies = [{
    agency_id: AGENCY_ID,
    agency_name: 'Coimbatore City Bus (demonstration feed)',
    agency_url: 'https://example.invalid/citybus',
    agency_timezone: 'Asia/Kolkata',
    agency_lang: 'en',
  }];

  const stops = STOPS.map((s) => ({
    stop_id: s.id,
    stop_name: s.name,
    stop_lat: s.lat.toFixed(6),
    stop_lon: s.lng.toFixed(6),
    location_type: 0,
  }));

  const routes: Record<string, unknown>[] = [];
  const trips: Record<string, unknown>[] = [];
  const stopTimes: Record<string, unknown>[] = [];
  const shapes: Record<string, unknown>[] = [];

  const fleetSummary: { route: string; buses: number; trips: number; cycleMin: number }[] = [];

  for (const route of ROUTES) {
    routes.push({
      route_id: route.id,
      agency_id: AGENCY_ID,
      route_short_name: route.shortName,
      route_long_name: route.longName,
      route_type: 3, // Bus
      route_color: route.color.replace('#', '').toUpperCase(),
      route_text_color: 'FFFFFF',
    });

    const plans: Record<0 | 1, SegmentPlan> = {
      0: planDirection(route, 0),
      1: planDirection(route, 1),
    };

    // One shape per direction.
    for (const directionId of [0, 1] as const) {
      const plan = plans[directionId];
      const shapeId = `${route.id}_D${directionId}`;
      plan.path.forEach((pt, i) => {
        shapes.push({
          shape_id: shapeId,
          shape_pt_lat: pt.lat.toFixed(6),
          shape_pt_lon: pt.lng.toFixed(6),
          shape_pt_sequence: i + 1,
          shape_dist_traveled: plan.distances[i]!.toFixed(1),
        });
      });
    }

    const planned = scheduleRoute(route, plans);

    for (const trip of planned) {
      const plan = plans[trip.directionId];
      const stopList = stopsForDirection(route, trip.directionId);
      const headsign = stopList[stopList.length - 1]!.name;

      trips.push({
        route_id: route.id,
        service_id: SERVICE_ID,
        trip_id: trip.tripId,
        trip_headsign: headsign,
        direction_id: trip.directionId,
        block_id: trip.blockId,
        shape_id: `${route.id}_D${trip.directionId}`,
      });

      // Walk the stop list accumulating running time and dwell.
      let clock = trip.departureSec;
      for (let i = 0; i < stopList.length; i++) {
        const isFirst = i === 0;
        const isLast = i === stopList.length - 1;
        const arrival = clock;
        // No dwell is scheduled at the termini: the first stop departs immediately,
        // the last stop ends the trip and the bus moves to layover.
        const dwell = isFirst || isLast ? 0 : route.dwellSec;
        const departure = arrival + dwell;

        stopTimes.push({
          trip_id: trip.tripId,
          arrival_time: formatGtfsTime(arrival),
          departure_time: formatGtfsTime(departure),
          stop_id: stopList[i]!.id,
          stop_sequence: i + 1,
          shape_dist_traveled: plan.distances[i]!.toFixed(1),
        });

        if (!isLast) clock = departure + plan.runTimes[i]!;
      }
    }

    const buses = new Set(planned.map((t) => t.blockId)).size;
    fleetSummary.push({
      route: route.shortName,
      buses,
      trips: planned.length,
      cycleMin: Math.round((plans[0].durationSec + plans[1].durationSec + 2 * route.layoverSec) / 60),
    });
  }

  const calendar = [{
    service_id: SERVICE_ID,
    monday: 1, tuesday: 1, wednesday: 1, thursday: 1, friday: 1, saturday: 1, sunday: 1,
    start_date: '20260101',
    end_date: '20261231',
  }];

  const feedInfo = [{
    feed_publisher_name: 'CityBus Live (generated)',
    feed_publisher_url: 'https://example.invalid/citybus',
    feed_lang: 'en',
    feed_version: new Date().toISOString().slice(0, 10),
  }];

  mkdirSync(OUT_DIR, { recursive: true });

  write('agency.txt', ['agency_id', 'agency_name', 'agency_url', 'agency_timezone', 'agency_lang'], agencies);
  write('stops.txt', ['stop_id', 'stop_name', 'stop_lat', 'stop_lon', 'location_type'], stops);
  write('routes.txt', ['route_id', 'agency_id', 'route_short_name', 'route_long_name', 'route_type', 'route_color', 'route_text_color'], routes);
  write('trips.txt', ['route_id', 'service_id', 'trip_id', 'trip_headsign', 'direction_id', 'block_id', 'shape_id'], trips);
  write('stop_times.txt', ['trip_id', 'arrival_time', 'departure_time', 'stop_id', 'stop_sequence', 'shape_dist_traveled'], stopTimes);
  write('shapes.txt', ['shape_id', 'shape_pt_lat', 'shape_pt_lon', 'shape_pt_sequence', 'shape_dist_traveled'], shapes);
  write('calendar.txt', ['service_id', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'start_date', 'end_date'], calendar);
  write('feed_info.txt', ['feed_publisher_name', 'feed_publisher_url', 'feed_lang', 'feed_version'], feedInfo);

  console.log(`\nGTFS feed written to ${OUT_DIR}`);
  console.log(`  ${stops.length} stops, ${routes.length} routes, ${trips.length} trips, ${stopTimes.length} stop_times, ${shapes.length} shape points\n`);
  console.log('  Route   Buses   Trips/day   Round trip');
  console.log('  ' + '-'.repeat(44));
  for (const f of fleetSummary) {
    console.log(`  ${f.route.padEnd(7)} ${String(f.buses).padStart(5)} ${String(f.trips).padStart(11)} ${String(f.cycleMin + ' min').padStart(12)}`);
  }
  const totalBuses = fleetSummary.reduce((a, f) => a + f.buses, 0);
  console.log('  ' + '-'.repeat(44));
  console.log(`  ${'TOTAL'.padEnd(7)} ${String(totalBuses).padStart(5)} ${String(trips.length).padStart(11)}\n`);
}

function write(file: string, header: string[], rows: Record<string, unknown>[]): void {
  writeFileSync(resolve(OUT_DIR, file), toCsv(header, rows), 'utf8');
}

build();
