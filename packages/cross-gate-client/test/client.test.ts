import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AccountRole, type Address, generateKeyPair, getAddressFromPublicKey } from '@solana/kit';
import {
  ALLOCATION_DISCRIMINATOR,
  CONFIG_BASE_SIZE,
  COUNTRIES,
  EEA,
  FLAG,
  IDENTITY_BINDING_DISCRIMINATOR,
  IDENTITY_DATA_LENGTH,
  PRESET_IDS,
  RULES_EXT_MAGIC,
  RULES_EXT_SIZE,
  Tier,
  VOLUME_DISCRIMINATOR,
  buildRules,
  conforms,
  countryList,
  countryName,
  getRulesDecoder,
  requirementLines,
  setupNotes,
  detectHookListVersion,
  countryAlpha2,
  countryListed,
  countryNumeric,
  countrySet,
  getRulesEncoder,
  packIdentityData,
  preset,
  readRules,
  resaleLock,
  resolveHookAccounts,
  unpackIdentityData,
} from '../src/index.js';

const id = (n: number) => new Uint8Array(32).fill(n);
const fresh = async () => getAddressFromPublicKey((await generateKeyPair()).publicKey);
const WSOL = 'So11111111111111111111111111111111111111112' as Address;

describe('oc-identity data', () => {
  it('round-trips and is exactly 44 bytes, little-endian', () => {
    const r = { identity: id(7), country: 356, tier: Tier.accredited, flags: FLAG.kyc | FLAG.sanctionsClear, cap: 123_456_789n };
    const bytes = packIdentityData(r);
    expect(bytes.length).toBe(IDENTITY_DATA_LENGTH);
    expect(Array.from(bytes.slice(32, 36))).toEqual([356 & 255, 356 >> 8, Tier.accredited, 12]);
    expect(unpackIdentityData(bytes)).toEqual(r);
  });

  it('matches a literal vector, so a change to the layout cannot pass by changing both sides', () => {
    // identity 0x01 x32, country 356 (0x0164), tier 2, flags KYC|SANCTIONS_CLEAR (12), cap 5_000_000 (0x4C4B40).
    const hex = '01'.repeat(32) + '6401' + '02' + '0c' + '404b4c0000000000';
    const bytes = packIdentityData({ identity: id(1), country: 356, tier: 2, flags: 12, cap: 5_000_000n });
    expect(Buffer.from(bytes).toString('hex')).toBe(hex);
  });

  it('refuses anything the program would refuse', () => {
    const ok = { identity: id(1), country: 1, tier: 1, flags: 0, cap: 0n };
    expect(() => packIdentityData({ ...ok, identity: new Uint8Array(31) })).toThrow();
    expect(() => packIdentityData({ ...ok, country: 1000 })).toThrow();
    expect(() => packIdentityData({ ...ok, tier: 4 })).toThrow();
    expect(() => packIdentityData({ ...ok, flags: 16 })).toThrow();
    expect(() => packIdentityData({ ...ok, cap: 1n << 64n })).toThrow();
    expect(() => unpackIdentityData(new Uint8Array(43))).toThrow();
    expect(() => unpackIdentityData(new Uint8Array(45))).toThrow();
  });
});

describe('account discriminators', () => {
  it('are the first eight bytes of sha256("account:<Name>")', () => {
    const disc = (name: string) => Uint8Array.from(createHash('sha256').update(`account:${name}`).digest().subarray(0, 8));
    expect(IDENTITY_BINDING_DISCRIMINATOR).toEqual(disc('IdentityBinding'));
    expect(VOLUME_DISCRIMINATOR).toEqual(disc('Volume'));
    expect(ALLOCATION_DISCRIMINATOR).toEqual(disc('Allocation'));
  });
});

describe('countries and the country set', () => {
  it('lists 250 unique codes that round-trip and fit the 1,000-bit set', () => {
    expect(COUNTRIES.length).toBe(250);
    expect(new Set(COUNTRIES.map((c) => c.numeric)).size).toBe(250);
    expect(new Set(COUNTRIES.map((c) => c.alpha2)).size).toBe(250);
    for (const c of COUNTRIES) {
      expect(c.numeric).toBeLessThan(1000);
      expect(countryNumeric(c.alpha2.toLowerCase())).toBe(c.numeric);
      expect(countryAlpha2(c.numeric)).toBe(c.alpha2);
    }
    expect(countryNumeric('IN')).toBe(356);
    expect(countryNumeric('US')).toBe(840);
    expect(countryNumeric('GB')).toBe(826);
  });

  it('builds a 125-byte set and rejects non-countries', () => {
    const set = countrySet(['IN', 'GB', 999]);
    expect(set.length).toBe(125);
    expect(countryListed(set, 356) && countryListed(set, 826) && countryListed(set, 999)).toBe(true);
    expect(countryListed(set, 840)).toBe(false);
    expect(() => countrySet(['ZZ'])).toThrow();
    expect(() => countrySet([1000])).toThrow();
  });
});

describe('rules', () => {
  it('reads rules back from the extension region of a config account', () => {
    const rules = buildRules({ countryPolicy: 'allow', countries: ['IN'], maxPasses: 7, lockPolicy: { durationSecs: 60n }, blackouts: [{ start: 1n, end: 2n }] });
    const body = getRulesEncoder().encode(rules);
    const data = new Uint8Array(CONFIG_BASE_SIZE + RULES_EXT_SIZE);
    expect(readRules(data)).toBeNull();
    data[CONFIG_BASE_SIZE] = RULES_EXT_MAGIC;
    data.set(body, CONFIG_BASE_SIZE + 1);
    const back = readRules(data)!;
    expect(back.maxPasses).toBe(7);
    expect(back.lockPolicy).toEqual({ __option: 'Some', value: { durationSecs: 60n } });
    expect(countryListed(back.countries, 356)).toBe(true);
  });

  it('the extension region is exactly the size of the largest rules, which have every option set', () => {
    const full = getRulesEncoder().encode(
      buildRules({
        identity: { credential: WSOL, schema: WSOL },
        accreditation: { credential: WSOL, schema: WSOL },
        allowlistRoot: id(1),
        lockPolicy: { durationSecs: 1n },
        lockDelegate: WSOL,
        affiliateLimit: { windowSecs: 1n, maxAmount: 1n },
      }),
    );
    expect(full.length).toBe(RULES_EXT_SIZE - 1);
  });

  it('refuses more than four blackout windows', () => {
    expect(() => buildRules({ blackouts: Array.from({ length: 5 }, (_, i) => ({ start: BigInt(i + 1), end: BigInt(i + 2) })) })).toThrow();
  });

  it('conforms() agrees with the program on country, tier and flags', () => {
    const allow = buildRules({ countryPolicy: 'allow', countries: ['IN', 'GB'], minTier: 2, requiredFlags: FLAG.kyc | FLAG.sanctionsClear });
    const ok = { country: countryNumeric('IN')!, tier: 2, flags: FLAG.kyc | FLAG.sanctionsClear };
    expect(conforms(allow, ok)).toEqual({ ok: true });
    expect(conforms(allow, { ...ok, country: countryNumeric('US')! })).toEqual({ ok: false, code: 'COUNTRY_NOT_ALLOWED' });
    expect(conforms(allow, { ...ok, country: 0 })).toEqual({ ok: false, code: 'COUNTRY_UNKNOWN' });
    expect(conforms(allow, { ...ok, tier: 1 })).toEqual({ ok: false, code: 'TIER_TOO_LOW' });
    expect(conforms(allow, { ...ok, flags: FLAG.kyc })).toEqual({ ok: false, code: 'MISSING_FLAGS' });
    const deny = buildRules({ countryPolicy: 'deny', countries: ['KP'] });
    expect(conforms(deny, { country: countryNumeric('KP')!, tier: 0, flags: 0 })).toEqual({ ok: false, code: 'COUNTRY_NOT_ALLOWED' });
    expect(conforms(deny, { country: countryNumeric('FR')!, tier: 0, flags: 0 })).toEqual({ ok: true });
  });
});

describe('transfer-hook accounts', () => {
  it('follow the order of the mint extra-account-meta list, and only the volume account is writable', async () => {
    const [mint, a, b] = [await fresh(), await fresh(), await fresh()];
    const v2 = await resolveHookAccounts({ mint, sourceOwner: a, destinationOwner: b, listVersion: 2 });
    // config, receiver pass, sender lock, sender terms, sender volume, receiver terms, then the program and the list.
    expect(v2.length).toBe(8);
    expect(v2.map((x) => x.role)).toEqual([
      AccountRole.READONLY,
      AccountRole.READONLY,
      AccountRole.READONLY,
      AccountRole.READONLY,
      AccountRole.WRITABLE,
      AccountRole.READONLY,
      AccountRole.READONLY,
      AccountRole.READONLY,
    ]);
    const v1 = await resolveHookAccounts({ mint, sourceOwner: a, destinationOwner: b, listVersion: 1 });
    expect(v1.length).toBe(5);
    expect(v1.slice(0, 3)).toEqual(v2.slice(0, 3));
    expect(v1.slice(3)).toEqual(v2.slice(6));
    // The receiver's terms are the receiver's, not the sender's.
    const swapped = await resolveHookAccounts({ mint, sourceOwner: b, destinationOwner: a, listVersion: 2 });
    expect(swapped[3]).toEqual(v2[5]);
    expect(swapped[5]).toEqual(v2[3]);
  });
});

describe('hook list version', () => {
  // 8-byte discriminator, u32 byte length, u32 count, then 35 bytes per entry.
  const list = (count: number) => {
    const d = new Uint8Array(16 + 35 * count);
    new DataView(d.buffer).setUint32(8, 4 + 35 * count, true);
    new DataView(d.buffer).setUint32(12, count, true);
    return d;
  };
  it('is read from the entry count', () => {
    expect(detectHookListVersion(list(3))).toBe(1);
    expect(detectHookListVersion(list(6))).toBe(2);
  });
  it('refuses a layout it does not know', () => {
    expect(() => detectHookListVersion(list(4))).toThrow();
    expect(() => detectHookListVersion(new Uint8Array(8))).toThrow();
  });
});

describe('resale locks', () => {
  it('start at now + duration for the received amount', () => {
    expect(resaleLock({ now: 100n, durationSecs: 50n, received: 7n })).toEqual({ amount: 7n, unlockTs: 150n });
  });
  it('stack on a lock still running and never end earlier than it', () => {
    expect(resaleLock({ now: 100n, durationSecs: 50n, received: 7n, current: { amount: 3n, unlockTs: 400n } })).toEqual({ amount: 10n, unlockTs: 400n });
    expect(resaleLock({ now: 100n, durationSecs: 500n, received: 7n, current: { amount: 3n, unlockTs: 400n } })).toEqual({ amount: 10n, unlockTs: 600n });
  });
  it('ignore a lock that has ended', () => {
    expect(resaleLock({ now: 400n, durationSecs: 50n, received: 7n, current: { amount: 3n, unlockTs: 400n } })).toEqual({ amount: 7n, unlockTs: 450n });
  });
  it('refuse a non-positive duration', () => {
    expect(() => resaleLock({ now: 1n, durationSecs: 0n, received: 1n })).toThrow();
  });
});

describe('presets', () => {
  it('every preset builds valid rules and always demands counsel', () => {
    for (const presetId of PRESET_IDS) {
      const p = preset(presetId, { restrictedCountries: ['KP'] });
      expect(p.requiresCounsel).toBe(true);
      expect(() => buildRules(p.rules)).not.toThrow();
    }
    expect(EEA.length).toBe(30);
    const mica = preset('mica', { restrictedCountries: ['DE'] });
    expect(mica.rules.countries).not.toContain('DE');
    expect(preset('reg-s', { restrictedCountries: [] }).rules.countries).toContain('US');
    expect(preset('reg-d-506c', { restrictedCountries: [] }).rules.minTier).toBe(Tier.accredited);
    expect(preset('reg-cf', { restrictedCountries: [], quoteUnit: 1_000_000n }).rules.defaultCap).toBe(2_500_000_000n);
  });
});

describe('plain-English rules', () => {
  const rules = buildRules({
    countryPolicy: 'allow',
    countries: ['IN', 'GB'],
    minTier: Tier.accredited,
    requiredFlags: FLAG.kyc | FLAG.accredited,
    maxPasses: 100,
    passes: 12,
    defaultCap: 2_500_000_000n,
    lockPolicy: { durationSecs: 365n * 86_400n },
    blackouts: [{ start: 1_800_000_000n, end: 1_801_000_000n }],
    affiliateLimit: { windowSecs: 90n * 86_400n, maxAmount: 1_500_000n },
  });
  const decoded = getRulesDecoder().decode(getRulesEncoder().encode(rules));

  it('says every switched-on rule once, and nothing for the ones that are off', () => {
    const lines = requirementLines(decoded, { quoteDecimals: 6, quoteSymbol: 'USDC', tokenDecimals: 6, tokenSymbol: 'ACME' });
    expect(lines).toEqual([
      'Holders in India, United Kingdom only.',
      'Accredited investor or above.',
      'Requires identity (KYC) verification.',
      'Requires accredited-investor status.',
      'One wallet per verified person.',
      'At most 100 holders (12 so far).',
      'Each person may commit up to 2,500 USDC per cross unless the attester sets a different limit.',
      'Tokens bought in the offering cannot be resold for 365 days.',
      'Insiders cannot transfer tokens from 2027-01-15 until 2027-01-26.',
      'Insiders may sell at most 1.5 ACME in any 90 days.',
    ]);
    expect(requirementLines(getRulesDecoder().decode(getRulesEncoder().encode(buildRules({ oneIdentityOnePass: false }))))).toEqual([]);
  });

  it('lists a deny list by name and collapses a long one', () => {
    const deny = getRulesDecoder().decode(getRulesEncoder().encode(buildRules({ countryPolicy: 'deny', countries: ['KP', 'IR'] })));
    expect(requirementLines(deny)[0]).toBe(`No holders in ${countryName(countryNumeric('IR')!)}, ${countryName(countryNumeric('KP')!)}.`);
    expect(countryList(Array.from({ length: 30 }, (_, i) => i + 4))).toBe('30 countries');
  });

  it('says when only the authority can issue passes and when the gate is open', () => {
    const bare = getRulesDecoder().decode(getRulesEncoder().encode(buildRules({})));
    expect(setupNotes(bare, 'Open').join(' ')).toMatch(/only the gate authority can issue passes/);
    expect(setupNotes(bare, 'Open').join(' ')).toMatch(/anyone may receive the token by transfer/);
    expect(setupNotes(bare, 'Allowlist')).toHaveLength(1);
    expect(setupNotes(decoded, 'Allowlist').join(' ')).toMatch(/can be avoided by moving tokens/);
  });
});
