// Promise vocabulary. A promise is a claim about a number the product shows, made before the outcome
// is known, with the rule that will grade it fixed at the same time. Prices on a cross live on its
// grid, so claims and errors are counted in grid ticks: integers all the way down.
//
// Grades are honest by construction. A missing outcome is UNRESOLVED with a reason and is never
// filled in; a promise whose premise failed (the cross never printed) is VOID with a reason. Both
// are counted and reported next to the hit rate, never dropped from it.

export const PROMISE_SCHEMA = 'opening-cross/promise/v1';
/** Prefix of the signed message, so a promise signature can never be replayed as anything else. */
export const SIGNING_DOMAIN = 'opening-cross/promise/v1\n';

export const PROMISE_KINDS = ['CLEAR_BAND'] as const;
export type PromiseKind = (typeof PROMISE_KINDS)[number];

export interface GridRef {
  readonly minPrice: string;
  readonly tick: string;
  readonly ticks: number;
  readonly priceScale: string;
}

export type CalibrationStatus = 'CALIBRATED' | 'PROVISIONAL';

/**
 * "The final clearing price of this cross will land in ticks [loTick, hiTick]." The point is the
 * price the cross would clear at if it closed now. A PROVISIONAL band claims no coverage: it is a
 * range of the point's own neighbours shown for context, and it is graded like any other promise
 * so that the data to calibrate it accumulates in public. Its lo and hi equal its point.
 */
export interface ClearBandClaim {
  readonly pointTick: number;
  readonly loTick: number;
  readonly hiTick: number;
  /** The share of crosses the band is claimed to cover, at least. Null for a PROVISIONAL band: no coverage is claimed. */
  readonly nominalCoverageBps: number | null;
  readonly status: CalibrationStatus;
  /** Why the band is provisional; null when calibrated. */
  readonly reason: string | null;
  readonly calibration: {
    /** Calibration cell, e.g. `clear-band/bucket-2`. */
    readonly cell: string;
    /** Graded samples in the cell, one per cross (the last promise of the bucket). */
    readonly n: number;
    /** Distinct crosses behind them; equal to `n` by construction. */
    readonly crosses: number;
    /** Conformal quantile of |final − point| in ticks, or null when too few samples. */
    readonly quantileTicks: number | null;
    /** sha-256 of the canonical list of (promise id, score) pairs the quantile was fitted on. */
    readonly samplesHash: string;
  };
}

export interface PromiseBody {
  readonly schema: typeof PROMISE_SCHEMA;
  readonly kind: PromiseKind;
  /** `devnet`, `mainnet-beta` or `localnet`: promises on different clusters never mix. */
  readonly cluster: string;
  /** The cross_core program whose accounts are the truth. */
  readonly program: string;
  readonly subject: {
    readonly cross: string;
    /** Time bucket of the call window: 0 early, 1 middle, 2 late. */
    readonly bucket: number;
    readonly grid: GridRef;
    readonly ordersCommitted: number;
  };
  /** Cluster time at issuance, unix seconds. */
  readonly issuedAt: number;
  /** After this time with no outcome a promise is reported UNRESOLVED, not graded. */
  readonly deadline: number;
  readonly claim: ClearBandClaim;
  /** What counts as the truth, fixed here: the price field of the cross account. */
  readonly outcomeSpec: { readonly source: 'cross_core.Cross.clearing.price'; readonly rule: 'HIT_IN_TICKS' };
  /** sha-256 of the canonical book the point was computed from. */
  readonly inputsHash: string;
  readonly modelId: string;
  /** sha-256 of the canonical policy (nominal coverage, gates, buckets) in force. */
  readonly policyHash: string;
}

export interface OpeningCrossPromise extends PromiseBody {
  /** sha-256 of the canonical body. */
  readonly id: string;
}

export interface SignedPromise {
  readonly promise: OpeningCrossPromise;
  /** The signer's Solana address (an ed25519 public key). */
  readonly signer: string;
  /** 64-byte ed25519 signature over `SIGNING_DOMAIN + id`, lowercase hex. */
  readonly signature: string;
}

/**
 * HIT and MISS grade a band that claimed a coverage. SCORED is a provisional point whose error is
 * recorded but which claimed nothing to hit or miss. VOID: the premise failed. UNRESOLVED: no outcome yet.
 */
export type GradeStatus = 'HIT' | 'MISS' | 'SCORED' | 'VOID' | 'UNRESOLVED';

export interface Grade {
  readonly promiseId: string;
  readonly status: GradeStatus;
  /** Why a promise is VOID or UNRESOLVED; null for HIT and MISS. */
  readonly reason: string | null;
  /** Final clearing price as a grid tick, when the cross printed. */
  readonly outcomeTick: number | null;
  /** |outcome − point| in ticks, when graded. */
  readonly errorTicks: number | null;
  /** Interval score of the band in ticks (lower is better), when a coverage was claimed. */
  readonly intervalScoreTicks: number | null;
  readonly gradedAt: number;
}

export interface Policy {
  /** Nominal coverage of a calibrated band, basis points. */
  readonly nominalCoverageBps: number;
  /** Fewest graded samples (one per cross) before a cell may call itself calibrated. */
  readonly minCalibrationSamples: number;
  /** Fewest distinct UTC days those samples span. */
  readonly minDistinctDays: number;
  /** Fewest prequential held-out samples whose coverage is tested. */
  readonly minHeldOutSamples: number;
  /** Bucket boundaries as fractions of the call window, in basis points (ascending, exclusive of 0 and 10000). */
  readonly bucketBoundsBps: readonly number[];
}

export const DEFAULT_POLICY: Policy = {
  nominalCoverageBps: 9_000,
  minCalibrationSamples: 30,
  minDistinctDays: 2,
  minHeldOutSamples: 20,
  bucketBoundsBps: [3_333, 6_667],
};
