// From a provider's record to an attestation, or to the exact reasons there is none. Pure and clock-injected, so the same
// rules serve `attest` and `sync` and every edge is testable.
import { FLAG, Tier, type IdentityRecord } from '@opening-cross/cross-gate-client';
import { UnknownCountryError, alpha2ToNumeric } from '@opening-cross/cleanverse';
import type { ProviderRecord } from './provider.js';

export type ReasonCode =
  | 'NO_APASS'
  | 'APASS_NOT_LINKED'
  | 'APASS_FROZEN'
  | 'APASS_EXPIRED'
  | 'NO_COUNTRY'
  | 'AMBIGUOUS_COUNTRY'
  | 'UNKNOWN_COUNTRY'
  | 'PROVIDER_UNAVAILABLE';

export type Reason = { code: ReasonCode; message: string };

export type Policy = {
  /** Provider tier at or above which the identity is retail (attested tier 1). Below it: tier 0 (unspecified). Default 1. */
  retailMin: number;
  /** Provider tier at which the identity is attested as accredited/professional (2). `null`: the provider tier never says so. */
  accreditedMin: number | null;
  /** Provider tier at which the identity is attested as qualified/institutional (3). `null`: never. */
  qualifiedMin: number | null;
  /** Several country tags: the first of these that the identity carries is used. Empty: several tags are ambiguous. */
  countryPriority: string[];
  /** Refuse (rather than attest country 0) when the identity has no usable single country. Default true. */
  requireCountry: boolean;
  /** Set the sanctions-screened flag for every verified identity: the operator's assertion that the provider screens. Default false. */
  assertSanctionsScreened: boolean;
  /** Attestations never outlive this many seconds from issue, even if the provider pass does; 0 = follow the provider exactly. */
  maxTtlSecs: number;
  /** An attestation is refused if it would have less than this many seconds left (SAS rejects past expiries). */
  minRemainingSecs: number;
  /** Cap written to every attestation when the provider gives none (0 = the gate's default). */
  defaultCapAtoms: bigint;
};

export const DEFAULT_POLICY: Policy = {
  retailMin: 1,
  accreditedMin: null,
  qualifiedMin: null,
  countryPriority: [],
  requireCountry: true,
  assertSanctionsScreened: false,
  maxTtlSecs: 0,
  minRemainingSecs: 60,
  defaultCapAtoms: 0n,
};

export function validatePolicy(p: Policy): Policy {
  const bad = (m: string) => {
    throw new RangeError(`policy: ${m}`);
  };
  const tiers = [p.retailMin, p.accreditedMin, p.qualifiedMin].filter((x): x is number => x !== null);
  if (tiers.some((t) => !Number.isInteger(t) || t < 0 || t > 99)) bad('tier thresholds must be integers 0 to 99');
  if (p.accreditedMin !== null && p.accreditedMin < p.retailMin) bad('accreditedMin must not be below retailMin');
  if (p.qualifiedMin !== null && p.qualifiedMin < (p.accreditedMin ?? p.retailMin)) bad('qualifiedMin must not be below accreditedMin');
  for (const c of p.countryPriority) alpha2ToNumeric(c);
  if (!Number.isInteger(p.maxTtlSecs) || p.maxTtlSecs < 0) bad('maxTtlSecs must be a non-negative integer');
  if (!Number.isInteger(p.minRemainingSecs) || p.minRemainingSecs < 1) bad('minRemainingSecs must be 1 or more');
  if (p.defaultCapAtoms < 0n || p.defaultCapAtoms > 0xffff_ffff_ffff_ffffn) bad('defaultCapAtoms must fit a u64');
  return p;
}

/** Provider tier to attested tier (0 unspecified, 1 retail, 2 accredited/professional, 3 qualified/institutional). */
export function mapTier(providerTier: number, p: Policy): number {
  if (p.qualifiedMin !== null && providerTier >= p.qualifiedMin) return Tier.qualified;
  if (p.accreditedMin !== null && providerTier >= p.accreditedMin) return Tier.accredited;
  if (providerTier >= p.retailMin) return Tier.retail;
  return Tier.unspecified;
}

/**
 * The single country to attest. One tag: that tag. Several: the first of `countryPriority` that the identity carries; with
 * none of those the choice would be arbitrary, so it is ambiguous. No tag: none. A tag that is not an ISO country: unknown.
 */
export function chooseCountry(countries: readonly string[], priority: readonly string[]): { ok: true; alpha2: string } | { ok: false; code: 'NO_COUNTRY' | 'AMBIGUOUS_COUNTRY' | 'UNKNOWN_COUNTRY' } {
  if (countries.length === 0) return { ok: false, code: 'NO_COUNTRY' };
  try {
    for (const c of countries) alpha2ToNumeric(c);
  } catch (e) {
    if (e instanceof UnknownCountryError) return { ok: false, code: 'UNKNOWN_COUNTRY' };
    throw e;
  }
  if (countries.length === 1) return { ok: true, alpha2: countries[0]! };
  const first = priority.find((c) => countries.includes(c));
  return first ? { ok: true, alpha2: first } : { ok: false, code: 'AMBIGUOUS_COUNTRY' };
}

export type Decision =
  | { eligible: true; record: Omit<IdentityRecord, 'identity'>; expiry: number; countryAlpha2: string | null; providerTier: number }
  | { eligible: false; reasons: Reason[] };

const msg: Record<ReasonCode, string> = {
  NO_APASS: 'No verified identity record exists for this wallet. Complete identity verification with the issuer\'s provider using this wallet address, then try again.',
  APASS_NOT_LINKED: 'This wallet\'s record at the provider cannot be tied to a customer registered through this issuer, so no identity can be attested.',
  APASS_FROZEN: 'The provider has frozen this wallet\'s identity record. Contact the provider; nothing can be attested while it is frozen.',
  APASS_EXPIRED: 'This wallet\'s identity record has expired. Renew verification with the provider, then try again.',
  NO_COUNTRY: 'The provider\'s record carries no country, so a country-restricted offering cannot accept it.',
  AMBIGUOUS_COUNTRY: 'The provider\'s record carries several countries and none is the issuer\'s preferred one, so no single country can be attested.',
  UNKNOWN_COUNTRY: 'The provider\'s record carries a country code that is not an ISO 3166-1 country.',
  PROVIDER_UNAVAILABLE: 'The identity provider did not answer. Nothing was attested; try again shortly.',
};
export const reason = (code: ReasonCode): Reason => ({ code, message: msg[code] });

/** Whether `rec` earns an attestation at `now` (Unix seconds), and which one. */
export function decide(rec: ProviderRecord, policy: Policy, now: number): Decision {
  if (rec.state === 'none') return { eligible: false, reasons: [reason('NO_APASS')] };
  if (rec.state === 'unlinked') return { eligible: false, reasons: [reason('APASS_NOT_LINKED')] };
  if (rec.state === 'frozen') return { eligible: false, reasons: [reason('APASS_FROZEN')] };

  const reasons: Reason[] = [];
  let expiry = rec.expiresAt;
  if (expiry !== 0 && expiry - now < policy.minRemainingSecs) reasons.push(reason('APASS_EXPIRED'));
  if (policy.maxTtlSecs > 0) {
    const cap = now + policy.maxTtlSecs;
    expiry = expiry === 0 ? cap : Math.min(expiry, cap);
  }

  const country = chooseCountry(rec.countries, policy.countryPriority);
  let numeric = 0;
  if (country.ok) numeric = alpha2ToNumeric(country.alpha2);
  else if (policy.requireCountry) reasons.push(reason(country.code));

  if (reasons.length > 0) return { eligible: false, reasons };

  const flags = (rec.kycVerified ? FLAG.kyc : 0) | (rec.sanctionsScreened || policy.assertSanctionsScreened ? FLAG.sanctionsClear : 0) | (rec.accredited ? FLAG.accredited : 0);
  return {
    eligible: true,
    record: { country: numeric, tier: mapTier(rec.tier, policy), flags, cap: rec.capAtoms > 0n ? rec.capAtoms : policy.defaultCapAtoms },
    expiry,
    countryAlpha2: country.ok ? country.alpha2 : null,
    providerTier: rec.tier,
  };
}
