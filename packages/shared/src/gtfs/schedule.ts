/**
 * Converting between position-along-a-trip and scheduled time.
 *
 * These two functions are inverses of each other, and they are the bridge between
 * "where is this bus" and "where should this bus be". Everything downstream --
 * delay, schedule adherence, arrival prediction -- is built on them.
 *
 * They live in the shared package because both sides need them: the simulator
 * uses them to drive vehicles, and the server uses them to derive delay from a
 * raw GPS report that carries no schedule information at all.
 */

import type { TripIndex } from './feed.ts';

/**
 * The time the timetable says a bus should reach a given distance along its trip,
 * in seconds after midnight.
 *
 * Interpolates linearly within a segment, between the previous stop's scheduled
 * departure and the next stop's scheduled arrival -- so time spent at a stop is
 * attributed to the stop, not smeared across the following segment.
 */
export function scheduledTimeAtDistance(trip: TripIndex, distanceM: number): number {
  const stopTimes = trip.stopTimes;
  const first = stopTimes[0]!;
  if (distanceM <= first.shape_dist_traveled) return first.departure_time;

  for (let i = 1; i < stopTimes.length; i++) {
    const prev = stopTimes[i - 1]!;
    const cur = stopTimes[i]!;
    if (distanceM <= cur.shape_dist_traveled) {
      const span = cur.shape_dist_traveled - prev.shape_dist_traveled;
      const fraction = span <= 0 ? 1 : (distanceM - prev.shape_dist_traveled) / span;
      return prev.departure_time + fraction * (cur.arrival_time - prev.departure_time);
    }
  }

  return stopTimes[stopTimes.length - 1]!.arrival_time;
}

/**
 * How far along its trip a bus should be at a given time, in metres.
 *
 * Returns the stop's own distance for any moment the bus is scheduled to be
 * dwelling there, so a bus is never expected to be between stops during a dwell.
 */
export function scheduledDistanceAtTime(trip: TripIndex, timeSec: number): number {
  const stopTimes = trip.stopTimes;
  const first = stopTimes[0]!;
  if (timeSec <= first.departure_time) return first.shape_dist_traveled;

  for (let i = 1; i < stopTimes.length; i++) {
    const prev = stopTimes[i - 1]!;
    const cur = stopTimes[i]!;
    if (timeSec <= prev.departure_time) return prev.shape_dist_traveled;
    if (timeSec <= cur.arrival_time) {
      const span = cur.arrival_time - prev.departure_time;
      const fraction = span <= 0 ? 1 : (timeSec - prev.departure_time) / span;
      return prev.shape_dist_traveled + fraction * (cur.shape_dist_traveled - prev.shape_dist_traveled);
    }
  }

  return stopTimes[stopTimes.length - 1]!.shape_dist_traveled;
}

/**
 * Index into `trip.stopTimes` of the next stop a bus at `distanceM` will reach.
 *
 * Clamped to at least 1: a bus sitting at its origin is travelling toward stop 2,
 * not toward the stop it is already standing at.
 */
export function nextStopIndexAtDistance(trip: TripIndex, distanceM: number): number {
  const index = trip.stopTimes.findIndex((st) => st.shape_dist_traveled > distanceM);
  if (index < 0) return trip.stopTimes.length - 1;
  return Math.max(1, index);
}
