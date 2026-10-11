// Small, exact statistics for grading. Integer inputs; floating point only where a probability or an
// interval endpoint is the answer (Wilson), and never inside anything that is signed.

export interface Interval {
  readonly lo: number;
  readonly hi: number;
}

/** Wilson score interval for a binomial proportion (z = 1.96 for a 95% interval). */
export function wilson(hits: number, n: number, z = 1.96): Interval {
  if (n <= 0) return { lo: 0, hi: 1 };
  const p = hits / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { lo: Math.max(0, centre - half), hi: Math.min(1, centre + half) };
}

/**
 * Gneiting–Raftery interval score for the central interval [lo, hi] with miss rate α = 1 − nominal:
 * width + (2/α)·(shortfall below lo or excess above hi). Lower is better; it rewards narrow bands
 * and punishes misses in proportion to how far they miss. `alphaBps` is α in basis points.
 */
export function intervalScore(lo: number, hi: number, outcome: number, alphaBps: number): number {
  if (!(alphaBps > 0 && alphaBps < 10_000)) throw new RangeError('alphaBps must lie in (0, 10000)');
  const below = outcome < lo ? lo - outcome : 0;
  const above = outcome > hi ? outcome - hi : 0;
  return hi - lo + ((2 * 10_000) / alphaBps) * (below + above);
}

/** Pinball (quantile) loss of predicting `q` for the τ-quantile, τ in (0, 1). */
export function pinball(q: number, outcome: number, tau: number): number {
  if (!(tau > 0 && tau < 1)) throw new RangeError('tau must lie in (0, 1)');
  return outcome >= q ? tau * (outcome - q) : (1 - tau) * (q - outcome);
}

export const mean = (xs: readonly number[]): number => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);
