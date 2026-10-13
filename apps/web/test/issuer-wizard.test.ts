import { describe, expect, it } from 'vitest';
import { type Draft, newDraft } from '../src/lib/issuer-draft';
import { type MintRead } from '../src/lib/issuer-readiness';
import { derive, fitGridAction, ruleChecks } from '../src/lib/issuer-wizard';
import { simulate } from '../src/lib/issuer-sim';

const T = (n: number) => BigInt(Math.round(n * 1_000_000));
const mint = (over: Partial<Extract<MintRead, { ok: true }>> = {}): MintRead => ({ ok: true, program: 'T', decimals: 6, mintAuthority: 'W', freezeAuthority: null, extensions: [], supply: T(9_000), metadata: null, ...over });
const draft = (over: Partial<Draft> = {}): Draft => ({ ...newDraft(new Date('2026-10-13T12:00:00')), minPrice: '1.00', tick: '0.10', ticks: 10, schedule: [{ price: '1.20', quantity: '1000' }], ...over });
const check = (d: Draft, base = mint(), quote = mint({ supply: 1n })) => {
  const v = derive(d, base, quote);
  return { v, checks: ruleChecks(d, v) };
};
const status = (cs: ReturnType<typeof ruleChecks>, id: string) => cs.find((c) => c.id === id)?.status;

describe('derive', () => {
  it('reads exact numbers off the form and the mints', () => {
    const { v } = check(draft());
    expect(v).toMatchObject({ baseDecimals: 6, quoteDecimals: 6, minPrice: 1_000_000n, tick: 100_000n, topPrice: 1_900_000n, offered: T(1000), existingSupply: T(9000), typedMinMatched: 0n, effectiveMinMatched: 0n, floatBps: 0, fdvCap: 0n, maxImbalanceBps: null });
  });
  it('knows nothing it was not told: with the mints unread, only the form is parsed', () => {
    const v = derive(draft(), null, null);
    expect(v.market).toBeNull();
    expect(v.minPrice).toBeNull();
    expect(v.offered).toBeNull();
    expect(v.existingSupply).toBeNull();
  });
  it('a failed mint read is not a mint', () => {
    const v = derive(draft(), { ok: false, reason: 'x' }, mint());
    expect(v.market).toBeNull();
  });
  it('escrow mode lists no supply of its own', () => {
    expect(derive(draft({ supplyMode: 'escrow' }), mint(), mint()).offered).toBeNull();
  });
  it('typed minimum volume is exact, invalid text is null, empty is zero', () => {
    expect(derive(draft({ minMatched: '12.5' }), mint(), mint()).typedMinMatched).toBe(T(12.5));
    expect(derive(draft({ minMatched: 'x' }), mint(), mint()).typedMinMatched).toBeNull();
    expect(derive(draft({ minMatched: '' }), mint(), mint()).typedMinMatched).toBe(0n);
  });
  it('imbalance is basis points, or invalid', () => {
    expect(derive(draft({ maxImbalancePct: '12.5' }), mint(), mint()).maxImbalanceBps).toBe(1250);
    expect(derive(draft({ maxImbalancePct: '101' }), mint(), mint()).maxImbalanceBps).toBe('invalid');
    expect(derive(draft({ maxImbalancePct: '1.234' }), mint(), mint()).maxImbalanceBps).toBe('invalid');
  });
});

describe('minimum float becomes the program’s minimum volume', () => {
  it('raises the effective minimum to what the float needs, and never lowers a larger one the issuer typed', () => {
    const d = draft({ minFloatPct: '5', minMatched: '' });
    const { v } = check(d);
    expect(v.floatBps).toBe(500);
    // 5% of (9000 + m) => m >= 473.684211 tokens (rounded up to the atom)
    expect(v.floatMinMatched).toBe(473_684_211n);
    expect(v.effectiveMinMatched).toBe(473_684_211n);
    expect(check(draft({ minFloatPct: '5', minMatched: '600' })).v.effectiveMinMatched).toBe(T(600));
  });
  it('is enforced end to end: the simulated cross prints at the float and not below it', () => {
    const d = draft({ minFloatPct: '5' });
    const { v } = check(d);
    const grid = { minPrice: v.minPrice!, tick: v.tick!, ticks: d.ticks, priceScale: v.market!.priceScale, baseDecimals: 6, quoteDecimals: 6 };
    const run = (demand: bigint) => simulate({ grid, supply: v.steps, demand: [{ price: 1_500_000n, quantity: demand }], supplyMode: 'mint', existingSupply: v.existingSupply!, minMatched: v.effectiveMinMatched!, maxImbalanceBps: null, protocolBps: 0, integratorBps: 0 });
    const at = run(v.effectiveMinMatched!);
    expect(at.printed && at.floatBps >= 500n).toBe(true);
    expect(run(v.effectiveMinMatched! - 1n)).toMatchObject({ printed: false, reason: 'BelowMinimumVolume' });
  });
  it('fails when the supply listed cannot reach it, and says how much would', () => {
    const { checks } = check(draft({ minFloatPct: '50' }));
    expect(status(checks, 'rule-float')).toBe('fail');
    expect(checks.find((c) => c.id === 'rule-float')!.detail).toMatch(/needs 9,000 tokens to trade, but you list 1,000 tokens/);
  });
  it('is impossible at 100% in a minting cross, valid at 100% only in escrow', () => {
    expect(status(check(draft({ minFloatPct: '100' })).checks, 'rule-float')).toBe('fail');
    expect(status(check(draft({ supplyMode: 'escrow', minFloatPct: '100' })).checks, 'rule-float')).toBe('pass');
  });
  it('waits for the token’s supply, and rejects a bad percentage', () => {
    expect(status(ruleChecks(draft({ minFloatPct: '5' }), derive(draft({ minFloatPct: '5' }), mint({ supply: undefined as never }), mint())), 'rule-float')).toBe('wait');
    expect(status(check(draft({ minFloatPct: '0' })).checks, 'rule-float')).toBe('fail');
    expect(status(check(draft({ minFloatPct: 'x' })).checks, 'rule-float')).toBe('fail');
  });
});

describe('value ceiling becomes a ceiling on the grid', () => {
  it('passes when the top of the grid is under it with everything sold', () => {
    // top 1.9 x (9000 + 1000) = 19,000 quote
    expect(status(check(draft({ maxFdv: '19000' })).checks, 'rule-fdv')).toBe('pass');
    expect(status(check(draft({ maxFdv: '18999' })).checks, 'rule-fdv')).toBe('fail');
  });
  it('names the number of levels that fit, and offers it', () => {
    const d = draft({ maxFdv: '15000' }); // top price allowed = 15000 / 10000 = 1.50 -> levels 1.0..1.5 = 6
    const { v, checks } = check(d);
    expect(v.fdvTop).toBe(1_500_000n);
    expect(v.fitTicks).toBe(6);
    expect(fitGridAction(v)).toEqual({ ticks: 6 });
    expect(checks.find((c) => c.id === 'rule-fdv')!.detail).toMatch(/Shorten the grid to 6 levels/);
    // after fitting, it passes
    expect(status(check({ ...d, ticks: 6 }).checks, 'rule-fdv')).toBe('pass');
  });
  it('when not even two levels fit, says to lower the lowest price', () => {
    const { checks, v } = check(draft({ maxFdv: '5000' }));
    expect(v.fitTicks).toBeNull();
    expect(checks.find((c) => c.id === 'rule-fdv')!.detail).toMatch(/lower the lowest price/);
    expect(fitGridAction(v)).toBeNull();
  });
  it('escrow mode counts only the existing supply', () => {
    // escrow: 9000 tokens x top 1.9 = 17,100
    expect(status(check(draft({ supplyMode: 'escrow', maxFdv: '17100' })).checks, 'rule-fdv')).toBe('pass');
    expect(status(check(draft({ supplyMode: 'escrow', maxFdv: '17099' })).checks, 'rule-fdv')).toBe('fail');
  });
  it('is true at the clearing price the program can reach: no outcome exceeds the ceiling', () => {
    const d = draft({ maxFdv: '19000' });
    const { v } = check(d);
    const grid = { minPrice: v.minPrice!, tick: v.tick!, ticks: d.ticks, priceScale: v.market!.priceScale, baseDecimals: 6, quoteDecimals: 6 };
    const r = simulate({ grid, supply: v.steps, demand: [{ price: v.topPrice!, quantity: T(5000) }], supplyMode: 'mint', existingSupply: v.existingSupply!, minMatched: 0n, maxImbalanceBps: null, protocolBps: 0, integratorBps: 0 });
    expect(r.printed && r.fdv <= 19_000_000_000n).toBe(true);
  });
  it('rejects an amount that is not a number, and waits for the supply', () => {
    expect(status(check(draft({ maxFdv: 'lots' })).checks, 'rule-fdv')).toBe('fail');
    expect(status(ruleChecks(draft({ maxFdv: '100' }), derive(draft({ maxFdv: '100' }), null, null)), 'rule-fdv')).toBe('wait');
  });
});

describe('guard and oracle checks', () => {
  it('a minimum above the listed supply fails; none warns; a sensible one passes', () => {
    expect(status(check(draft({ minMatched: '1001' })).checks, 'guard-volume')).toBe('fail');
    expect(status(check(draft()).checks, 'guard-volume')).toBe('warn');
    expect(status(check(draft({ minMatched: '300' })).checks, 'guard-volume')).toBe('pass');
  });
  it('an invalid imbalance fails; the oracle guard is silent when off, warns when valid and fails when not', () => {
    expect(status(check(draft({ maxImbalancePct: 'x' })).checks, 'guard-imbalance')).toBe('fail');
    expect(status(check(draft()).checks, 'guard-oracle')).toBeUndefined();
    const on = { enabled: true, feedId: 'ab'.repeat(32), maxDivergencePct: '2', maxStalenessSecs: 60 };
    expect(status(check(draft({ oracle: on })).checks, 'guard-oracle')).toBe('warn');
    expect(status(check(draft({ oracle: { ...on, feedId: 'zz' } })).checks, 'guard-oracle')).toBe('fail');
  });
});

import { parseRows, simInputFrom } from '../src/lib/issuer-wizard';

describe('simulator input', () => {
  const fees = { source: 'proposed' as const, launch: 30, reopen: 5, tender: 15, recurring: 30 };
  it('parses typed rows exactly and names the bad ones', () => {
    const v = derive(draft(), mint(), mint());
    const { steps, errors } = parseRows([{ price: '1.50', quantity: '600' }, { price: '', quantity: '' }, { price: '1.5000001', quantity: '1' }, { price: '1.2', quantity: '0' }, { price: 'x', quantity: '1' }], v.market);
    expect(steps).toEqual([{ price: 1_500_000n, quantity: T(600) }]);
    expect(Object.keys(errors).map(Number)).toEqual([2, 3, 4]);
    expect(parseRows([{ price: '1', quantity: '1' }], null).errors[0]).toMatch(/Check both tokens/);
  });
  it('builds the program’s view of the cross: effective minimum volume, the snapshotted protocol fee, the schedule as supply', () => {
    const d = draft({ minFloatPct: '5', integratorFeeBps: 20, kind: 'launch' });
    const v = derive(d, mint(), mint());
    const i = simInputFrom(d, v, [{ price: 1_500_000n, quantity: T(600) }], [], fees)!;
    expect(i.minMatched).toBe(473_684_211n);
    expect(i.protocolBps).toBe(5); // min(30, floor(20/4))
    expect(i.integratorBps).toBe(20);
    expect(i.supply).toEqual(v.steps);
    expect(i.existingSupply).toBe(T(9000));
  });
  it('escrow mode uses the rows the issuer typed as supply', () => {
    const d = draft({ supplyMode: 'escrow' });
    const v = derive(d, mint(), mint());
    const i = simInputFrom(d, v, [], [{ price: 1_200_000n, quantity: T(50) }], fees)!;
    expect(i.supply).toEqual([{ price: 1_200_000n, quantity: T(50) }]);
  });
  it('is null until the mints are read and the guards are valid', () => {
    expect(simInputFrom(draft(), derive(draft(), null, null), [], [], fees)).toBeNull();
    expect(simInputFrom(draft({ maxImbalancePct: 'x' }), derive(draft({ maxImbalancePct: 'x' }), mint(), mint()), [], [], fees)).toBeNull();
    expect(simInputFrom(draft({ ticks: Number.NaN }), derive(draft({ ticks: Number.NaN }), mint(), mint()), [], [], fees)).toBeNull();
  });
});
