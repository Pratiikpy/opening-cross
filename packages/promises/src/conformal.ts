// Split-conformal bands for the clearing price, fitted online and tested the way they run.
//
// Score = |final tick − point tick| for the last promise a cross issued in a time bucket, one
// sample per cross, so the samples in a cell are independent crosses and not many correlated
// refreshes of one book. The band's half-width is the ⌈(n+1)(1−α)⌉-th smallest score (Vovk et al.
// 2005; Lei et al. 2018), which covers a new exchangeable cross with probability ≥ 1−α. Crosses
// arrive as a time series, so exchangeability is not assumed: it is tested.
//
// The test is prequential (Dawid 1984): every graded sample is scored against the quantile that
// existed when it was issued, built only from samples whose outcome had already been observed. A
// cell is CALIBRATED only when it clears every gate; otherwise it is PROVISIONAL and says why.
// The claim a calibrated band makes is "covers the final price at least `nominal` of the time".
import { hashJcs } from './jcs.js';
import { wilson } from './metrics.js';
import type { Policy } from './types.js';

export interface GradedSample {
  readonly promiseId: string;
  readonly cross: string;
  readonly bucket: number;
  readonly issuedAt: number;
  /** When the outcome became observable (the cross's clear), cluster seconds. */
  readonly outcomeAt: number;
  readonly errorTicks: number;
}

/**
 * The ⌈(n+1)·nominal⌉-th smallest score, or undefined when that rank exceeds n: with too few scores
 * the honest band is unbounded and the caller must say so rather than use the largest score.
 */
export function conformalQuantile(scores: readonly number[], nominalBps: number): number | undefined {
  if (!(Number.isInteger(nominalBps) && nominalBps > 0 && nominalBps < 10_000)) throw new RangeError('nominalBps must lie in (0, 10000)');
  const n = scores.length;
  if (n === 0) return undefined;
  const k = Math.ceil(((n + 1) * nominalBps) / 10_000);
  if (k > n) return undefined;
  return [...scores].sort((a, b) => a - b)[k - 1];
}

/** Smallest n for which a band at this nominal coverage is bounded. */
export const minSamplesFor = (nominalBps: number): number => Math.ceil(10_000 / (10_000 - nominalBps)) - 1;

/** The last promise per (cross, bucket): a rule fixed before any outcome is known, so it cannot be picked after the fact. */
export function lastPerCrossBucket<T extends { cross: string; bucket: number; issuedAt: number }>(rows: readonly T[]): T[] {
  const best = new Map<string, T>();
  for (const r of rows) {
    const k = `${r.cross}:${r.bucket}`;
    const cur = best.get(k);
    if (!cur || r.issuedAt > cur.issuedAt) best.set(k, r);
  }
  return [...best.values()];
}

export interface Prequential {
  /** Samples that had enough earlier history to be tested. */
  readonly n: number;
  readonly hits: number;
  readonly coverage: number;
  readonly wilsonLo: number;
  readonly wilsonHi: number;
}

/** Scores each sample against the quantile available when it was issued. */
export function prequential(samples: readonly GradedSample[], nominalBps: number): Prequential {
  const ordered = [...samples].sort((a, b) => a.issuedAt - b.issuedAt || a.promiseId.localeCompare(b.promiseId));
  let n = 0;
  let hits = 0;
  for (const s of ordered) {
    const known = ordered.filter((o) => o.outcomeAt < s.issuedAt).map((o) => o.errorTicks);
    const q = conformalQuantile(known, nominalBps);
    if (q === undefined) continue;
    n++;
    if (s.errorTicks <= q) hits++;
  }
  const w = wilson(hits, n);
  return { n, hits, coverage: n ? hits / n : 0, wilsonLo: w.lo, wilsonHi: w.hi };
}

export interface CellCalibration {
  readonly cell: string;
  readonly n: number;
  readonly crosses: number;
  readonly quantileTicks: number | null;
  readonly status: 'CALIBRATED' | 'PROVISIONAL';
  readonly reason: string | null;
  readonly samplesHash: string;
  readonly prequential: Prequential;
  readonly distinctDays: number;
}

export const cellKey = (bucket: number): string => `clear-band/bucket-${bucket}`;

const utcDay = (s: number): string => new Date(s * 1000).toISOString().slice(0, 10);

/** Fits a cell from its graded samples and decides, with reasons, whether it may claim a coverage. */
export function calibrateCell(bucket: number, samples: readonly GradedSample[], policy: Policy): CellCalibration {
  const cell = cellKey(bucket);
  const mine = samples.filter((s) => s.bucket === bucket);
  const n = mine.length;
  const crosses = new Set(mine.map((s) => s.cross)).size;
  const quantile = conformalQuantile(
    mine.map((s) => s.errorTicks),
    policy.nominalCoverageBps,
  );
  const days = new Set(mine.map((s) => utcDay(s.outcomeAt))).size;
  const pq = prequential(mine, policy.nominalCoverageBps);
  const samplesHash = hashJcs(
    [...mine]
      .sort((a, b) => a.promiseId.localeCompare(b.promiseId))
      .map((s) => [s.promiseId, s.errorTicks]),
  );

  const nominal = policy.nominalCoverageBps / 10_000;
  const problems: string[] = [];
  if (quantile === undefined) problems.push(`NEED_${minSamplesFor(policy.nominalCoverageBps)}_SAMPLES_FOR_A_BOUNDED_BAND (have ${n})`);
  if (n < policy.minCalibrationSamples) problems.push(`SAMPLES ${n}<${policy.minCalibrationSamples}`);
  if (days < policy.minDistinctDays) problems.push(`DISTINCT_DAYS ${days}<${policy.minDistinctDays}`);
  if (pq.n < policy.minHeldOutSamples) problems.push(`HELD_OUT ${pq.n}<${policy.minHeldOutSamples}`);
  else if (pq.wilsonHi < nominal) {
    // The claim is "covers at least the nominal share", so only under-coverage invalidates it. Scores
    // are whole ticks, which makes the quantile conservative: over-coverage is reported, not punished.
    problems.push(`COVERAGE_BELOW_NOMINAL measured ${(pq.coverage * 100).toFixed(1)}% [${(pq.wilsonLo * 100).toFixed(1)}, ${(pq.wilsonHi * 100).toFixed(1)}] is below nominal ${(nominal * 100).toFixed(0)}%`);
  }
  const ok = problems.length === 0 && quantile !== undefined;
  return {
    cell,
    n,
    crosses,
    quantileTicks: quantile ?? null,
    status: ok ? 'CALIBRATED' : 'PROVISIONAL',
    reason: ok ? null : problems.join('; '),
    samplesHash,
    prequential: pq,
    distinctDays: days,
  };
}
