// Vocabulary of the premium monitor. Prices are integers: micro-USD per share (E6), premiums in basis points x100.

/** Market session of the underlying, from the issuer's own trading clock. */
export const SESSIONS = ['regular', 'pre', 'post', 'overnight', 'closed'] as const;
export type Session = (typeof SESSIONS)[number];

export type Leg = 'buy' | 'sell';

export const REFERENCE_KINDS = ['hip3_oracle', 'hip3_mark'] as const;
export type ReferenceKind = (typeof REFERENCE_KINDS)[number];

export interface Reference {
  readonly kind: ReferenceKind;
  /** Underlying ticker, upper case. */
  readonly ticker: string;
  /** USD per share, micro-USD. */
  readonly priceE6: bigint;
  /** When the value was read from the source, unix seconds. The sources do not publish their own update time. */
  readonly readAt: number;
}

export interface JupiterQuote {
  readonly inputMint: string;
  readonly outputMint: string;
  readonly inAmount: bigint;
  readonly outAmount: bigint;
  /** Jupiter's own estimate of price impact in basis points x100 (0.0057% = 57). */
  readonly priceImpactBpsX100: bigint;
  readonly routeLabels: readonly string[];
  readonly contextSlot: number;
}

export interface Asset {
  readonly ticker: string;
  readonly symbol: string;
  readonly mint: string;
  readonly decimals: number;
}

export const OBSERVATION_STATUSES = ['ok', 'no_route', 'quote_failed', 'no_reference', 'no_multiplier', 'zero_shares', 'issuer_halted'] as const;
export type ObservationStatus = (typeof OBSERVATION_STATUSES)[number];

export interface Observation {
  readonly at: number;
  readonly ticker: string;
  readonly symbol: string;
  readonly mint: string;
  readonly leg: Leg;
  readonly sizeUsd: number;
  readonly session: Session;
  readonly referenceKind: ReferenceKind;
  readonly status: ObservationStatus;
  readonly referenceE6: bigint | null;
  /** Executable price per share the quote implies, micro-USD. */
  readonly perShareE6: bigint | null;
  /** (perShare - reference) / reference, basis points x100, signed. Positive is above the reference. */
  readonly premiumBpsX100: bigint | null;
  readonly priceImpactBpsX100: bigint | null;
  readonly route: string | null;
  /** Display multiplier of the mint (Scaled UI Amount) used to turn token atoms into shares, as a decimal string. */
  readonly multiplier: string | null;
}
