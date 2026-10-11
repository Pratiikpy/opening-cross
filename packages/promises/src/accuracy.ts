// The public accuracy report: what was promised, what happened, and how often the claims held.
// Every promise is counted exactly once, in exactly one of HIT, MISS, SCORED, VOID or UNRESOLVED,
// so the hit rate can never be flattered by dropping the awkward ones.
import { type CellCalibration, type GradedSample, calibrateCell, lastPerCrossBucket } from './conformal.js';
import { mean, wilson } from './metrics.js';
import { DEFAULT_POLICY, type Grade, type OpeningCrossPromise, type Policy } from './types.js';

export interface GradedRecord {
  readonly promise: OpeningCrossPromise;
  readonly grade: Grade;
}

export interface BucketReport {
  readonly bucket: number;
  readonly issued: number;
  readonly hit: number;
  readonly miss: number;
  readonly scored: number;
  readonly void: number;
  readonly unresolved: number;
  /** Hits over HIT+MISS among promises that claimed a coverage; null when none did. */
  readonly coverage: number | null;
  readonly coverageWilsonLo: number | null;
  readonly coverageWilsonHi: number | null;
  readonly nominalCoverage: number;
  /** Mean |final − point| over every graded promise, ticks. */
  readonly meanAbsErrorTicks: number | null;
  /** Median of the same. */
  readonly medianAbsErrorTicks: number | null;
  readonly calibration: CellCalibration;
}

export interface AccuracyReport {
  readonly buckets: readonly BucketReport[];
  readonly totals: { readonly issued: number; readonly crosses: number; readonly graded: number; readonly unresolved: number; readonly void: number };
  readonly policy: Policy;
}

const median = (xs: readonly number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
};

/** Training samples: the last graded promise per (cross, bucket) among those with an outcome. */
export function samplesOf(records: readonly GradedRecord[], outcomeAtOf: (promiseId: string) => number | undefined): GradedSample[] {
  const graded = records
    .filter((r) => r.grade.errorTicks !== null)
    .map((r) => ({ r, at: outcomeAtOf(r.promise.id) }))
    .filter((x): x is { r: GradedRecord; at: number } => x.at !== undefined);
  return lastPerCrossBucket(
    graded.map((x) => ({ cross: x.r.promise.subject.cross, bucket: x.r.promise.subject.bucket, issuedAt: x.r.promise.issuedAt, x })),
  ).map(({ x }) => ({
    promiseId: x.r.promise.id,
    cross: x.r.promise.subject.cross,
    bucket: x.r.promise.subject.bucket,
    issuedAt: x.r.promise.issuedAt,
    outcomeAt: x.at,
    errorTicks: x.r.grade.errorTicks as number,
  }));
}

export function report(records: readonly GradedRecord[], samples: readonly GradedSample[], policy: Policy = DEFAULT_POLICY): AccuracyReport {
  const nBuckets = policy.bucketBoundsBps.length + 1;
  const buckets: BucketReport[] = [];
  for (let b = 0; b < nBuckets; b++) {
    const rs = records.filter((r) => r.promise.subject.bucket === b);
    const count = (s: Grade['status']) => rs.filter((r) => r.grade.status === s).length;
    const hit = count('HIT');
    const miss = count('MISS');
    const w = hit + miss > 0 ? wilson(hit, hit + miss) : null;
    const errs = rs.map((r) => r.grade.errorTicks).filter((e): e is number => e !== null);
    buckets.push({
      bucket: b,
      issued: rs.length,
      hit,
      miss,
      scored: count('SCORED'),
      void: count('VOID'),
      unresolved: count('UNRESOLVED'),
      coverage: hit + miss > 0 ? hit / (hit + miss) : null,
      coverageWilsonLo: w?.lo ?? null,
      coverageWilsonHi: w?.hi ?? null,
      nominalCoverage: policy.nominalCoverageBps / 10_000,
      meanAbsErrorTicks: errs.length ? mean(errs) : null,
      medianAbsErrorTicks: median(errs),
      calibration: calibrateCell(b, samples, policy),
    });
  }
  const crosses = new Set(records.map((r) => r.promise.subject.cross)).size;
  return {
    buckets,
    totals: {
      issued: records.length,
      crosses,
      graded: records.filter((r) => r.grade.status === 'HIT' || r.grade.status === 'MISS' || r.grade.status === 'SCORED').length,
      unresolved: records.filter((r) => r.grade.status === 'UNRESOLVED').length,
      void: records.filter((r) => r.grade.status === 'VOID').length,
    },
    policy,
  };
}
