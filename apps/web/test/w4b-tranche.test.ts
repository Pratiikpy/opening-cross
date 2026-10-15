import { describe, expect, it } from 'vitest';
import { EMPTY_FUTARCHY, EMPTY_PRESALE, LEGACY_TOKEN_PROGRAM, buildFutarchy, buildPresale, depositLine, fullSaleProceeds, futarchyBlocker, quoteForBase } from '../src/lib/tranche';

const A = '2E2aBsgDe255cqMZ7MWkyZx2qMEnMsU3ALuK8NWxKQrr';
const B = '6TLfAfu8dxF9YrTLuE4kgx3dapLNbkpsa8hcz36EhZHx';
const C = '2X63vA1W5qEn53oYaYwcUc3jHLfac9dsiQ1WCN21vyXq';
const D = { base: 6, quote: 6 };

const good = { ...EMPTY_PRESALE, supply: '100', maxCap: '150', minCap: '50', buyerMin: '1', buyerMax: '100', startAt: '2026-12-01T10:00', endAt: '2026-12-04T10:00' };
const secs = (s: string) => Math.floor(new Date(s).getTime() / 1000);

describe('buildPresale', () => {
  it('turns tokens into atoms and days into seconds, and carries the fresh account as `base`', () => {
    const b = buildPresale(good, A, B, C, D);
    expect(b.errors).toEqual({});
    expect(b.body).toEqual({
      cross: A,
      creator: B,
      base: C,
      terms: { maxCap: '150000000', minCap: '50000000', start: secs(good.startAt), end: secs(good.endAt), supply: '100000000', buyerMinDeposit: '1000000', buyerMaxDeposit: '100000000', depositFeeBps: 0, immediatelyReleaseBps: 10_000, lockDuration: '0', vestDuration: '0', unsoldTokenAction: 0 },
    });
  });
  it('names a sale that closes before it opens, a minimum above the maximum and a buyer maximum below the minimum', () => {
    expect(buildPresale({ ...good, endAt: '2026-12-01T09:00' }, A, B, C, D).errors.endAt).toMatch(/close after it opens/);
    expect(buildPresale({ ...good, minCap: '200' }, A, B, C, D).errors.minCap).toMatch(/cannot be above the maximum/);
    expect(buildPresale({ ...good, buyerMin: '50', buyerMax: '10' }, A, B, C, D).errors.buyerMax).toMatch(/at least their smallest/);
  });
  it('refuses a release that would never come: tokens held back with no lock and no vesting', () => {
    expect(buildPresale({ ...good, releaseNowPct: '50' }, A, B, C, D).errors.releaseNowPct).toMatch(/need a lock or a vesting period/);
    expect(buildPresale({ ...good, releaseNowPct: '50', vestDays: '30' }, A, B, C, D).body).not.toBeNull();
  });
  it('maps the unsold action to the program’s numbers and holds amounts to the token’s decimals', () => {
    expect((buildPresale({ ...good, unsold: 'burn' }, A, B, C, D).body?.terms as { unsoldTokenAction: number }).unsoldTokenAction).toBe(1);
    expect(buildPresale({ ...good, supply: '1.0000001' }, A, B, C, D).errors.supply).toMatch(/at most 6 decimals/);
    expect(buildPresale(good, A, B, C, { base: null, quote: 6 }).body).toBeNull();
  });
  it('waits for the fresh account and for a wallet', () => {
    expect(buildPresale(good, A, B, null, D).body).toBeNull();
    expect(buildPresale(good, A, null, C, D).body).toBeNull();
  });
});

describe('fullSaleProceeds', () => {
  it('is what selling every token at the clearing price brings in, in quote atoms', () => {
    expect(fullSaleProceeds(100_000_000n, 1_500_000n, 1_000_000n)).toBe(150_000_000n);
  });
});

describe('quoteForBase', () => {
  it('rounds the quote deposit up, as the adapter requires', () => {
    expect(quoteForBase(100_000_000n, 1_500_000n, 1_000_000n)).toBe(150_000_000n);
    expect(quoteForBase(3n, 1_500_000n, 1_000_000n)).toBe(5n);
  });
});

describe('buildFutarchy', () => {
  it('builds a base amount and nothing the person cannot know: the quote deposit is the API’s to derive', () => {
    expect(buildFutarchy({ ...EMPTY_FUTARCHY, baseAmount: '100' }, A, B, D).body).toEqual({ cross: A, creator: B, baseAmount: '100000000' });
  });
  it('carries MetaDAO settings in the units the route takes, and names each out-of-range one', () => {
    const b = buildFutarchy({ ...EMPTY_FUTARCHY, baseAmount: '1', nonce: '2', passPct: '3', proposalDays: '3', twapDelayMins: '5', teamPassPct: '-1.5' }, A, B, D).body!;
    expect(b).toMatchObject({ nonce: '2', settings: { passThresholdBps: 300, secondsPerProposal: 3 * 86_400, twapStartDelaySeconds: 300, teamSponsoredPassThresholdBps: -150 } });
    expect(buildFutarchy({ ...EMPTY_FUTARCHY, baseAmount: '1', passPct: '120' }, A, B, D).errors.passPct).toBeDefined();
    expect(buildFutarchy({ ...EMPTY_FUTARCHY, baseAmount: '1', teamPassPct: '-101' }, A, B, D).errors.teamPassPct).toBeDefined();
    expect(buildFutarchy({ ...EMPTY_FUTARCHY, baseAmount: '1', proposalDays: '0' }, A, B, D).errors.proposalDays).toBeDefined();
    expect(buildFutarchy({ ...EMPTY_FUTARCHY, baseAmount: '' }, A, B, D).body).toBeNull();
  });
});

describe('futarchyBlocker', () => {
  it('says MetaDAO takes legacy SPL tokens and a six-decimal quote only', () => {
    expect(futarchyBlocker({ program: LEGACY_TOKEN_PROGRAM }, { program: LEGACY_TOKEN_PROGRAM, decimals: 6 })).toBeNull();
    expect(futarchyBlocker({ program: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb' }, { program: LEGACY_TOKEN_PROGRAM, decimals: 6 })).toMatch(/legacy SPL Token mints only/);
    expect(futarchyBlocker({ program: LEGACY_TOKEN_PROGRAM }, { program: LEGACY_TOKEN_PROGRAM, decimals: 9 })).toMatch(/6 decimals; this one has 9/);
    expect(futarchyBlocker(null, null)).toBeNull();
  });
});

describe('depositLine', () => {
  it('says what goes into the DAO’s pool at the clearing price', () => {
    expect(depositLine('100', D, 1_500_000n, 1_000_000n)).toMatch(/^100 base tokens go in with 150 quote tokens/);
    expect(depositLine('', D, 1_500_000n, 1_000_000n)).toBeNull();
    expect(depositLine('100', D, null, null)).toBeNull();
  });
});
