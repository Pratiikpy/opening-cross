// Shapes returned by the API's trust endpoints: signed promises, the accuracy report and the identity check.

// ---- signed, graded promises (GET /v1/crosses/:address/promise, GET /v1/accuracy)
export type PromiseView = {
  promise: {
    id: string;
    cluster: string;
    issuedAt: number;
    deadline: number;
    subject: { cross: string; bucket: number; grid: { minPrice: string; tick: string; ticks: number; priceScale: string }; ordersCommitted: number };
    claim: {
      pointTick: number;
      loTick: number;
      hiTick: number;
      nominalCoverageBps: number | null;
      status: 'CALIBRATED' | 'PROVISIONAL';
      reason: string | null;
      calibration: { cell: string; n: number; crosses: number; quantileTicks: number | null };
    };
  };
  signer: string;
  signature: string;
  grade: { status: 'HIT' | 'MISS' | 'SCORED' | 'VOID' | 'UNRESOLVED'; reason: string | null; outcomeTick: number | null; errorTicks: number | null } | null;
  anchor: { root: string; count: number; signature: string; blockTime: number | null } | null;
};

export type BucketReport = {
  bucket: number;
  issued: number;
  hit: number;
  miss: number;
  scored: number;
  void: number;
  unresolved: number;
  coverage: number | null;
  coverageWilsonLo: number | null;
  coverageWilsonHi: number | null;
  nominalCoverage: number;
  meanAbsErrorTicks: number | null;
  medianAbsErrorTicks: number | null;
  calibration: { cell: string; n: number; crosses: number; quantileTicks: number | null; status: 'CALIBRATED' | 'PROVISIONAL'; reason: string | null; distinctDays: number };
};

export type AccuracyView = {
  cluster: string;
  signer: string | null;
  buckets: BucketReport[];
  totals: { issued: number; crosses: number; graded: number; unresolved: number; void: number };
  policy: { nominalCoverageBps: number; minCalibrationSamples: number; minDistinctDays: number; minHeldOutSamples: number; bucketBoundsBps: number[] };
};

// ---- is this real? (GET /v1/crosses/:address/authenticity)
export type VerdictClass = 'GENUINE' | 'FAMILY_UNLISTED' | 'IMPERSONATOR' | 'ADDRESS_LOOKALIKE' | 'UNVERIFIED_STOCK_TOKEN' | 'UNRELATED_TOKEN' | 'NOT_A_MINT' | 'UNKNOWN';

export type AuthenticityVerdict = {
  mint: string;
  verdict: VerdictClass;
  reasons: { code: string; message: string }[];
  listing: { mint: string; symbol: string; name: string; family: string } | null;
  impersonates: { mint: string; symbol: string; name: string; family: string }[];
  observed: { name: string | null; symbol: string | null };
};

export type AuthenticityView =
  | { comparable: false; note: string }
  | { comparable: true; base: { mint: string; verdict: AuthenticityVerdict } | null; quote: { mint: string; verdict: AuthenticityVerdict }; registry: { generatedAt: string; snapshotHash: string } };
