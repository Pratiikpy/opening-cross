// Order statistics and the distribution-free bound the LTV rule rests on. Returns are integers in "units" where
// 1 unit = 0.0001 percent = 1/1,000,000 of the price, so a -12.5% gap is -125000. Nothing here uses a distribution assumption.

export const UNITS = 1_000_000;

/** Sorted ascending copy. */
export const sorted = (xs: readonly number[]): number[] => [...xs].sort((a, b) => a - b);

/** Nearest-rank empirical quantile of an ascending array: the smallest value with at least p of the sample at or below it. */
export function quantile(asc: readonly number[], p: number): number {
  if (asc.length === 0) throw new Error('quantile of an empty sample');
  if (!(p >= 0 && p <= 1)) throw new Error('p must be in [0, 1]');
  return asc[Math.min(asc.length - 1, Math.max(0, Math.ceil(p * asc.length) - 1))]!;
}

/** log of the binomial coefficient, via a sum of logs (exact enough for n in the thousands). */
function logChoose(n: number, k: number): number {
  let s = 0;
  const m = Math.min(k, n - k);
  for (let i = 1; i <= m; i++) s += Math.log((n - m + i) / i);
  return s;
}

/** P(X <= k) for X ~ Binomial(n, p). */
export function binomialCdf(n: number, p: number, k: number): number {
  if (k < 0) return 0;
  if (k >= n) return 1;
  if (p <= 0) return 1;
  if (p >= 1) return 0;
  let total = 0;
  for (let i = 0; i <= k; i++) total += Math.exp(logChoose(n, i) + i * Math.log(p) + (n - i) * Math.log1p(-p));
  return Math.min(1, total);
}

/**
 * Distribution-free one-sided tolerance bound. Let X(j) be the j-th smallest of n independent returns (X(1) the worst). The share of
 * future returns at or below X(j) has a Beta(j, n - j + 1) distribution whatever the return distribution is, so
 *
 *     P( share of future returns <= X(j) is at most alpha ) = P( Binomial(n, alpha) >= j ).
 *
 * `certifiedRank` returns the LARGEST j for which that probability is at least `confidence`: X(j) is then, with that confidence, a
 * level that no more than a fraction alpha of future returns will fall to or below. The largest such j is the least conservative
 * certified choice; a smaller j is safer. It returns null when even the minimum (j = 1) cannot reach the confidence, that is when
 * n < ln(1 - confidence) / ln(1 - alpha): the sample is too small to certify alpha at all.
 */
export function certifiedRank(n: number, alpha: number, confidence: number): number | null {
  if (n < 1) return null;
  let best: number | null = null;
  for (let j = 1; j <= n; j++) {
    const atLeastJ = 1 - binomialCdf(n, alpha, j - 1);
    if (atLeastJ >= confidence) best = j;
    else break;
  }
  return best;
}

/** The smallest sample that can certify `alpha` at `confidence` with the minimum observation. */
export function minimumSample(alpha: number, confidence: number): number {
  return Math.ceil(Math.log(1 - confidence) / Math.log(1 - alpha));
}

export function mean(xs: readonly number[]): number {
  return xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
}
export function stdev(xs: readonly number[]): number {
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, xs.length - 1));
}
export function median(asc: readonly number[]): number {
  return quantile(asc, 0.5);
}
