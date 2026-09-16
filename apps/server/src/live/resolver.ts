/**
 * Turns a raw device report into a schedule-aware position.
 *
 * This is where the real architectural shift in Phase 2 lives. In Phase 1 the
 * simulator computed delay and arrival predictions itself, because it was the
 * only thing that existed. Here a vehicle reports only what it can actually
 * observe, and the server derives everything else from the timetable -- exactly
 * as it must when the report comes from a phone bolted to a dashboard.
 */

import {
  projectOntoPath,
  scheduledTimeAtDistance,
  nextStopIndexAtDistance,
  type TransitFeed,
} from '@citybus/shared';

import type { ResolvedPosition, VehicleReport } from './types.ts';

/**
 * A fix further than this from the route shape is treated as off-route.
 *
 * Generous on purpose: GPS in a dense urban corridor is routinely 20-30 m out,
 * and this project's shapes are straight lines between stops rather than
 * road geometry, so genuine positions can sit well off the drawn line. Phase 3's
 * map-matching is what makes a tight threshold meaningful.
 */
const OFF_ROUTE_THRESHOLD_M = 250;

export class PositionResolver {
  constructor(private readonly feed: TransitFeed) {}

  /**
   * @param report      what the vehicle sent
   * @param serviceSec  seconds after midnight for the service day being served
   */
  resolve(report: VehicleReport, serviceSec: number): ResolvedPosition | null {
    const trip = this.feed.trips.get(report.tripId);
    if (!trip) return null;

    const point = { lat: report.latitude, lng: report.longitude };
    const projection = projectOntoPath(trip.shape.path, trip.shape.cumulative, point);

    /*
     * A bus standing at its origin before the scheduled departure has not begun
     * the trip, so it cannot be running early -- it is on layover between
     * workings.
     *
     * Phase 1's simulator knew this directly, because it owned the vehicle's
     * state machine. The server does not: it sees a position at distance zero
     * and a timetable, and nothing else. Without this check the naive
     * calculation reports a bus waiting 22 minutes for its departure as "22
     * minutes early", which drags network-wide adherence far below zero and
     * tells riders something plainly untrue.
     */
    const awaitingDeparture = serviceSec < trip.startSec;

    // Delay is the gap between now and when the timetable expected the bus to be
    // this far along. Everything rider-facing is downstream of this one number.
    const scheduledSec = scheduledTimeAtDistance(trip, projection.distanceAlongM);
    const delaySec = awaitingDeparture ? 0 : serviceSec - scheduledSec;

    // Report a waiting bus against its first stop, not the one it is heading to
    // next: it is standing at the terminus, and that is what riders there see.
    const stopIndex = awaitingDeparture
      ? 0
      : nextStopIndexAtDistance(trip, projection.distanceAlongM);
    const stopTime = trip.stopTimes[stopIndex]!;

    const capacity = report.capacity && report.capacity > 0 ? report.capacity : 50;
    const occupancyPercentage = report.occupancy === undefined
      ? 0
      : Math.max(0, Math.round((report.occupancy / capacity) * 100));

    return {
      vehicleId: report.vehicleId,
      label: report.label ?? report.vehicleId,
      tripId: trip.trip.trip_id,
      routeId: trip.trip.route_id,
      directionId: trip.trip.direction_id,
      latitude: report.latitude,
      longitude: report.longitude,
      bearing: report.bearing,
      speedMps: report.speedMps,
      timestamp: report.timestamp,
      distanceAlongM: projection.distanceAlongM,
      offsetM: projection.offsetM,
      delaySec,
      stopSequence: stopTime.stop_sequence,
      stopIndex,
      occupancyPercentage,
      offRoute: projection.offsetM > OFF_ROUTE_THRESHOLD_M,
      awaitingDeparture,
    };
  }
}
