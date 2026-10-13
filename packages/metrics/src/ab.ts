// A/B experiments done carefully. The mistakes that make most product experiments wrong are each closed off here:
//
//  - assignment is a pure function of (experiment, salt, unit), so a user sees one variant for the life of the experiment on every device
//    and every service that asks, and an assignment can be recomputed from the log;
//  - the plan fixes the metric, the minimum detectable effect, the confidence and the sample BEFORE any data is seen, and `analyse`
//    refuses to call a result until that sample is in (no peeking); looking early returns the estimate and says it is not a decision;
//  - the observed split is checked against the planned split (sample ratio mismatch), because a broken assignment makes every later
//    number meaningless, and an SRM is reported before any effect is;
//  - several variants or several metrics are corrected together (Bonferroni), so adding arms does not buy false positives.
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { chiSquareSf, mean, normalCdf, normalQuantile, variance, wilsonInterval } from './stats.js';

export interface Variant {
  name: string;
  /** Share of traffic in basis points; all variants sum to 10,000. */
  weightBps: number;
}

export interface Plan {
  id: string;
  /** A fixed random string for this experiment, so two experiments never split users the same way. */
  salt: string;
  variants: readonly Variant[];
  /** The one metric the decision rests on. */
  metric: { name: string; kind: 'proportion' | 'mean' };
  /** Smallest absolute change worth detecting: a difference of proportions, or of means in the metric's own unit. */
  minimumDetectableEffect: number;
  /** For `mean` metrics: the standard deviation assumed when sizing. For proportions: the baseline rate. */
  baseline: number;
  /** False-positive rate for the whole experiment, shared across comparisons. Default 0.05. */
  alpha: number;
  /** Chance of detecting the minimum effect if it is real. Default 0.8. */
  power: number;
  /** Units needed in EACH variant, computed from the above; `analyse` waits for it. */
  plannedPerVariant: number;
}

export function validateVariants(variants: readonly Variant[]): void {
  if (variants.length < 2) throw new RangeError('an experiment needs at least two variants');
  if (new Set(variants.map((v) => v.name)).size !== variants.length) throw new RangeError('variant names must be distinct');
  if (variants.some((v) => !Number.isInteger(v.weightBps) || v.weightBps <= 0)) throw new RangeError('each weight is a positive whole number of basis points');
  if (variants.reduce((s, v) => s + v.weightBps, 0) !== 10_000) throw new RangeError('weights must sum to 10,000 basis points');
}

/** The variant a unit gets: sha-256 of experiment, salt and unit, read as a number in [0, 10000), walked through the weights. */
export function assign(plan: Pick<Plan, 'id' | 'salt' | 'variants'>, unit: string): string {
  validateVariants(plan.variants);
  const h = sha256(new TextEncoder().encode(`${plan.id}\n${plan.salt}\n${unit}`));
  const bucket = Number((BigInt(h[0]!) << 24n | BigInt(h[1]!) << 16n | BigInt(h[2]!) << 8n | BigInt(h[3]!)) % 10_000n);
  let edge = 0;
  for (const v of plan.variants) {
    edge += v.weightBps;
    if (bucket < edge) return v.name;
  }
  return plan.variants[plan.variants.length - 1]!.name;
}

/** The record of one exposure, with an id that makes logging it twice harmless. */
export function exposure(plan: Pick<Plan, 'id' | 'salt' | 'variants'>, unit: string, at: number): { id: string; experiment: string; unit: string; variant: string; at: number } {
  const variant = assign(plan, unit);
  return { id: bytesToHex(sha256(new TextEncoder().encode(`exposure\n${plan.id}\n${unit}`))), experiment: plan.id, unit, variant, at };
}

export interface SizeInput {
  kind: 'proportion' | 'mean';
  /** Baseline rate (proportion) or standard deviation (mean). */
  baseline: number;
  minimumDetectableEffect: number;
  alpha?: number;
  power?: number;
  /** Comparisons sharing alpha (variants against control, or metrics). Default 1. */
  comparisons?: number;
}

/** Units needed in each of two arms for a two-sided test, by the normal approximation. */
export function sampleSize(i: SizeInput): number {
  const alpha = (i.alpha ?? 0.05) / (i.comparisons ?? 1);
  const power = i.power ?? 0.8;
  if (i.minimumDetectableEffect <= 0) throw new RangeError('the minimum detectable effect must be positive');
  const za = normalQuantile(1 - alpha / 2);
  const zb = normalQuantile(power);
  if (i.kind === 'mean') {
    if (i.baseline <= 0) throw new RangeError('a mean metric needs a positive standard deviation to size from');
    return Math.ceil((2 * (za + zb) ** 2 * i.baseline ** 2) / i.minimumDetectableEffect ** 2);
  }
  const p1 = i.baseline;
  const p2 = i.baseline + i.minimumDetectableEffect;
  if (p1 <= 0 || p2 >= 1 || p1 >= 1) throw new RangeError('baseline and baseline plus effect must lie strictly between 0 and 1');
  const pbar = (p1 + p2) / 2;
  const n = ((za * Math.sqrt(2 * pbar * (1 - pbar)) + zb * Math.sqrt(p1 * (1 - p1) + p2 * (1 - p2))) ** 2) / (p2 - p1) ** 2;
  return Math.ceil(n);
}

export function newPlan(p: Omit<Plan, 'plannedPerVariant' | 'alpha' | 'power'> & { alpha?: number; power?: number }): Plan {
  validateVariants(p.variants);
  const alpha = p.alpha ?? 0.05;
  const power = p.power ?? 0.8;
  const n = sampleSize({ kind: p.metric.kind, baseline: p.baseline, minimumDetectableEffect: p.minimumDetectableEffect, alpha, power, comparisons: p.variants.length - 1 });
  return { ...p, alpha, power, plannedPerVariant: n };
}

/** Sample ratio mismatch: is the observed split what the weights say? A small p-value means the assignment or the logging is broken. */
export function sampleRatio(plan: Pick<Plan, 'variants'>, counts: Readonly<Record<string, number>>): { chi2: number; df: number; pValue: number; mismatch: boolean; observed: Record<string, number>; expected: Record<string, number> } {
  const total = plan.variants.reduce((s, v) => s + (counts[v.name] ?? 0), 0);
  let chi2 = 0;
  const expected: Record<string, number> = {};
  const observed: Record<string, number> = {};
  for (const v of plan.variants) {
    const e = (total * v.weightBps) / 10_000;
    const o = counts[v.name] ?? 0;
    expected[v.name] = e;
    observed[v.name] = o;
    if (e > 0) chi2 += (o - e) ** 2 / e;
  }
  const df = plan.variants.length - 1;
  const pValue = total === 0 ? 1 : chiSquareSf(chi2, df);
  // A mismatch is declared at p < 0.001: this check runs on every experiment, so a looser line would cry wolf.
  return { chi2, df, pValue, mismatch: pValue < 0.001, observed, expected };
}

export interface Observation {
  unit: string;
  variant: string;
  /** 0 or 1 for a proportion metric; any number for a mean metric. */
  value: number;
}

export interface Comparison {
  variant: string;
  against: string;
  n: [number, number];
  rate: [number, number];
  difference: number;
  /** Confidence interval for the difference at the Bonferroni-adjusted level. */
  interval: { lo: number; hi: number };
  pValue: number;
  /** Adjusted for the number of comparisons. */
  significant: boolean;
}

export type Verdict =
  | { status: 'sample-ratio-mismatch'; message: string }
  | { status: 'too-early'; message: string; progress: number }
  | { status: 'no-detectable-difference'; message: string }
  | { status: 'difference'; message: string };

export interface Analysis {
  plan: string;
  verdict: Verdict;
  sampleRatio: ReturnType<typeof sampleRatio>;
  perVariant: Record<string, { n: number; mean: number; wilson?: { lo: number; hi: number } }>;
  comparisons: Comparison[];
  /** True once every variant has reached the planned sample. Before that the estimates below are for orientation, not decisions. */
  planReached: boolean;
}

/** The first variant is the control. Units appearing twice are counted once, with their first observation. */
export function analyse(plan: Plan, observations: readonly Observation[]): Analysis {
  const seen = new Set<string>();
  const byVariant = new Map<string, number[]>(plan.variants.map((v) => [v.name, []]));
  for (const o of observations) {
    if (seen.has(o.unit)) continue;
    seen.add(o.unit);
    const arr = byVariant.get(o.variant);
    if (!arr) throw new RangeError(`observation for unknown variant "${o.variant}"`);
    if (plan.metric.kind === 'proportion' && o.value !== 0 && o.value !== 1) throw new RangeError('a proportion metric takes 0 or 1');
    if (!Number.isFinite(o.value)) throw new RangeError('observations must be finite numbers');
    arr.push(o.value);
  }
  const counts = Object.fromEntries([...byVariant].map(([k, v]) => [k, v.length]));
  const srm = sampleRatio(plan, counts);
  const perVariant: Analysis['perVariant'] = {};
  for (const [name, xs] of byVariant) {
    const n = xs.length;
    perVariant[name] = { n, mean: n ? mean(xs) : NaN, ...(plan.metric.kind === 'proportion' && n ? { wilson: wilsonInterval(xs.reduce((a, b) => a + b, 0), n) } : {}) };
  }
  const control = plan.variants[0]!.name;
  const k = plan.variants.length - 1;
  const alpha = plan.alpha / k;
  const z = normalQuantile(1 - alpha / 2);
  const comparisons: Comparison[] = [];
  for (const v of plan.variants.slice(1)) {
    const a = byVariant.get(control)!;
    const b = byVariant.get(v.name)!;
    if (a.length < 2 || b.length < 2) continue;
    const ma = mean(a);
    const mb = mean(b);
    const se = plan.metric.kind === 'proportion' ? Math.sqrt((ma * (1 - ma)) / a.length + (mb * (1 - mb)) / b.length) : Math.sqrt(variance(a) / a.length + variance(b) / b.length);
    const diff = mb - ma;
    // The test uses the pooled variance for proportions (the null says the rates are equal), the unpooled one for means.
    let seTest = se;
    if (plan.metric.kind === 'proportion') {
      const pooled = (a.reduce((s, x) => s + x, 0) + b.reduce((s, x) => s + x, 0)) / (a.length + b.length);
      seTest = Math.sqrt(pooled * (1 - pooled) * (1 / a.length + 1 / b.length));
    }
    const zStat = seTest === 0 ? 0 : diff / seTest;
    const p = 2 * (1 - normalCdf(Math.abs(zStat)));
    comparisons.push({ variant: v.name, against: control, n: [a.length, b.length], rate: [ma, mb], difference: diff, interval: { lo: diff - z * se, hi: diff + z * se }, pValue: p, significant: p < alpha });
  }
  const planReached = plan.variants.every((v) => (counts[v.name] ?? 0) >= plan.plannedPerVariant);
  let verdict: Verdict;
  if (srm.mismatch) {
    verdict = { status: 'sample-ratio-mismatch', message: `The observed split is not the planned one (chi-square ${srm.chi2.toFixed(2)}, p = ${srm.pValue.toExponential(2)}). Assignment or logging is broken; no effect below can be trusted. Fix this first.` };
  } else if (!planReached) {
    const progress = Math.min(...plan.variants.map((v) => (counts[v.name] ?? 0) / plan.plannedPerVariant));
    verdict = { status: 'too-early', progress, message: `${(progress * 100).toFixed(0)}% of the planned ${plan.plannedPerVariant} units per variant. Deciding on an early look inflates false positives; the estimates are for orientation only.` };
  } else if (comparisons.some((c) => c.significant)) {
    verdict = { status: 'difference', message: `At the planned sample, ${comparisons.filter((c) => c.significant).map((c) => `${c.variant} differs from ${c.against} by ${c.difference.toPrecision(3)} (interval ${c.interval.lo.toPrecision(3)} to ${c.interval.hi.toPrecision(3)}, p = ${c.pValue.toPrecision(2)})`).join('; ')}.` };
  } else {
    verdict = { status: 'no-detectable-difference', message: `At the planned sample no difference reached significance. Differences smaller than ${plan.minimumDetectableEffect} could not have been seen with this sample; their absence is not shown.` };
  }
  return { plan: plan.id, verdict, sampleRatio: srm, perVariant, comparisons, planReached };
}
