/**
 * Application state.
 *
 * Joins the static schedule (`TransitFeed`) with the realtime stream
 * (`RealtimeSnapshot`) into view models the UI can render directly. The UI layer
 * does no GTFS lookups and no arithmetic of its own -- it only paints what this
 * module computes, which keeps the rendering code small enough to be diff-based
 * rather than rebuild-everything.
 */

import { metresPerSecToKph, projectOntoPath, type LatLng } from '@citybus/shared';
import type { TransitFeed } from '@citybus/shared';
import { adherenceFor, presentEta, type Adherence, type PresentedEta } from '@citybus/shared';
import type {
  OccupancyStatus, RealtimeSnapshot, ServiceAlert, VehicleStopStatus,
} from '@citybus/shared';

export interface UpcomingStop {
  stopId: string;
  stopName: string;
  eta: PresentedEta;
}

/** Everything the UI needs about one bus, pre-computed. */
export interface VehicleView {
  vehicleId: string;
  label: string;
  routeId: string;
  routeShortName: string;
  routeLongName: string;
  routeColor: string;
  tripId: string;
  headsign: string;
  originName: string;
  position: LatLng;
  bearing: number;
  speedKph: number;
  delaySec: number;
  adherence: Adherence;
  occupancyPercentage: number;
  occupancyStatus: OccupancyStatus;
  currentStatus: VehicleStopStatus;
  /**
   * Waiting at a terminus for a scheduled departure it has not yet made.
   * Inferred from the feed alone -- stopped at stop_sequence 1 with that stop's
   * predicted arrival still in the future -- because GTFS-Realtime has no
   * explicit "laying over" state.
   */
  awaitingDeparture: boolean;
  nextStopName: string;
  nextStopEta: PresentedEta | null;
  /** Continuous 0-100 journey completion, from projecting position onto the shape. */
  progressPct: number;
  /** Perpendicular distance from the route shape, in metres. A data-quality signal. */
  offRouteM: number;
  upcoming: UpcomingStop[];
}

export interface RouteView {
  routeId: string;
  shortName: string;
  longName: string;
  color: string;
  stopNames: string[];
  stopCount: number;
  activeVehicles: number;
}

export interface NetworkKpis {
  active: number;
  onTime: number;
  late: number;
  early: number;
  avgSpeedKph: number;
  /** Share of in-service vehicles running within the on-time band, 0-100. */
  onTimePerformance: number;
}

export interface Snapshot {
  vehicles: VehicleView[];
  kpis: NetworkKpis;
  alerts: ServiceAlert[];
  /** POSIX seconds of the underlying feed message. */
  timestamp: number;
}

export class Store {
  private readonly feed: TransitFeed;
  private readonly listeners = new Set<(s: Snapshot) => void>();

  /** Route IDs currently visible. Filtering is a view concern, not a feed concern. */
  public visibleRoutes: Set<string>;
  public selectedVehicleId: string | null = null;
  public fleetQuery = '';

  private latest: Snapshot = {
    vehicles: [],
    kpis: { active: 0, onTime: 0, late: 0, early: 0, avgSpeedKph: 0, onTimePerformance: 100 },
    alerts: [],
    timestamp: 0,
  };

  constructor(feed: TransitFeed) {
    this.feed = feed;
    this.visibleRoutes = new Set(feed.routeOrder);
  }

  get snapshot(): Snapshot {
    return this.latest;
  }

  subscribe(listener: (s: Snapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Static route metadata for the sidebar, computed once plus a live vehicle count. */
  routeViews(): RouteView[] {
    const counts = new Map<string, number>();
    for (const v of this.latest.vehicles) {
      counts.set(v.routeId, (counts.get(v.routeId) ?? 0) + 1);
    }

    return this.feed.routeOrder.map((routeId) => {
      const route = this.feed.routes.get(routeId)!;
      // Use the outbound shape's trip to list stops in travel order.
      const sampleTripId = this.feed.blocksByRoute.get(routeId)
        ?.flatMap((b) => this.feed.blocks.get(b) ?? [])
        .find((t) => this.feed.trips.get(t)?.trip.direction_id === 0);
      const sample = sampleTripId ? this.feed.trips.get(sampleTripId) : undefined;
      const stopNames = sample
        ? sample.stopTimes.map((st) => this.feed.stops.get(st.stop_id)?.stop_name ?? st.stop_id)
        : [];

      return {
        routeId,
        shortName: route.route_short_name,
        longName: route.route_long_name,
        color: route.route_color,
        stopNames,
        stopCount: stopNames.length,
        activeVehicles: counts.get(routeId) ?? 0,
      };
    });
  }

  /** Vehicles passing the current route filter and search query. */
  filteredVehicles(): VehicleView[] {
    const q = this.fleetQuery.trim().toLowerCase();
    return this.latest.vehicles.filter((v) => {
      if (!this.visibleRoutes.has(v.routeId)) return false;
      if (!q) return true;
      return (
        v.label.toLowerCase().includes(q) ||
        v.routeShortName.toLowerCase().includes(q) ||
        v.headsign.toLowerCase().includes(q) ||
        v.nextStopName.toLowerCase().includes(q) ||
        v.originName.toLowerCase().includes(q)
      );
    });
  }

  findVehicle(vehicleId: string): VehicleView | undefined {
    return this.latest.vehicles.find((v) => v.vehicleId === vehicleId);
  }

  /** Recompute view models from a new feed message and notify subscribers. */
  ingest(snapshot: RealtimeSnapshot): void {
    const now = snapshot.header.timestamp;
    const updatesByVehicle = new Map(snapshot.tripUpdates.map((u) => [u.vehicle.id, u]));
    const vehicles: VehicleView[] = [];

    for (const vp of snapshot.vehiclePositions) {
      const trip = this.feed.trips.get(vp.trip.tripId);
      const route = this.feed.routes.get(vp.trip.routeId);
      if (!trip || !route) continue;

      const update = updatesByVehicle.get(vp.vehicle.id);
      const delaySec = update?.delay ?? 0;

      const position = { lat: vp.position.latitude, lng: vp.position.longitude };
      const projection = projectOntoPath(trip.shape.path, trip.shape.cumulative, position);
      const progressPct = trip.shape.totalMetres > 0
        ? (projection.distanceAlongM / trip.shape.totalMetres) * 100
        : 0;

      const upcoming: UpcomingStop[] = (update?.stopTimeUpdate ?? []).map((stu) => ({
        stopId: stu.stopId,
        stopName: this.feed.stops.get(stu.stopId)?.stop_name ?? stu.stopId,
        eta: presentEta(stu, now),
      }));

      const firstStop = trip.stopTimes[0]!;

      const awaitingDeparture =
        vp.currentStatus === 'STOPPED_AT' &&
        vp.currentStopSequence === firstStop.stop_sequence &&
        (upcoming[0]?.eta.secondsAway ?? 0) > 0;

      vehicles.push({
        vehicleId: vp.vehicle.id,
        label: vp.vehicle.label,
        routeId: route.route_id,
        routeShortName: route.route_short_name,
        routeLongName: route.route_long_name,
        routeColor: route.route_color,
        tripId: trip.trip.trip_id,
        headsign: trip.trip.trip_headsign,
        originName: this.feed.stops.get(firstStop.stop_id)?.stop_name ?? firstStop.stop_id,
        position,
        bearing: vp.position.bearing,
        speedKph: metresPerSecToKph(vp.position.speed),
        delaySec,
        adherence: adherenceFor(delaySec),
        occupancyPercentage: vp.occupancyPercentage,
        occupancyStatus: vp.occupancyStatus,
        currentStatus: vp.currentStatus,
        awaitingDeparture,
        nextStopName: upcoming[0]?.stopName ?? trip.trip.trip_headsign,
        nextStopEta: upcoming[0]?.eta ?? null,
        progressPct: Math.max(0, Math.min(100, progressPct)),
        offRouteM: projection.offsetM,
        upcoming,
      });
    }

    // Stable ordering so diff-based list rendering never has to reorder the DOM.
    vehicles.sort((a, b) => a.label.localeCompare(b.label));

    this.latest = {
      vehicles,
      kpis: computeKpis(vehicles, this.visibleRoutes),
      alerts: snapshot.alerts,
      timestamp: now,
    };

    // A selected bus ends its trip and leaves the feed; drop the stale selection.
    if (this.selectedVehicleId && !this.findVehicle(this.selectedVehicleId)) {
      this.selectedVehicleId = null;
    }

    for (const listener of this.listeners) listener(this.latest);
  }

  /** Re-notify subscribers after a view-only change (filter, selection, search). */
  notify(): void {
    this.latest = { ...this.latest, kpis: computeKpis(this.latest.vehicles, this.visibleRoutes) };
    for (const listener of this.listeners) listener(this.latest);
  }
}

function computeKpis(vehicles: VehicleView[], visibleRoutes: Set<string>): NetworkKpis {
  const visible = vehicles.filter((v) => visibleRoutes.has(v.routeId));
  const active = visible.length;
  if (active === 0) {
    return { active: 0, onTime: 0, late: 0, early: 0, avgSpeedKph: 0, onTimePerformance: 100 };
  }

  let onTime = 0;
  let late = 0;
  let early = 0;
  let speedSum = 0;
  // Average only moving vehicles: including buses dwelling at a stop drags the
  // figure toward zero and makes it read as a fault rather than a normal part of
  // the duty cycle.
  let moving = 0;
  // Buses still waiting at a terminus are on duty but have not started a trip, so
  // they cannot be on time or late. Counting them as on time would quietly
  // inflate the headline figure.
  let running = 0;

  for (const v of visible) {
    if (!v.awaitingDeparture) {
      running++;
      if (v.adherence === 'on-time') onTime++;
      else if (v.adherence === 'late') late++;
      else early++;
    }

    if (v.speedKph > 1) { speedSum += v.speedKph; moving++; }
  }

  return {
    active,
    onTime,
    late,
    early,
    avgSpeedKph: moving > 0 ? Math.round(speedSum / moving) : 0,
    onTimePerformance: running > 0 ? Math.round((onTime / running) * 100) : 100,
  };
}
