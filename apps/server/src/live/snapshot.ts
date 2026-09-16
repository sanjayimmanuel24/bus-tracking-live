/**
 * Builds GTFS-Realtime feed messages from resolved live positions.
 *
 * This is the server-side counterpart of what the Phase 1 simulator did in the
 * browser, and it emits exactly the same entity shapes -- which is why the web
 * client needed no changes to its store or UI when the data moved behind a
 * network boundary.
 */

import {
  formatGtfsTime,
  occupancyStatusFor,
  predictRemainingStops,
  type RealtimeSnapshot,
  type ServiceAlert,
  type TransitFeed,
  type TripUpdate,
  type VehiclePosition,
  type VehicleStopStatus,
} from '@citybus/shared';

import type { ResolvedPosition } from './types.ts';

/** Within this distance of the next stop a vehicle counts as arriving. */
const INCOMING_THRESHOLD_M = 120;
/** Below this speed a vehicle at a stop is treated as stopped rather than crawling. */
const STOPPED_SPEED_MPS = 0.6;

export interface SnapshotOptions {
  /** POSIX seconds this snapshot describes. */
  timestamp: number;
  /** Seconds after midnight, matching the GTFS time base. */
  serviceSec: number;
  alerts: ServiceAlert[];
}

export function buildSnapshot(
  feed: TransitFeed,
  positions: ResolvedPosition[],
  options: SnapshotOptions,
): RealtimeSnapshot {
  const vehiclePositions: VehiclePosition[] = [];
  const tripUpdates: TripUpdate[] = [];

  for (const p of positions) {
    const trip = feed.trips.get(p.tripId);
    if (!trip) continue;

    const descriptor = {
      tripId: p.tripId,
      routeId: p.routeId,
      directionId: p.directionId,
      startTime: formatGtfsTime(trip.startSec),
      scheduleRelationship: 'SCHEDULED' as const,
    };
    const vehicle = { id: p.vehicleId, label: p.label };

    const stopTime = trip.stopTimes[p.stopIndex]!;
    const metresToStop = stopTime.shape_dist_traveled - p.distanceAlongM;

    let currentStatus: VehicleStopStatus;
    if (p.awaitingDeparture) {
      // Standing at the terminus waiting to depart. The client infers this from
      // STOPPED_AT at the first stop with a future predicted arrival, which is
      // the only signal plain GTFS-Realtime offers for a layover.
      currentStatus = 'STOPPED_AT';
    } else if (p.speedMps < STOPPED_SPEED_MPS && metresToStop < INCOMING_THRESHOLD_M) {
      currentStatus = 'STOPPED_AT';
    } else if (metresToStop < INCOMING_THRESHOLD_M) {
      currentStatus = 'INCOMING_AT';
    } else {
      currentStatus = 'IN_TRANSIT_TO';
    }

    vehiclePositions.push({
      trip: descriptor,
      vehicle,
      position: {
        latitude: p.latitude,
        longitude: p.longitude,
        bearing: p.bearing,
        speed: p.speedMps,
      },
      currentStopSequence: p.stopSequence,
      currentStatus,
      timestamp: p.timestamp,
      occupancyStatus: occupancyStatusFor(p.occupancyPercentage / 100),
      occupancyPercentage: p.occupancyPercentage,
    });

    tripUpdates.push({
      trip: descriptor,
      vehicle,
      delay: Math.round(p.delaySec),
      timestamp: p.timestamp,
      stopTimeUpdate: predictRemainingStops(trip, p.stopIndex, p.delaySec, {
        timestamp: options.timestamp,
        simSec: options.serviceSec,
      }),
    });
  }

  return {
    header: {
      gtfsRealtimeVersion: '2.0',
      incrementality: 'FULL_DATASET',
      timestamp: options.timestamp,
    },
    vehiclePositions,
    tripUpdates,
    alerts: options.alerts,
  };
}

/**
 * Derives service alerts from live state rather than inventing them.
 *
 * Two conditions, both of which a rider could verify by looking at the map:
 * a vehicle running significantly late, and a vehicle whose reported position is
 * implausibly far from its route.
 */
export function deriveAlerts(
  feed: TransitFeed,
  positions: ResolvedPosition[],
  timestamp: number,
): ServiceAlert[] {
  const SIGNIFICANT_DELAY_SEC = 420;
  const alerts: ServiceAlert[] = [];
  const seenRoutes = new Set<string>();

  // Worst offender first, so the cap keeps the most severe rather than the first
  // encountered.
  const ranked = [...positions].sort((a, b) => b.delaySec - a.delaySec);

  for (const p of ranked) {
    if (alerts.length >= 4) break;
    // A bus that has not departed yet is not late.
    if (p.awaitingDeparture) continue;

    const route = feed.routes.get(p.routeId);
    const trip = feed.trips.get(p.tripId);
    if (!route || !trip) continue;

    // One alert per route: eight late buses on the same corridor is one problem.
    if (seenRoutes.has(p.routeId)) continue;

    const stopTime = trip.stopTimes[p.stopIndex];
    const stopName = stopTime ? feed.stops.get(stopTime.stop_id)?.stop_name : undefined;

    if (p.offRoute) {
      seenRoutes.add(p.routeId);
      alerts.push({
        id: `offroute:${p.vehicleId}`,
        cause: 'OTHER_CAUSE',
        effect: 'DETOUR',
        severityLevel: 'INFO',
        headerText: `${p.label} on route ${route.route_short_name} is off its published route`,
        informedEntity: [{ routeId: p.routeId, tripId: p.tripId }],
        activePeriodStart: timestamp,
      });
      continue;
    }

    if (p.delaySec > SIGNIFICANT_DELAY_SEC) {
      seenRoutes.add(p.routeId);
      alerts.push({
        id: `delay:${p.vehicleId}`,
        cause: 'TRAFFIC_JAM',
        effect: 'SIGNIFICANT_DELAYS',
        severityLevel: p.delaySec > 900 ? 'SEVERE' : 'WARNING',
        headerText:
          `Route ${route.route_short_name} running ${Math.round(p.delaySec / 60)} min late` +
          (stopName ? ` near ${stopName}` : ''),
        informedEntity: [{ routeId: p.routeId, tripId: p.tripId }],
        activePeriodStart: timestamp,
      });
    }
  }

  return alerts;
}
