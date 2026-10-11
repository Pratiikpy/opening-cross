// Shared types for the authenticity check.

/** Issuer families whose complete mint list the registry holds. */
export type Family = 'xstock' | 'ondo' | 'canonical';

export const FAMILY_LABEL: Readonly<Record<Family, string>> = {
  xstock: 'xStocks (Backed)',
  ondo: 'Ondo Global Markets',
  canonical: 'Issuer-published canonical address',
};

/**
 * The issuer powers whose holder is compared with the family rule. These are the keys an issuer controls; an
 * imitator cannot hold them, so they identify the issuer far better than a name or a logo.
 */
export const FINGERPRINT_KEYS = [
  'MINT_AUTHORITY',
  'FREEZE_AUTHORITY',
  'PAUSE_AUTHORITY',
  'PERMANENT_DELEGATE',
  'SCALED_UI_MULTIPLIER',
  'TRANSFER_HOOK',
] as const;
export type FingerprintKey = (typeof FINGERPRINT_KEYS)[number];

/** Holder address per key; a key is absent when the mint does not carry that power. */
export type Fingerprint = Partial<Record<FingerprintKey, string>>;

/** What the chain says about one mint. Everything the classifier reads is in here, so it stays pure. */
export interface MintObservation {
  readonly mint: string;
  /** False when no account exists at the address. */
  readonly exists: boolean;
  /** Owner program of the account; null when it does not exist. */
  readonly owner: string | null;
  /** True when the account is a token mint owned by the Token or Token-2022 program. */
  readonly isMint: boolean;
  readonly decimals: number | null;
  readonly fingerprint: Fingerprint;
  /** Name and symbol the mint itself declares (Token-2022 metadata, else Metaplex metadata); null when none. */
  readonly name: string | null;
  readonly symbol: string | null;
}

export interface GenuineMint {
  readonly mint: string;
  readonly family: Family;
  readonly symbol: string;
  readonly name: string;
  /** Underlying ticker, upper case ("TSLA"); null for a stablecoin. */
  readonly ticker: string | null;
  readonly isin: string | null;
  /** Source ids that list this address, e.g. "xstocks_api", "ondo_csv". */
  readonly listedBy: readonly string[];
}

/**
 * One family's rule for the issuer powers. `accepted[key]` is every holder the issuer is known to use for that
 * key; `supportedBy[key]` counts the listed mints that carry each holder, so a reader can see how well measured it is.
 */
export interface FamilyRule {
  readonly family: Family;
  readonly accepted: Readonly<Partial<Record<FingerprintKey, readonly string[]>>>;
  /** Mints measured on chain to derive this rule. */
  readonly measured: number;
  /** Where and when the rule was measured. */
  readonly evidence: string;
}

export interface SourceStamp {
  readonly id: string;
  readonly url: string;
  readonly fetchedAt: string;
  /** sha256 of the raw response body. */
  readonly contentHash: string;
  readonly count: number;
}

export interface RegistryData {
  readonly schema: 'opening-cross/authenticity-registry/v1';
  /** sha256 of the canonical mints and rules; changes whenever the registry's judgement could change. */
  readonly snapshotHash: string;
  readonly generatedAt: string;
  readonly sources: readonly SourceStamp[];
  readonly rules: readonly FamilyRule[];
  readonly mints: readonly GenuineMint[];
}

export type VerdictClass =
  | 'GENUINE'
  | 'FAMILY_UNLISTED'
  | 'IMPERSONATOR'
  | 'ADDRESS_LOOKALIKE'
  | 'UNVERIFIED_STOCK_TOKEN'
  | 'UNRELATED_TOKEN'
  | 'NOT_A_MINT'
  | 'UNKNOWN';

export type ReasonCode =
  | 'ISSUER_LISTED'
  | 'AUTHORITIES_MATCH_ISSUER'
  | 'CHAIN_CONTRADICTS_LISTING'
  | 'ISSUER_KEY_CONTROLS_UNLISTED_MINT'
  | 'CLAIMS_ISSUER_SYMBOL'
  | 'CLAIMS_ISSUER_NAME'
  | 'SAME_COMPANY_OTHER_ISSUER'
  | 'DISGUISED_CHARACTERS'
  | 'ADDRESS_ENDS_MATCH_GENUINE'
  | 'NO_ACCOUNT'
  | 'NOT_A_TOKEN_MINT'
  | 'NO_ON_CHAIN_NAME'
  | 'TICKER_COLLISION'
  | 'RESEMBLES_ISSUER_SYMBOL'
  | 'REGISTRY_NOT_COMPLETE';

export interface Reason {
  readonly code: ReasonCode;
  readonly message: string;
}

export interface MintRef {
  readonly mint: string;
  readonly symbol: string;
  readonly name: string;
  readonly family: Family;
}

export interface Verdict {
  readonly mint: string;
  readonly verdict: VerdictClass;
  readonly reasons: readonly Reason[];
  /** The issuer's own listing, when the address is listed. */
  readonly listing: MintRef | null;
  /** Genuine tokens this mint copies, when it is an impersonator or address lookalike. */
  readonly impersonates: readonly MintRef[];
  readonly observed: { readonly name: string | null; readonly symbol: string | null; readonly owner: string | null };
  readonly registry: { readonly snapshotHash: string; readonly generatedAt: string };
}
