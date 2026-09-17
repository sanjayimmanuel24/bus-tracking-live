/**
 * Deciding whether a cluster of bus dwells is a stop or something else.
 *
 * Buses stand still for several reasons, and only one of them is a bus stop:
 * traffic signals, level crossings, junction queues and congestion all produce
 * clusters of low-speed positions that recur in the same place day after day.
 * Position data alone cannot separate them; the discriminating evidence is
 * *behavioural*.
 *
 * The strongest signal is the hit rate: what fraction of the buses that passed
 * through a location actually stopped there. A bus stop is served on essentially
 * every pass. A traffic signal catches roughly half the traffic, because the
 * light is green for the rest.
 *
 * THRESHOLDS BELOW ARE UNCALIBRATED STARTING POINTS. They are reasoned from how
 * signals and stops behave, not fitted to observed data, because no surveyed
 * ground truth exists for this network yet. Once a route has been surveyed,
 * these should be tuned against it -- and the output of this module should be
 * treated as a list of candidates for human review, never as an automatic
 * overwrite of the stop database.
 */

export type Classification = 'stop' | 'likely-signal' | 'uncertain';

export interface ClusterEvidence {
  /** Distinct dwell events in the cluster. */
  dwellEvents: number;
  /** Distinct vehicles that contributed a dwell. */
  vehicles: number;
  /** Distinct (vehicle, trip) pairs that passed within the sampling radius. */
  passes: number;
  medianDwellSec: number;
  p90DwellSec: number;
  /** Distance to the nearest known GTFS stop, or null if none is near. */
  matchedStopOffsetM: number | null;
}

export interface ClassificationResult {
  classification: Classification;
  /** 0-1. Interpretable as "how much the evidence supports the label". */
  confidence: number;
  /** Human-readable evidence, so a reviewer can disagree with the reasoning. */
  reasons: string[];
}

/** A stop is served on nearly every pass. */
const HIGH_HIT_RATE = 0.85;
/** Below this, a location is being skipped often enough to look like a signal. */
const LOW_HIT_RATE = 0.6;

/**
 * Below this, a halt is too brief to have served passengers.
 *
 * Note this interacts with the sampling interval: a dwell's measured duration is
 * the span between its first and last low-speed fix, which under-reports the true
 * dwell by up to one sampling period. At 4-second sampling a genuine 10-second
 * dwell measures as 8.
 */
const MIN_PLAUSIBLE_DWELL_SEC = 8;

/**
 * Boarding time varies with how many passengers are waiting, so a stop's dwell
 * distribution has a long right tail. A signal's is bounded by the cycle length.
 */
const BOARDING_TAIL_RATIO = 1.8;

/** A cluster centred this close to a known stop is corroborating it. */
const KNOWN_STOP_MATCH_M = 40;

export function classifyCluster(evidence: ClusterEvidence): ClassificationResult {
  const reasons: string[] = [];
  const hitRate = evidence.passes > 0 ? evidence.dwellEvents / evidence.passes : 0;

  // Score accumulates evidence for "this is a stop"; 0.5 is no information.
  let score = 0.5;

  // --- Corroboration by an existing stop -----------------------------------
  // This is the strongest evidence available, but it is not independent: it says
  // the cluster agrees with data we already had, which is exactly what makes it
  // useful for *correcting* a position rather than discovering a new stop.
  if (evidence.matchedStopOffsetM !== null && evidence.matchedStopOffsetM <= KNOWN_STOP_MATCH_M) {
    score += 0.3;
    reasons.push(`within ${Math.round(evidence.matchedStopOffsetM)} m of a known stop`);
  }

  // --- Hit rate ------------------------------------------------------------
  if (evidence.passes === 0) {
    reasons.push('no pass count available; hit rate unknown');
  } else if (hitRate >= HIGH_HIT_RATE) {
    score += 0.25;
    reasons.push(`served on ${Math.round(hitRate * 100)}% of passes`);
  } else if (hitRate <= LOW_HIT_RATE) {
    score -= 0.3;
    reasons.push(`skipped on ${Math.round((1 - hitRate) * 100)}% of passes, which is signal-like`);
  } else {
    reasons.push(`served on ${Math.round(hitRate * 100)}% of passes, inconclusive`);
  }

  // --- Dwell duration ------------------------------------------------------
  if (evidence.medianDwellSec < MIN_PLAUSIBLE_DWELL_SEC) {
    score -= 0.2;
    reasons.push(`median halt of ${evidence.medianDwellSec.toFixed(0)} s is too brief to board`);
  }

  // --- Dwell shape ---------------------------------------------------------
  // Only meaningful with enough events to have a distribution at all.
  if (evidence.dwellEvents >= 8 && evidence.medianDwellSec > 0) {
    const tailRatio = evidence.p90DwellSec / evidence.medianDwellSec;
    if (tailRatio >= BOARDING_TAIL_RATIO) {
      score += 0.1;
      reasons.push(`dwell varies with a long tail (p90/median ${tailRatio.toFixed(1)}), typical of boarding`);
    }
  }

  // --- Sample size ---------------------------------------------------------
  // Few observations is not evidence against a stop, but it is a reason not to
  // be confident either way.
  const thinEvidence = evidence.dwellEvents < 5 || evidence.vehicles < 2;
  if (thinEvidence) {
    reasons.push(`thin evidence: ${evidence.dwellEvents} dwells from ${evidence.vehicles} vehicle(s)`);
  }

  const clamped = Math.max(0, Math.min(1, score));

  let classification: Classification;
  if (thinEvidence) {
    classification = 'uncertain';
  } else if (clamped >= 0.7) {
    classification = 'stop';
  } else if (clamped <= 0.35) {
    classification = 'likely-signal';
  } else {
    classification = 'uncertain';
  }

  return {
    classification,
    // Confidence is distance from the undecided midpoint, not the raw score:
    // a strong "this is a signal" is a confident answer too.
    confidence: Math.round(Math.abs(clamped - 0.5) * 2 * 100) / 100,
    reasons,
  };
}
