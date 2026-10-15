import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BOUNTY_INVARIANT_NAMES, EMPTY_BOUNTY, buildBounty, covered, expiryText, hashReport, isEvidence, poolOf } from '../src/lib/bounty';
import { type CreateForm, EMPTY_CREATE, EMPTY_LIMITS, blockerText, buildCreate, buildFund, buildLimits, buildOrder, newSalt } from '../src/lib/mandates';

const A = '2E2aBsgDe255cqMZ7MWkyZx2qMEnMsU3ALuK8NWxKQrr';
const B = '6TLfAfu8dxF9YrTLuE4kgx3dapLNbkpsa8hcz36EhZHx';
const C = '2X63vA1W5qEn53oYaYwcUc3jHLfac9dsiQ1WCN21vyXq';
const NOW = 1_800_000_000;

describe('bounty invariants', () => {
  it('are the eleven of the program, in its order, word for word', () => {
    const src = readFileSync(new URL('../../../packages/sdk/src/programs/bounty.ts', import.meta.url), 'utf8');
    const block = /BOUNTY_INVARIANT_NAMES: readonly string\[\] = \[([\s\S]*?)\];/.exec(src)![1]!;
    const names = [...block.matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(BOUNTY_INVARIANT_NAMES).toEqual(names);
    expect(names).toHaveLength(11);
  });
});

describe('buildBounty', () => {
  const rewards = (n: Record<number, string>) => EMPTY_BOUNTY.rewards.map((_, i) => n[i] ?? '');
  const good = { ...EMPTY_BOUNTY, rewardMint: A, arbiter: B, days: '45', rewards: rewards({ 0: '25', 5: '40' }) };
  it('builds eleven rewards in atoms, leaving a blank one at zero, and an expiry from now', () => {
    const b = buildBounty(good, C, 6, NOW);
    expect(b.body).toEqual({ sponsor: C, rewardMint: A, arbiter: B, expiresAt: NOW + 45 * 86_400, rewards: ['25000000', '0', '0', '0', '0', '40000000', '0', '0', '0', '0', '0'] });
  });
  it('holds a commitment of at least 30 days and a reward for at least one invariant', () => {
    expect(buildBounty({ ...good, days: '29' }, C, 6, NOW).errors.days).toMatch(/at least 30 days/);
    expect(buildBounty({ ...good, days: '30' }, C, 6, NOW).body).not.toBeNull();
    const none = buildBounty({ ...good, rewards: rewards({}) }, C, 6, NOW);
    expect(none.body).toBeNull();
    expect(none.errors.none).toMatch(/at least one invariant/);
  });
  it('names a reward finer than the token and an address that is not one', () => {
    expect(buildBounty({ ...good, rewards: rewards({ 2: '1.0000001' }) }, C, 6, NOW).errors.rewards[2]).toMatch(/at most 6 decimals/);
    expect(buildBounty({ ...good, arbiter: 'x' }, C, 6, NOW).errors.arbiter).toBeDefined();
    expect(buildBounty(good, null, 6, NOW).body).toBeNull();
  });
});

describe('bounty words and helpers', () => {
  it('counts the pool the index can know, never below zero', () => {
    expect(poolOf({ funded: '500', paid: '100', awarded: '50', withdrawn: '0' })).toBe(350n);
    expect(poolOf({ funded: '10', paid: '100', awarded: '0', withdrawn: '0' })).toBe(0n);
    expect(covered(['10', '0', '5'])).toBe(2);
  });
  it('says whether a bounty commits its pool or expired', () => {
    expect(expiryText(NOW + 3 * 86_400, NOW)).toMatch(/commits its pool until .* UTC \(3 days left\)/);
    expect(expiryText(NOW - 10, NOW)).toMatch(/^expired on/);
  });
  it('hashes a report to the 64 hex characters an award carries', async () => {
    const h = await hashReport('Reentrancy in the claim path: details attached.');
    expect(isEvidence(h)).toBe(true);
    expect(h).toHaveLength(64);
    expect(await hashReport('a')).toBe('ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb');
    expect(isEvidence('abc')).toBe(false);
  });
});

const limitsOk = { ...EMPTY_LIMITS, maxPerOrder: '50', totalCap: '200', sharePct: '10', days: '14', allow: [{ kind: 'creator' as const, key: A }] };
describe('mandates: buildLimits', () => {
  it('builds the limits as the routes take them', () => {
    expect(buildLimits(limitsOk, 6, NOW).limits).toEqual({ maxPerOrder: '50000000', totalCap: '200000000', maxShareBps: 1_000, expiresAt: NOW + 14 * 86_400, allow: [{ kind: 'creator', key: A }] });
  });
  it('holds every bound the program has', () => {
    expect(buildLimits({ ...limitsOk, maxPerOrder: '0' }, 6, NOW).errors.maxPerOrder).toBeDefined();
    expect(buildLimits({ ...limitsOk, totalCap: '20' }, 6, NOW).errors.totalCap).toMatch(/at least the most one order/);
    expect(buildLimits({ ...limitsOk, sharePct: '25' }, 6, NOW).limits?.maxShareBps).toBe(2_500);
    expect(buildLimits({ ...limitsOk, sharePct: '25.01' }, 6, NOW).errors.sharePct).toMatch(/at most 25 percent/);
    expect(buildLimits({ ...limitsOk, sharePct: '0' }, 6, NOW).errors.sharePct).toBeDefined();
    expect(buildLimits({ ...limitsOk, days: '0' }, 6, NOW).errors.days).toBeDefined();
    expect(buildLimits({ ...limitsOk, allow: [] }, 6, NOW).errors.allow).toMatch(/at least one/);
    expect(buildLimits({ ...limitsOk, allow: Array.from({ length: 9 }, () => ({ kind: 'cross' as const, key: A })) }, 6, NOW).errors.allow).toMatch(/at most eight/);
    expect(buildLimits({ ...limitsOk, allow: [{ kind: 'cross', key: 'nope' }] }, 6, NOW).errors.entries[0]).toMatch(/not a Solana address/);
    expect(buildLimits(limitsOk, null, NOW).limits).toBeNull();
  });
});

describe('mandates: buildCreate and buildFund', () => {
  const form: CreateForm = { ...EMPTY_CREATE, agent: B, quoteMint: C, fundAmount: '100', fundSol: '0.05', limits: limitsOk };
  it('builds a mandate with its first funding in tokens and lamports', () => {
    expect(buildCreate(form, A, 6, NOW).body).toMatchObject({ owner: A, agent: B, quoteMint: C, fund: { amount: '100000000', lamports: '50000000' } });
  });
  it('omits the funding when there is none', () => {
    expect(buildCreate({ ...form, fundAmount: '', fundSol: '' }, A, 6, NOW).body).not.toHaveProperty('fund');
  });
  it('refuses the owner as its own agent, in words', () => {
    expect(buildCreate({ ...form, agent: A }, A, 6, NOW).errors.agent).toMatch(/different key from the owner/);
  });
  it('funds in tokens, in SOL, or both, and nothing for nothing', () => {
    expect(buildFund({ amount: '25', sol: '' }, A, B, 6).body).toEqual({ owner: A, mandate: B, amount: '25000000' });
    expect(buildFund({ amount: '', sol: '0.5' }, A, B, 6).body).toEqual({ owner: A, mandate: B, lamports: '500000000' });
    expect(buildFund({ amount: '', sol: '' }, A, B, 6).body).toBeNull();
    expect(buildFund({ amount: 'x', sol: '' }, A, B, 6).error).toBeDefined();
  });
});

describe('mandates: buildOrder', () => {
  const market = { priceScale: 1_000_000n, baseDecimals: 6, quoteDecimals: 6 };
  const grid = { minPrice: 1_000_000n, tick: 100_000n, ticks: 20 };
  it('builds an order at a grid price, with a salt only for a sealed cross', () => {
    expect(buildOrder({ cross: C, price: '1.3', quantity: '10' }, A, B, market, null, grid).body).toEqual({ agent: A, mandate: B, cross: C, price: '1300000', quantity: '10000000' });
    expect(buildOrder({ cross: C, price: '1.3', quantity: '10' }, A, B, market, 'ab'.repeat(32), grid).body).toMatchObject({ salt: 'ab'.repeat(32) });
  });
  it('names a price that is not on the cross’s grid, before the wallet is asked', () => {
    expect(buildOrder({ cross: C, price: '1.35', quantity: '10' }, A, B, market, null, grid).errors.price).toMatch(/not on the cross’s grid.*20 prices from 1 in steps of 0\.1/);
    expect(buildOrder({ cross: C, price: '0.9', quantity: '10' }, A, B, market, null, grid).errors.price).toBeDefined();
    expect(buildOrder({ cross: C, price: '3.1', quantity: '10' }, A, B, market, null, grid).errors.price).toBeDefined();
  });
  it('waits for the cross to be read, and names a quantity finer than the token', () => {
    expect(buildOrder({ cross: C, price: '1.3', quantity: '10' }, A, B, null, null).body).toBeNull();
    expect(buildOrder({ cross: C, price: '1.3', quantity: '0.0000001' }, A, B, market, null, grid).errors.quantity).toMatch(/at most 6 decimals/);
  });
  it('makes a fresh 32-byte salt every time', () => {
    const s = newSalt();
    expect(s).toMatch(/^[0-9a-f]{64}$/);
    expect(newSalt()).not.toBe(s);
  });
});

describe('mandates: blockers', () => {
  it('say why the agent cannot place an order', () => {
    expect(blockerText('revoked')).toMatch(/revoked this mandate for good/);
    expect(blockerText('vault empty')).toMatch(/nothing to escrow/);
    expect(blockerText('signer account needs SOL for order rent')).toMatch(/rent/);
    expect(blockerText('something else')).toBe('something else');
  });
});
