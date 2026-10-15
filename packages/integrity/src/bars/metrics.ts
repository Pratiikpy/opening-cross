// The statistics the release bars are stated in. Each is a plain function over arrays so the same code is used by the harness, its tests (against values worked out by hand or by an
// independent method) and any later feature that needs the same measure.

/** Area under the ROC curve: the probability that a randomly chosen positive scores higher than a randomly chosen negative, ties counting half. Null when a class is empty. */
export function auc(scores: readonly number[], labels: readonly boolean[]): number | null {
  if (scores.length !== labels.length) throw new RangeError('scores and labels differ in length');
  const pos = labels.filter(Boolean).length;
  const neg = labels.length - pos;
  if (pos === 0 || neg === 0) return null;
  // Rank-sum form with average ranks for ties (Mann-Whitney U).
  const idx = scores.map((s, i) => [s, i] as const).sort((a, b) => a[0] - b[0]);
  const ranks = new Array<number>(scores.length);
  for (let i = 0; i < idx.length; ) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1]![0] === idx[i]![0]) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) ranks[idx[k]![1]] = avg;
    i = j + 1;
  }
  let sumPos = 0;
  labels.forEach((l, i) => {
    if (l) sumPos += ranks[i]!;
  });
  return (sumPos - (pos * (pos + 1)) / 2) / (pos * neg);
}

/** Expected calibration error with equal-width bins: the weighted mean gap between the predicted probability and the observed frequency in each bin. */
export function ece(probabilities: readonly number[], labels: readonly boolean[], bins = 10): number | null {
  if (probabilities.length !== labels.length) throw new RangeError('probabilities and labels differ in length');
  if (probabilities.length === 0) return null;
  let total = 0;
  for (let b = 0; b < bins; b++) {
    const lo = b / bins;
    const hi = (b + 1) / bins;
    const inBin = probabilities.map((p, i) => [p, i] as const).filter(([p]) => (b === bins - 1 ? p >= lo && p <= hi : p >= lo && p < hi));
    if (inBin.length === 0) continue;
    const conf = inBin.reduce((s, [p]) => s + p, 0) / inBin.length;
    const freq = inBin.filter(([, i]) => labels[i]).length / inBin.length;
    total += (inBin.length / probabilities.length) * Math.abs(conf - freq);
  }
  return total;
}

export function precision(predicted: readonly boolean[], actual: readonly boolean[]): number | null {
  const tp = predicted.filter((p, i) => p && actual[i]).length;
  const flagged = predicted.filter(Boolean).length;
  return flagged === 0 ? null : tp / flagged;
}
export function falsePositiveRate(predicted: readonly boolean[], actual: readonly boolean[]): number | null {
  const fp = predicted.filter((p, i) => p && !actual[i]).length;
  const neg = actual.filter((a) => !a).length;
  return neg === 0 ? null : fp / neg;
}

/** Share of observations that fall inside their interval. */
export function coverage(rows: readonly { actual: number; lo: number; hi: number }[]): number | null {
  return rows.length === 0 ? null : rows.filter((r) => r.actual >= r.lo && r.actual <= r.hi).length / rows.length;
}
/** Mean absolute percentage error against the actual value. Rows with a zero actual are refused rather than dropped. */
export function mape(rows: readonly { actual: number; predicted: number }[]): number | null {
  if (rows.length === 0) return null;
  if (rows.some((r) => r.actual === 0)) throw new RangeError('a zero actual has no percentage error; state the bar in absolute terms for it');
  return rows.reduce((s, r) => s + Math.abs(r.predicted - r.actual) / Math.abs(r.actual), 0) / rows.length;
}

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A paired bootstrap of the difference between two scores' AUCs on the same rows: resample rows with replacement, recompute both, take the percentile interval. Draws where a class
 * is empty are skipped and counted.
 */
export function aucDifference(a: readonly number[], b: readonly number[], labels: readonly boolean[], opts: { seed?: number; draws?: number; level?: number } = {}): { aucA: number; aucB: number; delta: number; lo: number; hi: number; draws: number } | null {
  const aa = auc(a, labels);
  const bb = auc(b, labels);
  if (aa === null || bb === null) return null;
  const r = rng(opts.seed ?? 1);
  const want = opts.draws ?? 1000;
  const n = labels.length;
  const ds: number[] = [];
  for (let d = 0; d < want; d++) {
    const pick = Array.from({ length: n }, () => Math.floor(r() * n));
    const l = pick.map((i) => labels[i]!);
    const x = auc(pick.map((i) => a[i]!), l);
    const y = auc(pick.map((i) => b[i]!), l);
    if (x !== null && y !== null) ds.push(x - y);
  }
  ds.sort((p, q) => p - q);
  const tail = (1 - (opts.level ?? 0.95)) / 2;
  if (ds.length < 50) return null;
  return { aucA: aa, aucB: bb, delta: aa - bb, lo: ds[Math.floor(tail * ds.length)]!, hi: ds[Math.min(ds.length - 1, Math.floor((1 - tail) * ds.length))]!, draws: ds.length };
}

/** A percentile bootstrap interval for the AUC of one score. */
export function aucInterval(scores: readonly number[], labels: readonly boolean[], opts: { seed?: number; draws?: number; level?: number } = {}): { auc: number; lo: number; hi: number } | null {
  const point = auc(scores, labels);
  if (point === null) return null;
  const r = rng(opts.seed ?? 1);
  const n = labels.length;
  const ds: number[] = [];
  for (let d = 0; d < (opts.draws ?? 1000); d++) {
    const pick = Array.from({ length: n }, () => Math.floor(r() * n));
    const v = auc(pick.map((i) => scores[i]!), pick.map((i) => labels[i]!));
    if (v !== null) ds.push(v);
  }
  ds.sort((p, q) => p - q);
  if (ds.length < 50) return null;
  const tail = (1 - (opts.level ?? 0.95)) / 2;
  return { auc: point, lo: ds[Math.floor(tail * ds.length)]!, hi: ds[Math.min(ds.length - 1, Math.floor((1 - tail) * ds.length))]! };
}
