import { describe, expect, it } from 'vitest';
import { checkOracle, fdvAt, guardNotes, maxTopPriceForFdv, minMatchedForFloat, minMatchedFromRaise, ticksUnder } from '../src/lib/issuer-guards';
import { simulate } from '../src/lib/issuer-sim';

const T = (n: number) => BigInt(Math.round(n * 1_000_000));
const SCALE = 1_000_000n;

describe('minimum raise to tokens (B5)', () => {
  it('rounds up so the raise is never below the target', () => {
    // 100 quote at 1.20 needs 83.333334 tokens (6 decimals): 83.333333 would raise 99.9999996.
    const m = minMatchedFromRaise(T(100), 1_200_000n, SCALE);
    expect(m).toBe(83_333_334n);
    expect((m * 1_200_000n) / SCALE).toBeGreaterThanOrEqual(T(100) - 1n);
    expect(((m - 1n) * 1_200_000n) / SCALE).toBeLessThan(T(100));
  });
  it('is zero for no target or no price', () => {
    expect(minMatchedFromRaise(0n, 1_200_000n, SCALE)).toBe(0n);
    expect(minMatchedFromRaise(T(1), 0n, SCALE)).toBe(0n);
  });
});

describe('minimum float as a minimum volume (B13)', () => {
  it('in a minting cross, the threshold is the smallest sale whose float reaches the target', () => {
    for (const [f, existing] of [[500, T(9_000)], [1_000, T(1_000_000)], [2_500, 123_456_789n], [9_999, 7n]] as const) {
      const m = minMatchedForFloat(f, existing, 'mint')!;
      // float at m reaches f, and one atom less does not
      expect(m * 10_000n).toBeGreaterThanOrEqual(BigInt(f) * (existing + m));
      if (m > 0n) expect((m - 1n) * 10_000n).toBeLessThan(BigInt(f) * (existing + m - 1n));
    }
  });
  it('in an escrow cross, the supply is fixed, so the threshold is a share of it', () => {
    expect(minMatchedForFloat(1_000, T(5_000), 'escrow')).toBe(T(500));
    expect(minMatchedForFloat(1, 5n, 'escrow')).toBe(1n);
  });
  it('is unreachable at 100% in a minting cross and zero when nothing is asked', () => {
    expect(minMatchedForFloat(10_000, T(1), 'mint')).toBeNull();
    expect(minMatchedForFloat(0, T(1), 'mint')).toBe(0n);
  });
  it('is enforced by the program: a cross whose min_matched is that threshold prints at that float and not below', () => {
    const grid = { minPrice: 1_000_000n, tick: 100_000n, ticks: 20, priceScale: SCALE, baseDecimals: 6, quoteDecimals: 6 };
    const existing = T(9_000);
    const floorBps = 500; // 5%
    const minMatched = minMatchedForFloat(floorBps, existing, 'mint')!;
    const mk = (demand: bigint) => simulate({ grid, supply: [{ price: 1_200_000n, quantity: T(2_000) }], demand: [{ price: 1_500_000n, quantity: demand }], supplyMode: 'mint', existingSupply: existing, minMatched, maxImbalanceBps: null, protocolBps: 0, integratorBps: 0 });
    const ok = mk(minMatched);
    expect(ok.printed && ok.floatBps >= BigInt(floorBps)).toBe(true);
    expect(mk(minMatched - 1n)).toMatchObject({ printed: false, reason: 'BelowMinimumVolume' });
  });
});

describe('maximum fully diluted value as a ceiling on the grid (B13)', () => {
  it('the top price keeps FDV under the cap whatever the cross sells', () => {
    const cap = T(1_000_000); // 1,000,000 quote
    const existing = T(9_000);
    const sold = T(1_000);
    const top = maxTopPriceForFdv(cap, existing, sold, 'mint', SCALE)!;
    expect(fdvAt(top, existing + sold, SCALE)).toBeLessThanOrEqual(cap);
    expect(fdvAt(top + 1n, existing + sold, SCALE)).toBeGreaterThan(cap);
  });
  it('in escrow mode only the existing supply counts', () => {
    expect(maxTopPriceForFdv(T(1_000), T(500), 0n, 'escrow', SCALE)).toBe(2_000_000n);
  });
  it('has no answer without a supply or a cap', () => {
    expect(maxTopPriceForFdv(0n, T(1), T(1), 'mint', SCALE)).toBeNull();
    expect(maxTopPriceForFdv(T(1), 0n, 0n, 'mint', SCALE)).toBeNull();
  });
  it('ticksUnder counts the levels from the lowest price up to the ceiling', () => {
    expect(ticksUnder(1_000_000n, 100_000n, 1_950_000n)).toBe(10); // 1.0 .. 1.9
    expect(ticksUnder(1_000_000n, 100_000n, 1_100_000n)).toBe(2);
    expect(ticksUnder(1_000_000n, 100_000n, 1_099_999n)).toBeNull();
    expect(ticksUnder(1_000_000n, 1n, 9_999_999n)).toBe(256);
    expect(ticksUnder(1_000_000n, 0n, 2_000_000n)).toBeNull();
  });
});

const ctx = { supplyMode: 'mint' as const, baseDecimals: 6, offered: T(1_000), minMatched: 0n as bigint | null, maxImbalanceBps: null as number | null, oracleEnabled: false };

describe('guard explanations (W8)', () => {
  const byId = (c: typeof ctx, id: string) => guardNotes(c).find((n) => n.id === id)!;

  it('says plainly that no minimum means a thin sale prints', () => {
    const n = byId(ctx, 'min-volume');
    expect(n.severity).toBe('warn');
    expect(n.text).toMatch(/single token/);
  });
  it('blocks a minimum above the supply on offer, because the cross could never print', () => {
    const n = byId({ ...ctx, minMatched: T(1_001) }, 'min-volume');
    expect(n.severity).toBe('block');
    expect(n.text).toMatch(/never print/);
    expect(byId({ ...ctx, minMatched: T(1_000) }, 'min-volume').severity).toBe('ok');
  });
  it('blocks a minimum that is not a number', () => {
    expect(byId({ ...ctx, minMatched: null }, 'min-volume').severity).toBe('block');
  });
  it('states the band of demand a given imbalance limit lets print, and it is true', () => {
    const n = byId({ ...ctx, maxImbalanceBps: 5_000 }, 'imbalance');
    expect(n.text).toContain('between 67% and 150%');
    expect(n.severity).toBe('warn');
    const grid = { minPrice: 1_000_000n, tick: 100_000n, ticks: 20, priceScale: SCALE, baseDecimals: 6, quoteDecimals: 6 };
    const run = (demand: bigint) => simulate({ grid, supply: [{ price: 1_200_000n, quantity: T(1_000) }], demand: [{ price: 1_500_000n, quantity: demand }], supplyMode: 'mint', existingSupply: 0n, minMatched: 0n, maxImbalanceBps: 5_000, protocolBps: 0, integratorBps: 0 }).printed;
    expect(run(T(1_500))).toBe(true); // 150% of supply prints
    expect(run(T(1_501))).toBe(false); // just over does not
    expect(run(T(667))).toBe(true); // 66.7% of supply prints (333 unsold on 667 traded is exactly under 50%)
    expect(run(T(666))).toBe(false);
  });
  it('a loose limit is information, not a warning', () => {
    expect(byId({ ...ctx, maxImbalanceBps: 10_000 }, 'imbalance').severity).toBe('info');
  });
  it('warns that an oracle guard needs a price update at the clear', () => {
    const n = byId({ ...ctx, oracleEnabled: true }, 'oracle');
    expect(n.severity).toBe('warn');
    expect(n.text).toMatch(/stays open/);
    expect(byId(ctx, 'oracle').text).toMatch(/new token has no reference price/);
  });
});

describe('oracle guard parameters', () => {
  const ok = { enabled: true, feedId: 'ab'.repeat(32), maxDivergencePct: '2.5', maxStalenessSecs: 60 };
  it('a disabled guard sends nothing', () => {
    expect(checkOracle({ ...ok, enabled: false })).toEqual({ ok: true, body: null });
  });
  it('converts to the API’s fields', () => {
    expect(checkOracle(ok)).toEqual({ ok: true, body: { feedId: 'ab'.repeat(32), maxDivergenceBps: 250, maxStalenessSecs: 60 } });
    expect(checkOracle({ ...ok, feedId: `0x${'AB'.repeat(32)}` })).toMatchObject({ ok: true, body: { feedId: 'ab'.repeat(32) } });
  });
  it('refuses every bad field and names it', () => {
    const r = checkOracle({ enabled: true, feedId: 'xyz', maxDivergencePct: '0', maxStalenessSecs: 0 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(Object.keys(r.errors).sort()).toEqual(['feedId', 'maxDivergencePct', 'maxStalenessSecs']);
    expect(checkOracle({ ...ok, maxDivergencePct: '100.001' }).ok).toBe(false);
    expect(checkOracle({ ...ok, maxDivergencePct: '' }).ok).toBe(false);
    expect(checkOracle({ ...ok, maxStalenessSecs: Number.NaN }).ok).toBe(false);
    expect(checkOracle({ ...ok, maxStalenessSecs: 86_401 }).ok).toBe(false);
  });
});
