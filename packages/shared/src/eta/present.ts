/**
 * Turning predictions into something a rider can read.
 *
 * Kept separate from the model because presentation rules are a product decision,
 * not a modelling one: "Due" rather than "0 min", minute precision rather than
 * seconds (false precision erodes trust), and an explicit confidence band so the
 * number is not read as a promise.
 */

import type { StopTimeUpdate } from '../realtime/types.ts';

export type Confidence = 'high' | 'medium' | 'low';

export interface PresentedEta {
  /** Short display string: "Due", "3 min", "21:04". */
  label: string;
  /** Seconds from now until predicted arrival. Negative if the prediction has passed. */
  secondsAway: number;
  confidence: Confidence;
  /** Plus-or-minus band in seconds. */
  uncertaintySec: number;
}

/** Predictions further out than this are shown as a clock time, not a countdown. */
const COUNTDOWN_HORIZON_SEC = 45 * 60;

export function presentEta(update: StopTimeUpdate, nowPosix: number): PresentedEta {
  const secondsAway = update.arrival.time - nowPosix;
  const uncertaintySec = update.arrival.uncertainty;

  let label: string;
  if (secondsAway <= 30) {
    label = 'Due';
  } else if (secondsAway < 60) {
    label = '1 min';
  } else if (secondsAway <= COUNTDOWN_HORIZON_SEC) {
    label = `${Math.round(secondsAway / 60)} min`;
  } else {
    label = new Date(update.arrival.time * 1000)
      .toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false });
  }

  return { label, secondsAway, confidence: confidenceFor(uncertaintySec), uncertaintySec };
}

function confidenceFor(uncertaintySec: number): Confidence {
  if (uncertaintySec <= 60) return 'high';
  if (uncertaintySec <= 120) return 'medium';
  return 'low';
}

/** Human-readable schedule adherence, e.g. "4 min late", "On time", "2 min early". */
export function describeDelay(delaySec: number, onTimeThresholdSec = 180, earlyThresholdSec = -90): string {
  if (delaySec > onTimeThresholdSec) return `${Math.round(delaySec / 60)} min late`;
  if (delaySec < earlyThresholdSec) return `${Math.round(-delaySec / 60)} min early`;
  return 'On time';
}

export type Adherence = 'on-time' | 'late' | 'early';

export function adherenceFor(delaySec: number, onTimeThresholdSec = 180, earlyThresholdSec = -90): Adherence {
  if (delaySec > onTimeThresholdSec) return 'late';
  if (delaySec < earlyThresholdSec) return 'early';
  return 'on-time';
}
