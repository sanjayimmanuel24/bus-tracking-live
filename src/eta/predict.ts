/**
 * Arrival prediction.
 *
 * THE PHASE 1 MODEL: propagate the vehicle's measured delay forward along its
 * remaining stops, decaying it toward zero because drivers recover time at stops
 * and on easier segments, and widening the uncertainty band with the horizon.
 *
 * This is the same approach most agency GTFS-Realtime producers ship, and it is a
 * real baseline rather than a placeholder -- but it is a baseline. It assumes the
 * delay a bus has now is the best estimate of the delay it will have later, which
 * is wrong in exactly the situations riders care about: approaching a junction
 * that is always jammed at 18:30, or a segment that runs fast on a Sunday.
 *
 * Phase 3 replaces the body of `predictRemainingStops` with a model trained on
 * observed segment travel times, keyed by (segment, hour-of-day, day-of-week).
 * The signature and the returned `StopTimeUpdate[]` do not change, so nothing
 * downstream needs to know which model produced a number -- which is also what
 * makes the two comparable when measuring whether the new model is actually
 * better.
 */

import type { TripIndex } from '../gtfs/feed.ts';
import type { StopTimeUpdate } from '../realtime/types.ts';

/** Fraction of its current delay a bus still carries one stop later. */
export const DELAY_DECAY_PER_STOP = 0.93;

/** Baseline uncertainty at the next stop, and growth per stop beyond it (seconds). */
export const UNCERTAINTY_BASE_SEC = 30;
export const UNCERTAINTY_PER_STOP_SEC = 25;

export interface PredictionContext {
  /** POSIX seconds corresponding to `simSec`. */
  timestamp: number;
  /** Simulated seconds after midnight, matching the GTFS time base. */
  simSec: number;
}

/**
 * Predict arrival at every stop from `fromStopIndex` to the end of the trip.
 *
 * @param trip           the scheduled trip, with stop_times in sequence order
 * @param fromStopIndex  index into `trip.stopTimes` of the next stop to be served
 * @param delaySec       measured delay right now; negative means running early
 */
export function predictRemainingStops(
  trip: TripIndex,
  fromStopIndex: number,
  delaySec: number,
  ctx: PredictionContext,
): StopTimeUpdate[] {
  const updates: StopTimeUpdate[] = [];

  for (let i = fromStopIndex; i < trip.stopTimes.length; i++) {
    const st = trip.stopTimes[i]!;
    const horizon = i - fromStopIndex;
    const predictedDelay = delaySec * DELAY_DECAY_PER_STOP ** horizon;

    // Scheduled times are seconds-after-midnight; shift them onto the same POSIX
    // base the snapshot timestamp uses.
    const scheduledPosix = ctx.timestamp - ctx.simSec + st.arrival_time;

    updates.push({
      stopSequence: st.stop_sequence,
      stopId: st.stop_id,
      arrival: {
        time: Math.round(scheduledPosix + predictedDelay),
        delay: Math.round(predictedDelay),
        uncertainty: Math.round(UNCERTAINTY_BASE_SEC + UNCERTAINTY_PER_STOP_SEC * horizon),
      },
      scheduleRelationship: 'SCHEDULED',
    });
  }

  return updates;
}
