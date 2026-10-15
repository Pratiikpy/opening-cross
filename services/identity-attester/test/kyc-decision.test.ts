import { describe, expect, it } from 'vitest';
import { FLAG, Tier } from '@opening-cross/cross-gate-client';
import { DEFAULT_POLICY, chooseCountry, decide, mapTier, validatePolicy, type Policy } from '../src/decision.js';
import { active } from './helpers.js';

const NOW = 1_800_000_000;
const P = (o: Partial<Policy> = {}): Policy => ({ ...DEFAULT_POLICY, ...o });
const codes = (d: ReturnType<typeof decide>) => (d.eligible ? [] : d.reasons.map((r) => r.code));

describe('tier mapping', () => {
  it('maps provider tiers by the policy thresholds, defaulting to retail for any tier 1 or more', () => {
    const p = P();
    expect([0, 1, 26, 99].map((t) => mapTier(t, p))).toEqual([Tier.unspecified, Tier.retail, Tier.retail, Tier.retail]);
  });
  it('maps accredited and qualified only when thresholds are set, at the boundary', () => {
    const p = P({ retailMin: 1, accreditedMin: 20, qualifiedMin: 50 });
    expect([1, 19, 20, 49, 50, 99].map((t) => mapTier(t, p))).toEqual([1, 1, 2, 2, 3, 3]);
  });
  it('rejects inconsistent thresholds', () => {
    expect(() => validatePolicy(P({ retailMin: 5, accreditedMin: 4 }))).toThrow();
    expect(() => validatePolicy(P({ accreditedMin: 10, qualifiedMin: 9 }))).toThrow();
    expect(() => validatePolicy(P({ qualifiedMin: 100 }))).toThrow();
    expect(() => validatePolicy(P({ countryPriority: ['ZZ'] }))).toThrow();
    expect(() => validatePolicy(P({ minRemainingSecs: 0 }))).toThrow();
    expect(() => validatePolicy(P({ maxTtlSecs: -1 }))).toThrow();
    expect(() => validatePolicy(P({ defaultCapAtoms: -1n }))).toThrow();
  });
});

describe('country choice', () => {
  it('one tag is used as is; none is NO_COUNTRY; a non-country is UNKNOWN_COUNTRY', () => {
    expect(chooseCountry(['IN'], [])).toEqual({ ok: true, alpha2: 'IN' });
    expect(chooseCountry([], [])).toEqual({ ok: false, code: 'NO_COUNTRY' });
    expect(chooseCountry(['ZZ'], [])).toEqual({ ok: false, code: 'UNKNOWN_COUNTRY' });
    expect(chooseCountry(['IN', 'ZZ'], ['IN'])).toEqual({ ok: false, code: 'UNKNOWN_COUNTRY' });
  });
  it('several tags: the first priority country the identity carries, otherwise ambiguous', () => {
    expect(chooseCountry(['US', 'IN', 'GB'], ['GB', 'IN'])).toEqual({ ok: true, alpha2: 'GB' });
    expect(chooseCountry(['US', 'IN'], ['SG', 'IN'])).toEqual({ ok: true, alpha2: 'IN' });
    expect(chooseCountry(['US', 'IN'], ['SG'])).toEqual({ ok: false, code: 'AMBIGUOUS_COUNTRY' });
    expect(chooseCountry(['US', 'IN'], [])).toEqual({ ok: false, code: 'AMBIGUOUS_COUNTRY' });
  });
});

describe('decide', () => {
  it('an active pass becomes retail, country numeric, kyc flag, expiry = the provider expiry', () => {
    const d = decide(active({ expiresAt: NOW + 86_400 }), P(), NOW);
    expect(d).toMatchObject({ eligible: true, expiry: NOW + 86_400, countryAlpha2: 'IN', record: { country: 356, tier: Tier.retail, flags: FLAG.kyc, cap: 0n } });
  });
  it('sets the sanctions flag only when the provider says so or the operator asserts it; accredited only from the provider', () => {
    expect(decide(active({ sanctionsScreened: true }), P(), NOW)).toMatchObject({ record: { flags: FLAG.kyc | FLAG.sanctionsClear } });
    expect(decide(active(), P({ assertSanctionsScreened: true }), NOW)).toMatchObject({ record: { flags: FLAG.kyc | FLAG.sanctionsClear } });
    expect(decide(active({ accredited: true }), P(), NOW)).toMatchObject({ record: { flags: FLAG.kyc | FLAG.accredited } });
    // A provider tier that maps to accredited does not by itself set the accredited flag.
    expect(decide(active({ tier: 30 }), P({ accreditedMin: 20 }), NOW)).toMatchObject({ record: { tier: Tier.accredited, flags: FLAG.kyc } });
    expect(decide(active({ kycVerified: false }), P(), NOW)).toMatchObject({ record: { flags: 0 } });
  });
  it('cap: the provider cap wins, else the policy default', () => {
    expect(decide(active({ capAtoms: 5n }), P({ defaultCapAtoms: 9n }), NOW)).toMatchObject({ record: { cap: 5n } });
    expect(decide(active(), P({ defaultCapAtoms: 9n }), NOW)).toMatchObject({ record: { cap: 9n } });
  });
  it('refuses none, unlinked and frozen with their own reasons', () => {
    expect(codes(decide({ state: 'none' }, P(), NOW))).toEqual(['NO_APASS']);
    expect(codes(decide({ state: 'unlinked' }, P(), NOW))).toEqual(['APASS_NOT_LINKED']);
    expect(codes(decide({ ...(active() as object), state: 'frozen' } as never, P(), NOW))).toEqual(['APASS_FROZEN']);
  });
  it('expiry edges: already expired, inside the minimum remaining window, exactly at it, and no expiry', () => {
    expect(codes(decide(active({ expiresAt: NOW - 1 }), P(), NOW))).toEqual(['APASS_EXPIRED']);
    expect(codes(decide(active({ expiresAt: NOW }), P(), NOW))).toEqual(['APASS_EXPIRED']);
    expect(codes(decide(active({ expiresAt: NOW + 59 }), P(), NOW))).toEqual(['APASS_EXPIRED']);
    expect(decide(active({ expiresAt: NOW + 60 }), P(), NOW).eligible).toBe(true);
    expect(decide(active({ expiresAt: 0 }), P(), NOW)).toMatchObject({ eligible: true, expiry: 0 });
  });
  it('maxTtlSecs caps the expiry, including for a pass with none', () => {
    expect(decide(active({ expiresAt: NOW + 10_000 }), P({ maxTtlSecs: 3_600 }), NOW)).toMatchObject({ expiry: NOW + 3_600 });
    expect(decide(active({ expiresAt: NOW + 100 }), P({ maxTtlSecs: 3_600 }), NOW)).toMatchObject({ expiry: NOW + 100 });
    expect(decide(active({ expiresAt: 0 }), P({ maxTtlSecs: 3_600 }), NOW)).toMatchObject({ expiry: NOW + 3_600 });
  });
  it('country problems refuse by default and attest country 0 only when the operator allows it', () => {
    expect(codes(decide(active({ countries: [] }), P(), NOW))).toEqual(['NO_COUNTRY']);
    expect(codes(decide(active({ countries: ['US', 'IN'] }), P(), NOW))).toEqual(['AMBIGUOUS_COUNTRY']);
    expect(decide(active({ countries: [] }), P({ requireCountry: false }), NOW)).toMatchObject({ eligible: true, record: { country: 0 }, countryAlpha2: null });
    expect(decide(active({ countries: ['US', 'IN'] }), P({ countryPriority: ['IN'] }), NOW)).toMatchObject({ eligible: true, record: { country: 356 } });
  });
  it('reports every reason at once', () => {
    expect(codes(decide(active({ expiresAt: NOW - 5, countries: [] }), P(), NOW))).toEqual(['APASS_EXPIRED', 'NO_COUNTRY']);
  });
});
