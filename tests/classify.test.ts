import { describe, expect, it } from 'vitest';

import { classifyCluster, type ClusterEvidence } from '../apps/server/src/analysis/classify.ts';

/**
 * The discriminator that matters: a bus stop is served on nearly every pass,
 * whereas a traffic signal only catches the traffic that arrives on red. Both
 * produce recurring clusters of stationary buses, so position alone cannot tell
 * them apart -- the evidence has to be behavioural.
 */
const evidence = (over: Partial<ClusterEvidence> = {}): ClusterEvidence => ({
  dwellEvents: 20,
  vehicles: 6,
  passes: 22,
  medianDwellSec: 25,
  p90DwellSec: 48,
  matchedStopOffsetM: null,
  ...over,
});

describe('classifyCluster', () => {
  it('calls a location served on nearly every pass a stop', () => {
    const result = classifyCluster(evidence({ dwellEvents: 21, passes: 22 }));
    expect(result.classification).toBe('stop');
    expect(result.confidence).toBeGreaterThan(0);
  });

  it('calls a location skipped by half the traffic a likely signal', () => {
    // 10 dwells from 24 passes: two thirds of buses drove straight through.
    const result = classifyCluster(evidence({
      dwellEvents: 10, passes: 30, medianDwellSec: 6, p90DwellSec: 9,
    }));
    expect(result.classification).toBe('likely-signal');
    expect(result.reasons.join(' ')).toMatch(/signal-like/);
  });

  it('treats corroboration by a known stop as strong evidence', () => {
    const result = classifyCluster(evidence({ matchedStopOffsetM: 12 }));
    expect(result.classification).toBe('stop');
    expect(result.reasons.join(' ')).toMatch(/known stop/);
  });

  it('refuses to decide on thin evidence, however clean it looks', () => {
    // A perfect hit rate from two dwells by one vehicle is not a finding.
    const result = classifyCluster(evidence({ dwellEvents: 2, vehicles: 1, passes: 2 }));
    expect(result.classification).toBe('uncertain');
    expect(result.reasons.join(' ')).toMatch(/thin evidence/);
  });

  it('penalises halts too brief for anyone to have boarded', () => {
    const brief = classifyCluster(evidence({ medianDwellSec: 4, p90DwellSec: 6 }));
    const normal = classifyCluster(evidence());
    expect(brief.reasons.join(' ')).toMatch(/too brief to board/);
    expect(brief.classification).not.toBe('stop');
    expect(normal.classification).toBe('stop');
  });

  it('reports high confidence for a clear signal, not just a clear stop', () => {
    // Confidence is certainty about the answer, not a score for "is a stop".
    const result = classifyCluster(evidence({
      dwellEvents: 8, passes: 40, medianDwellSec: 5, p90DwellSec: 7,
    }));
    expect(result.classification).toBe('likely-signal');
    expect(result.confidence).toBeGreaterThan(0.3);
  });

  it('does not divide by zero when no pass count is available', () => {
    const result = classifyCluster(evidence({ passes: 0 }));
    expect(Number.isFinite(result.confidence)).toBe(true);
    expect(result.reasons.join(' ')).toMatch(/hit rate unknown/);
  });
});
