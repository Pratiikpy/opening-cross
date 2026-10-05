// The report's arithmetic and recommendation, side by side and edge by edge. Quotes here are
// constructed values, so every expected number can be checked by hand.
import { describe, expect, it } from 'vitest';
import type { Address } from '@solana/kit';
import { type CrossQuote, type DexQuote, bestExecution } from '../src/index.js';

const X = '11111111111111111111111111111111' as Address;
const SCALE = 1_000_000n;
const cross = (price: bigint, fill: bigint, quote: bigint): CrossQuote => ({ venue: 'cross', cross: X, available: true, disclosure: 'open', closeTs: 0n, indicative: { prints: true, price, fill, quote }, feeBps: 0 });
const dex = (quote: bigint, base: bigint): DexQuote => ({ venue: 'jupiter', available: true, quote, base, contextSlot: 1n, route: ['A'], priceImpactPct: '0' });

describe('best-execution report', () => {
  it('buy: a cheaper cross wins and the advantage is in bps of the DEX price', () => {
    // Cross 1.000 vs DEX 1.010 per token: the cross is 99 bps better (990099… truncated).
    const r = bestExecution({ side: 'buy', quantity: 10n * SCALE }, cross(1_000_000n, 10n * SCALE, 10_000_000n), dex(10_100_000n, 10n * SCALE), SCALE);
    expect(r.comparison).toMatchObject({ crossPrice: '1000000', dexPrice: '1010000', crossBetterByBps: 99 });
    expect(r.recommendation).toBe('cross');
  });

  it('sell: a higher net receipt on the cross wins; a lower one loses', () => {
    const better = bestExecution({ side: 'sell', quantity: SCALE }, cross(1_020_000n, SCALE, 1_020_000n), dex(1_000_000n, SCALE), SCALE);
    expect(better.comparison.crossBetterByBps).toBe(200);
    expect(better.recommendation).toBe('cross');
    const worse = bestExecution({ side: 'sell', quantity: SCALE }, cross(990_000n, SCALE, 990_000n), dex(1_000_000n, SCALE), SCALE);
    expect(worse.comparison.crossBetterByBps).toBe(-100);
    expect(worse.recommendation).toBe('dex');
  });

  it('a better but partial cross fill recommends a split and says so', () => {
    const r = bestExecution({ side: 'buy', quantity: 10n * SCALE }, cross(1_000_000n, 4n * SCALE, 4_000_000n), dex(10_100_000n, 10n * SCALE), SCALE);
    expect(r.recommendation).toBe('split');
    expect(r.caveats.join(' ')).toMatch(/Partial: the cross would fill 4000000 of 10000000/);
  });

  it('buy prices round up and sell prices round down, never flattering the venue', () => {
    const buy = bestExecution({ side: 'buy', quantity: 3n }, cross(1n, 3n, 1n), dex(1n, 3n), SCALE);
    expect(buy.comparison.dexPrice).toBe('333334');
    const sell = bestExecution({ side: 'sell', quantity: 3n }, cross(1n, 3n, 1n), dex(1n, 3n), SCALE);
    expect(sell.comparison.dexPrice).toBe('333333');
  });

  it('only one venue available: recommends it; neither: none', () => {
    const noDex: DexQuote = { venue: 'jupiter', available: false, reason: 'no route' };
    expect(bestExecution({ side: 'buy', quantity: SCALE }, cross(1_000_000n, SCALE, SCALE), noDex, SCALE).recommendation).toBe('cross');
    const noCross: CrossQuote = { venue: 'cross', cross: X, available: false, reason: 'cross is full' };
    expect(bestExecution({ side: 'buy', quantity: SCALE }, noCross, dex(SCALE, SCALE), SCALE).recommendation).toBe('dex');
    const none = bestExecution({ side: 'buy', quantity: SCALE }, noCross, noDex, SCALE);
    expect(none.recommendation).toBe('none');
    expect(none.caveats).toEqual(['Cross unavailable: cross is full.', 'DEX route unavailable: no route.']);
  });
});
