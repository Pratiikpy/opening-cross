// The only thing the attester knows about a KYC provider. Cleanverse implements it (cleanverse-provider.ts) and so does a
// manual allowlist file (allowlist-provider.ts); nothing else in the service names a provider.

/** What a provider says about one wallet right now, normalised. Contains no personal data. */
export type ProviderRecord =
  | { state: 'none' }
  /** The provider has a record for the wallet but it cannot be tied to a stable customer reference (so no identity id). */
  | { state: 'unlinked' }
  | {
      state: 'frozen' | 'active';
      /** Opaque, stable per person at this provider; the input of the identity id. Never logged or stored. */
      customerRef: string;
      /** The provider's own tier number. */
      tier: number;
      /** ISO 3166-1 alpha-2 country tags, upper case. */
      countries: string[];
      /** Unix seconds; 0 when the provider gives no expiry. */
      expiresAt: number;
      /** The provider holds verified KYC data for this person. */
      kycVerified: boolean;
      /** The provider states it screened this person against sanctions lists. */
      sanctionsScreened: boolean;
      /** The provider states the person is an accredited or professional investor. */
      accredited: boolean;
      /** Per-identity cap in quote atoms per cross (0 = none). */
      capAtoms: bigint;
    };

/** A record that carries a person: what `decide` and the identity derivation read. */
export type VerifiedRecord = Extract<ProviderRecord, { customerRef: string }>;

export interface KycProvider {
  /** Stable name; it is part of the identity-id derivation, so renaming a provider changes every identity it issued. */
  readonly name: string;
  /**
   * Looks the wallet up. Resolves with a record when the provider answered; throws {@link ProviderUnavailableError} when
   * it could not give an answer (outage, refusal, malformed reply). The attester never treats an error as "no record".
   */
  lookup(wallet: string): Promise<ProviderRecord>;
}

export class ProviderUnavailableError extends Error {
  constructor(message: string, readonly cause_?: unknown) {
    super(message);
    this.name = 'ProviderUnavailableError';
  }
}
