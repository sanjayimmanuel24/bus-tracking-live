/**
 * Vehicle simulator.
 *
 * Produces a GTFS-Realtime snapshot stream from the GTFS static schedule. It is a
 * stand-in for real vehicle telemetry, and it is deliberately confined behind the
 * `FeedSource` interface so that nothing downstream can tell the difference.
 *
 * DESIGN: delay is emergent, not assigned.
 * The prototype flipped a vehicle between "on-time" and "delayed" at random every
 * 18 ticks. Here a bus runs each segment at its *scheduled* speed multiplied by a
 * congestion factor, dwells for as long as boarding actually takes, and its delay
 * is then measured by comparing where it is against where the timetable says it
 * should be. Congestion and crowding cause delay; delay is not an input.
 *
 * This matters beyond realism: it means schedule adherence, ETA error and bunching
 * are all measurable properties of the simulation rather than decorative labels,
 * which is what makes them worth building analytics on in later phases.
 */

import { pointAlongPath, type LatLng } from '../geo/geo.ts';
import type { TransitFeed, TripIndex } from '../gtfs/feed.ts';
import { nextStopIndexAtDistance, scheduledDistanceAtTime, scheduledTimeAtDistance } from '../gtfs/schedule.ts';
import { formatGtfsTime } from '../gtfs/csv.ts';
import {
  occupancyStatusFor,
  type FeedSource, type RealtimeSnapshot, type ServiceAlert,
  type TripUpdate, type VehiclePosition, type VehicleStopStatus,
} from '../realtime/types.ts';
import { predictRemainingStops } from '../eta/predict.ts';
import { vehicleForBlock, type VehicleIdentity } from './fleet.ts';
import { gaussian, hashString, mulberry32 } from './rng.ts';

/** How a bus is currently occupied. */
type Phase = 'depot' | 'dwelling' | 'running' | 'layover' | 'finished';

interface SimBus {
  identity: VehicleIdentity;
  routeId: string;
  blockId: string;
  /** Trips this bus works today, in order. */
  blockTrips: string[];
  tripCursor: number;
  phase: Phase;
  /** Index into the current trip's stopTimes: the stop being travelled to, or dwelt at. */
  stopIndex: number;
  /** Distance travelled along the current trip's shape, in metres. */
  distanceM: number;
  dwellUntilSec: number;
  /** Multiplier on scheduled running speed. Mean-reverts to `congestionBias`. */
  congestion: number;
  congestionBias: number;
  /** Seconds remaining of an active traffic incident. */
  incidentSec: number;
  passengers: number;
  /** Seconds ahead of (negative) or behind (positive) schedule. */
  delaySec: number;
  position: LatLng;
  bearing: number;
  speedMps: number;
  rng: () => number;
}

export interface SimulatorOptions {
  /** Simulated seconds after midnight to start from. */
  startSec: number;
  /** Simulated seconds elapsed per real second. */
  timeScale: number;
  /** Snapshots emitted per real second. */
  snapshotHz: number;
  /** Seeded for reproducibility. */
  seed: number;
  /** Seated capacity per route, keyed by route_id. */
  capacityByRoute: Record<string, number>;
}

const DEFAULTS: Omit<SimulatorOptions, 'capacityByRoute'> = {
  startSec: 8 * 3600,
  timeScale: 8,
  snapshotHz: 2,
  seed: 20260916,
};

/**
 * Simulated seconds run before the clock reaches the requested start time.
 *
 * Warm-starting places every bus exactly on schedule, which would show a network
 * at 100% on-time performance -- as unrealistic as showing it at 0%. Running a
 * burn-in lets congestion, crowding and dwell overruns produce a natural spread
 * of delays before anyone looks at the screen.
 */
const BURN_IN_SEC = 900;

/** Delay beyond which a vehicle counts as late, in seconds. Transit-industry norm. */
export const ON_TIME_THRESHOLD_SEC = 180;
/** Ahead of schedule beyond this is "running early", which is its own problem. */
export const EARLY_THRESHOLD_SEC = -90;

export class SimulatedFeedSource implements FeedSource {
  private readonly feed: TransitFeed;
  private readonly opts: SimulatorOptions;
  private readonly buses: SimBus[] = [];
  private listeners = new Set<(s: RealtimeSnapshot) => void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastRealMs = 0;
  private alerts: ServiceAlert[] = [];
  private alertSeq = 0;

  /** Simulated seconds after midnight. */
  public simSec: number;

  constructor(feed: TransitFeed, options: Partial<SimulatorOptions> = {}) {
    this.feed = feed;
    this.opts = { ...DEFAULTS, capacityByRoute: {}, ...options };
    this.simSec = this.opts.startSec;
    this.buses = this.createFleet();

    // Place each bus at the point in its working day that the clock implies, then
    // run a burn-in so delays are emergent rather than uniformly zero.
    this.simSec = Math.max(0, this.opts.startSec - BURN_IN_SEC);
    this.warmStart();
    this.advance(BURN_IN_SEC);
  }

  /**
   * Fast-forward every block to the current simulation time.
   *
   * Without this, a bus always begins with the first trip of its block -- the
   * 05:30 departure -- no matter what the clock says. Opening the app at 08:00
   * would then show the entire fleet two and a half hours behind schedule, and
   * on-time performance pinned at zero.
   */
  private warmStart(): void {
    for (const bus of this.buses) {
      // Skip trips that finished before the clock.
      while (bus.tripCursor < bus.blockTrips.length) {
        const trip = this.feed.trips.get(bus.blockTrips[bus.tripCursor]!);
        if (!trip || trip.endSec >= this.simSec) break;
        bus.tripCursor += 1;
      }

      const tripId = bus.blockTrips[bus.tripCursor];
      if (!tripId) { bus.phase = 'finished'; continue; }

      const trip = this.feed.trips.get(tripId)!;
      // Not yet departed: wait in the depot, as `stepBus` would have it.
      if (this.simSec < trip.startSec) { bus.phase = 'depot'; continue; }

      // Mid-trip: drop the bus exactly where the timetable puts it right now.
      this.beginTrip(bus, trip);
      const distance = scheduledDistanceAtTime(trip, this.simSec);
      bus.distanceM = distance;

      bus.stopIndex = nextStopIndexAtDistance(trip, distance);
      bus.phase = 'running';
      bus.delaySec = 0;

      // Give the bus a plausible standing load rather than starting it empty.
      const demand = this.demandFactor();
      bus.passengers = Math.max(0, Math.round(bus.identity.capacity * 0.3 * demand));

      this.updatePosition(bus, trip);
    }
  }



  private createFleet(): SimBus[] {
    const buses: SimBus[] = [];
    for (const [blockId, tripIds] of this.feed.blocks) {
      const firstTrip = this.feed.trips.get(tripIds[0]!);
      if (!firstTrip) continue;
      const routeId = firstTrip.trip.route_id;
      const capacity = this.opts.capacityByRoute[routeId] ?? 50;
      const rng = mulberry32(hashString(blockId) ^ this.opts.seed);
      // Per-vehicle bias: some buses habitually run a little slow, as in reality.
      const bias = Math.max(0.72, Math.min(1.08, gaussian(rng, 0.94, 0.08)));

      buses.push({
        identity: vehicleForBlock(blockId, capacity),
        routeId,
        blockId,
        blockTrips: tripIds,
        tripCursor: 0,
        phase: 'depot',
        stopIndex: 0,
        distanceM: 0,
        dwellUntilSec: 0,
        congestion: bias,
        congestionBias: bias,
        incidentSec: 0,
        passengers: 0,
        delaySec: 0,
        position: { lat: firstTrip.shape.path[0]!.lat, lng: firstTrip.shape.path[0]!.lng },
        bearing: 0,
        speedMps: 0,
        rng,
      });
    }
    return buses;
  }

  // -- FeedSource ----------------------------------------------------------

  subscribe(listener: (snapshot: RealtimeSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  start(): void {
    if (this.timer !== null) return;
    this.lastRealMs = performance.now();
    // Plain setInterval, not window.setInterval: this class runs in the browser
    // in Phase 1 and inside the server's simulator worker in Phase 2.
    this.timer = setInterval(() => this.frame(), 1000 / this.opts.snapshotHz);
    this.emit();
  }

  stop(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  setTimeScale(scale: number): void {
    this.opts.timeScale = Math.max(1, scale);
  }

  getTimeScale(): number {
    return this.opts.timeScale;
  }

  private frame(): void {
    const now = performance.now();
    // Clamp the real-time delta: a backgrounded tab can accumulate minutes of
    // wall-clock, and replaying that in one step teleports every bus.
    const realDeltaSec = Math.min(0.5, (now - this.lastRealMs) / 1000);
    this.lastRealMs = now;
    this.advance(realDeltaSec * this.opts.timeScale);
    this.emit();
  }

  // -- Simulation ----------------------------------------------------------

  /**
   * Advance the simulation by `dtSim` simulated seconds.
   *
   * Sub-stepped so that a large time scale cannot make a bus jump past a stop
   * without registering the arrival. At 60x with 2Hz snapshots a raw step would
   * be 30 simulated seconds, enough to skip a short segment entirely.
   */
  advance(dtSim: number): void {
    const MAX_STEP_SEC = 5;
    let remaining = dtSim;
    while (remaining > 0) {
      const step = Math.min(MAX_STEP_SEC, remaining);
      this.simSec += step;
      for (const bus of this.buses) this.stepBus(bus, step);
      remaining -= step;
    }
    this.expireAlerts();
  }

  private stepBus(bus: SimBus, dt: number): void {
    this.updateCongestion(bus, dt);

    switch (bus.phase) {
      case 'depot':
      case 'layover': {
        const tripId = bus.blockTrips[bus.tripCursor];
        if (!tripId) { bus.phase = 'finished'; return; }
        const trip = this.feed.trips.get(tripId)!;
        if (this.simSec >= trip.startSec) this.beginTrip(bus, trip);
        return;
      }

      case 'dwelling': {
        const trip = this.currentTrip(bus);
        if (!trip) return;
        if (this.simSec < bus.dwellUntilSec) { bus.speedMps = 0; return; }

        const isLast = bus.stopIndex >= trip.stopTimes.length - 1;
        if (isLast) { this.endTrip(bus); return; }

        bus.stopIndex += 1;
        bus.phase = 'running';
        return;
      }

      case 'running': {
        const trip = this.currentTrip(bus);
        if (!trip) return;
        const prev = trip.stopTimes[bus.stopIndex - 1]!;
        const next = trip.stopTimes[bus.stopIndex]!;

        const segMetres = Math.max(1, next.shape_dist_traveled - prev.shape_dist_traveled);
        const segSeconds = Math.max(1, next.arrival_time - prev.departure_time);
        const scheduledMps = segMetres / segSeconds;

        bus.speedMps = Math.max(0, scheduledMps * bus.congestion);
        bus.distanceM += bus.speedMps * dt;

        if (bus.distanceM >= next.shape_dist_traveled) {
          bus.distanceM = next.shape_dist_traveled;
          this.arriveAtStop(bus, trip);
        }

        this.updatePosition(bus, trip);
        bus.delaySec = this.simSec - scheduledTimeAtDistance(trip, bus.distanceM);
        return;
      }

      case 'finished':
        return;
    }
  }

  private beginTrip(bus: SimBus, trip: TripIndex): void {
    bus.phase = 'dwelling';
    bus.stopIndex = 0;
    bus.distanceM = trip.stopTimes[0]!.shape_dist_traveled;
    bus.dwellUntilSec = Math.max(this.simSec, trip.stopTimes[0]!.departure_time);
    bus.delaySec = this.simSec - trip.stopTimes[0]!.departure_time;
    // Passengers do not ride through a terminus layover.
    bus.passengers = 0;
    this.updatePosition(bus, trip);
  }

  private endTrip(bus: SimBus): void {
    bus.tripCursor += 1;
    bus.passengers = 0;
    bus.speedMps = 0;
    bus.phase = bus.tripCursor < bus.blockTrips.length ? 'layover' : 'finished';
  }

  private arriveAtStop(bus: SimBus, trip: TripIndex): void {
    const stopTime = trip.stopTimes[bus.stopIndex]!;
    const isLast = bus.stopIndex >= trip.stopTimes.length - 1;

    bus.delaySec = this.simSec - stopTime.arrival_time;
    bus.speedMps = 0;
    bus.phase = 'dwelling';

    const { boarded } = this.exchangePassengers(bus, isLast);

    // Dwell is driven by boarding, which is why busy stops generate delay:
    // roughly 0.6s per boarding passenger on top of a fixed door cycle.
    const scheduledDwell = Math.max(0, stopTime.departure_time - stopTime.arrival_time);
    const boardingSec = boarded * 0.6;
    const actualDwell = isLast ? 0 : Math.max(8, scheduledDwell * 0.7 + boardingSec);
    bus.dwellUntilSec = this.simSec + actualDwell;
  }

  /**
   * Boarding and alighting at a stop.
   *
   * Demand scales with time of day so that peak periods actually crowd the buses,
   * which in turn lengthens dwells and generates delay. Load can exceed seated
   * capacity -- standing passengers are normal on an Indian city bus -- but is
   * capped at 1.6x, past which the bus realistically refuses boarders.
   */
  private exchangePassengers(bus: SimBus, isLast: boolean): { boarded: number } {
    if (isLast) { bus.passengers = 0; return { boarded: 0 }; }

    const cap = bus.identity.capacity;
    const alightFraction = 0.12 + bus.rng() * 0.28;
    const alighted = Math.round(bus.passengers * alightFraction);
    bus.passengers = Math.max(0, bus.passengers - alighted);

    const demandFactor = this.demandFactor();
    const wanting = Math.round(gaussian(bus.rng, cap * 0.16 * demandFactor, cap * 0.06));
    const room = Math.max(0, Math.round(cap * 1.6) - bus.passengers);
    const boarded = Math.max(0, Math.min(wanting, room));
    bus.passengers += boarded;

    return { boarded };
  }

  /** Ridership multiplier by time of day: twin commuter peaks. */
  private demandFactor(): number {
    const hour = (this.simSec / 3600) % 24;
    const morning = Math.exp(-((hour - 8.5) ** 2) / 2.0);
    const evening = Math.exp(-((hour - 18.5) ** 2) / 2.5);
    return 0.45 + 1.35 * Math.max(morning, evening);
  }

  private updateCongestion(bus: SimBus, dt: number): void {
    if (bus.incidentSec > 0) {
      bus.incidentSec -= dt;
      return;
    }
    // Mean-reverting random walk around the vehicle's own bias.
    const reversion = (bus.congestionBias - bus.congestion) * 0.03 * dt;
    const noise = (bus.rng() - 0.5) * 0.04 * dt;
    bus.congestion = Math.max(0.35, Math.min(1.25, bus.congestion + reversion + noise));

    // Occasional incident: a signal failure, a jam, a level crossing.
    if (bus.rng() < 0.00025 * dt) {
      bus.incidentSec = 60 + bus.rng() * 240;
      bus.congestion = 0.18 + bus.rng() * 0.15;
      this.raiseIncidentAlert(bus);
    }
  }

  private updatePosition(bus: SimBus, trip: TripIndex): void {
    const at = pointAlongPath(trip.shape.path, trip.shape.cumulative, bus.distanceM);
    bus.position = at.position;
    // Hold the last heading while stationary; a stopped bus has no bearing.
    if (bus.speedMps > 0.1) bus.bearing = at.bearing;
  }

  private currentTrip(bus: SimBus): TripIndex | null {
    const tripId = bus.blockTrips[bus.tripCursor];
    return tripId ? this.feed.trips.get(tripId) ?? null : null;
  }



  // -- Alerts --------------------------------------------------------------

  /**
   * Service alerts are derived from simulation state, not drawn from a list of
   * pre-written strings. An alert here always corresponds to something a rider
   * could actually observe on the map.
   */
  private raiseIncidentAlert(bus: SimBus): void {
    const route = this.feed.routes.get(bus.routeId);
    const trip = this.currentTrip(bus);
    if (!route || !trip) return;
    const stopTime = trip.stopTimes[Math.min(bus.stopIndex, trip.stopTimes.length - 1)]!;
    const stop = this.feed.stops.get(stopTime.stop_id);

    this.alerts.push({
      id: `ALERT_${++this.alertSeq}`,
      cause: 'TRAFFIC_JAM',
      effect: 'SIGNIFICANT_DELAYS',
      severityLevel: 'WARNING',
      headerText: `Route ${route.route_short_name} held up near ${stop?.stop_name ?? 'the next stop'}`,
      informedEntity: [{ routeId: bus.routeId, tripId: trip.trip.trip_id, stopId: stopTime.stop_id }],
      activePeriodStart: this.posixNow(),
    });
  }

  private expireAlerts(): void {
    const cutoff = this.posixNow() - 240;
    this.alerts = this.alerts.filter((a) => a.activePeriodStart > cutoff).slice(-6);
  }

  // -- Snapshot emission ---------------------------------------------------

  /** Map simulated seconds-after-midnight onto a POSIX timestamp for today. */
  private posixNow(): number {
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    return Math.round(midnight.getTime() / 1000 + this.simSec);
  }

  private emit(): void {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) listener(snapshot);
  }

  /** Build a GTFS-Realtime FeedMessage from current simulation state. */
  snapshot(): RealtimeSnapshot {
    const timestamp = this.posixNow();
    const vehiclePositions: VehiclePosition[] = [];
    const tripUpdates: TripUpdate[] = [];

    for (const bus of this.buses) {
      // A bus still in the depot, or done for the day, is not on the road and a
      // real feed would not report it. This is why the map fills up through the
      // morning rather than showing all 48 buses stacked up at 05:30.
      if (bus.phase === 'depot' || bus.phase === 'finished') continue;

      const trip = this.currentTrip(bus);
      if (!trip) continue;

      // A bus laying over at a terminus between trips is still tracked and still
      // transmitting, so it belongs in the feed -- reported against the trip it is
      // about to work, standing at that trip's first stop. Dropping these was
      // leaving low-frequency routes with no vehicle at all for minutes at a time,
      // which reads as a broken feed rather than as a timetable gap.
      const isLayover = bus.phase === 'layover';

      const descriptor = {
        tripId: trip.trip.trip_id,
        routeId: trip.trip.route_id,
        directionId: trip.trip.direction_id,
        startTime: formatGtfsTime(trip.startSec),
        scheduleRelationship: 'SCHEDULED' as const,
      };
      const vehicle = { id: bus.identity.id, label: bus.identity.label };

      const stopIndex = isLayover ? 0 : bus.stopIndex;
      const stopTime = trip.stopTimes[stopIndex]!;
      const loadFactor = bus.passengers / bus.identity.capacity;

      // A layover bus sits at its next trip's origin; that is the same physical
      // terminus it arrived at, since consecutive trips in a block alternate ends.
      const position = isLayover ? trip.shape.path[0]! : bus.position;
      // It cannot be late for a trip it has not begun, so delay is measured only
      // once the scheduled departure has passed.
      const delaySec = isLayover ? Math.max(0, this.simSec - trip.startSec) : bus.delaySec;

      let status: VehicleStopStatus;
      if (isLayover || bus.phase === 'dwelling') status = 'STOPPED_AT';
      else if (stopTime.shape_dist_traveled - bus.distanceM < 120) status = 'INCOMING_AT';
      else status = 'IN_TRANSIT_TO';

      vehiclePositions.push({
        trip: descriptor,
        vehicle,
        position: {
          latitude: position.lat,
          longitude: position.lng,
          bearing: bus.bearing,
          speed: isLayover ? 0 : bus.speedMps,
        },
        currentStopSequence: stopTime.stop_sequence,
        currentStatus: status,
        timestamp,
        occupancyStatus: occupancyStatusFor(loadFactor),
        occupancyPercentage: Math.round(loadFactor * 100),
      });

      tripUpdates.push({
        trip: descriptor,
        vehicle,
        delay: Math.round(delaySec),
        timestamp,
        stopTimeUpdate: predictRemainingStops(trip, stopIndex, delaySec, {
          timestamp,
          simSec: this.simSec,
        }),
      });
    }

    return {
      header: {
        gtfsRealtimeVersion: '2.0',
        incrementality: 'FULL_DATASET',
        timestamp,
      },
      vehiclePositions,
      tripUpdates,
      alerts: [...this.alerts],
    };
  }

  /** Total buses defined, including those not currently in service. */
  get fleetSize(): number {
    return this.buses.length;
  }
}
