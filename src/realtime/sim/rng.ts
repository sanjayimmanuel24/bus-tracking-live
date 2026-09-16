/**
 * Seeded pseudo-random generator (mulberry32).
 *
 * `Math.random()` cannot be seeded, which makes simulator behaviour impossible to
 * reproduce in a test or a bug report. Every stochastic decision in the simulator
 * draws from one of these, so a given seed always produces the same service day.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic 32-bit hash of a string, for per-entity seeds. */
export function hashString(value: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Draw from an approximately normal distribution (sum of three uniforms). */
export function gaussian(rng: () => number, mean: number, stdDev: number): number {
  const u = (rng() + rng() + rng()) / 3; // mean 0.5, sd ~ 1/6
  return mean + (u - 0.5) * 6 * stdDev;
}
