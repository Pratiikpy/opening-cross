// Meteora pools as a venue of the router (ADR-0921): pricing one order against real pool state, then ranking pools beside the cross and Jupiter.
// The pools are the ones the devnet proofs opened, read back from chain (test/fixtures/devnet-pools.json).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Address } from '@solana/kit';
import { type BestExecutionReport, PARTIAL_FILL_SLIPPAGE_BPS, type PoolRef, type PoolVenueQuote, type SerializedRanking, bestExecution, mergePoolsIntoRanking, quotePool, withPools } from '../src/index.js';
import { decodeBinArray, decodeDammPool, decodeLbPair, dammEngine, dlmmEngine, dlmmSwapStatus } from '../../adapters/src/health.js';

const fx = JSON.parse(readFileSync(new URL('./fixtures/devnet-pools.json', import.meta.url), 'utf8')) as {
  pools: { 'dlmm-proof': { pair: string; binArrays: { address: string }[] }; 'dlmm-ladder': { pair: string; binArrays: { address: string }[] }; 'damm-proof': { pool: string } };
  accounts: Record<string, { data: string }>;
};
const bytes = (a: string) => new Uint8Array(Buffer.from(fx.accounts[a]!.data, 'base64'));
const NOW = 1_791_900_000n;
const DECIMALS = 9;
const UNIT = 10n ** 9n;

function dlmm(name: 'dlmm-proof' | 'dlmm-ladder'): PoolRef {
  const pair = decodeLbPair(bytes(fx.pools[name].pair));
  const arrays = fx.pools[name].binArrays.map((b) => decodeBinArray(bytes(b.address)));
  const status = dlmmSwapStatus(pair, { slot: 0n, unixTimestamp: NOW });
  return { venue: 'meteora-dlmm', pool: fx.pools[name].pair as Address, tokenA: pair.tokenXMint, tokenB: pair.tokenYMint, open: status.open, reason: status.reason, engine: dlmmEngine({ pair, arrays, nowSeconds: NOW }) };
}
function damm(): PoolRef {
  const pool = decodeDammPool(bytes(fx.pools['damm-proof'].pool));
  return { venue: 'meteora-damm-v2', pool: fx.pools['damm-proof'].pool as Address, tokenA: pool.tokenAMint.toBase58() as Address, tokenB: pool.tokenBMint.toBase58() as Address, open: true, reason: null, engine: dammEngine({ pool, currentPoint: NOW, decimalsA: 9, decimalsB: 9 }) };
}
const refs = () => [dlmm('dlmm-proof'), dlmm('dlmm-ladder'), damm()];

describe('quotePool: selling base', () => {
  it('a sell is an exact-input swap of the base token, and its price is quote per whole base, rounded down', () => {
    for (const ref of refs()) {
      const q = quotePool(ref, ref.tokenA, ref.tokenB, DECIMALS, { side: 'sell', quantity: 5_000_000n });
      expect(q.available).toBe(true);
      if (!q.available) continue;
      const direct = ref.engine.swap(true, 5_000_000n);
      expect(q).toMatchObject({ side: 'sell', base: 5_000_000n, quote: direct.out, partial: false, executableNow: true });
      expect(q.pricePerBase).toBe((direct.out * UNIT) / 5_000_000n);
      expect(q.route).toMatchObject({ aToB: true, inputMint: ref.tokenA, outputMint: ref.tokenB, amountIn: 5_000_000n, expectedOut: direct.out });
      // a sell never gets more than the mid price and the slippage says by how much, fee included
      expect(q.pricePerBase).toBeLessThanOrEqual(q.midPricePerBase);
      expect(q.slippageBps).toBeGreaterThan(0n);
    }
  });

  it('a bigger sell is worse: lower price, more slippage', () => {
    const ref = damm();
    const small = quotePool(ref, ref.tokenA, ref.tokenB, DECIMALS, { side: 'sell', quantity: 1_000_000n });
    const big = quotePool(ref, ref.tokenA, ref.tokenB, DECIMALS, { side: 'sell', quantity: 100_000_000n });
    if (!small.available || !big.available) throw new Error('both must price');
    expect(big.pricePerBase).toBeLessThan(small.pricePerBase);
    expect(big.slippageBps).toBeGreaterThan(small.slippageBps);
  });

  it('selling more base than the pool can take returns what it takes, marked partial', () => {
    const ref = dlmm('dlmm-proof');
    // This pair holds 1.03 billion quote atoms; selling 10 billion base atoms cannot be absorbed.
    const q = quotePool(ref, ref.tokenA, ref.tokenB, DECIMALS, { side: 'sell', quantity: 10_000_000_000n });
    if (!q.available) throw new Error(q.reason);
    expect(q.partial).toBe(true);
    expect(q.base).toBeLessThan(10_000_000_000n);
    expect(q.quote).toBeLessThanOrEqual(ref.engine.reserveB);
    // what it reports is what the pool does for exactly that input
    expect(ref.engine.swap(true, q.base).out).toBe(q.quote);
    // and one atom more is not taken whole
    const more = ref.engine.swap(true, q.base + 1n);
    expect(more.partial || more.consumed < q.base + 1n).toBe(true);
  });
});

describe('quotePool: buying base', () => {
  it('finds the smallest quote input that returns the amount asked for', () => {
    for (const ref of refs()) {
      for (const quantity of [1_000_000n, 25_000_000n, 150_000_000n]) {
        const q = quotePool(ref, ref.tokenA, ref.tokenB, DECIMALS, { side: 'buy', quantity });
        if (!q.available) throw new Error(`${ref.venue}: ${q.reason}`);
        if (q.partial) continue;
        expect(q.base).toBe(quantity);
        expect(q.route).toMatchObject({ aToB: false, inputMint: ref.tokenB, outputMint: ref.tokenA, amountIn: q.quote });
        expect(ref.engine.swap(false, q.quote).out).toBeGreaterThanOrEqual(quantity);
        // one atom less of quote does not buy it: the input is minimal
        expect(ref.engine.swap(false, q.quote - 1n).out).toBeLessThan(quantity);
        // a buyer's price rounds up and is at least the mid price
        expect(q.pricePerBase).toBe((q.quote * UNIT + quantity - 1n) / quantity);
        expect(q.pricePerBase).toBeGreaterThanOrEqual(q.midPricePerBase);
      }
    }
  });

  it('buying more than the pool holds is partial, with the most it can give', () => {
    const ref = dlmm('dlmm-ladder');
    const q = quotePool(ref, ref.tokenA, ref.tokenB, DECIMALS, { side: 'buy', quantity: 5_000_000_000n });
    if (!q.available) throw new Error(q.reason);
    expect(q.partial).toBe(true);
    expect(q.base).toBeLessThanOrEqual(ref.engine.reserveA);
    expect(q.base).toBe(q.route.expectedOut);
  });

  it('works with the pair the other way round (the base token is the pool’s token B)', () => {
    const ref = damm();
    // Treat token B as the base and token A as the quote.
    const sell = quotePool(ref, ref.tokenB, ref.tokenA, DECIMALS, { side: 'sell', quantity: 5_000_000n });
    if (!sell.available) throw new Error(sell.reason);
    expect(sell.route).toMatchObject({ aToB: false, inputMint: ref.tokenB });
    expect(sell.quote).toBe(ref.engine.swap(false, 5_000_000n).out);
    const buy = quotePool(ref, ref.tokenB, ref.tokenA, DECIMALS, { side: 'buy', quantity: 5_000_000n });
    if (!buy.available) throw new Error(buy.reason);
    expect(buy.route).toMatchObject({ aToB: true, inputMint: ref.tokenA });
    expect(ref.engine.swap(true, buy.quote).out).toBeGreaterThanOrEqual(5_000_000n);
    // the mid price is the inverse: quote atoms per whole base now means A per B
    expect(sell.midPricePerBase).toBeGreaterThan(0n);
  });
});

describe('quotePool: partial fills are bounded by the slippage they cost', () => {
  it('a constant-product pool never runs out, so a partial quote is the most within 10% of its mid price', () => {
    const ref = damm();
    // The pool holds 905,000,000 base atoms; 900 billion cannot be had at any price the pool quotes.
    const buy = quotePool(ref, ref.tokenA, ref.tokenB, DECIMALS, { side: 'buy', quantity: 900_000_000_000n });
    if (!buy.available) throw new Error(buy.reason);
    expect(buy.partial).toBe(true);
    expect(buy.base).toBeLessThan(905_000_000n);
    expect(buy.slippageBps).toBeLessThanOrEqual(PARTIAL_FILL_SLIPPAGE_BPS);
    expect(buy.slippageBps).toBeGreaterThan(900n);
    // Selling is different: the pool takes any amount of a token it holds none of the other side of, and pays almost nothing for it. That is a full fill at a
    // price that shows what it is, not a partial one.
    const sell = quotePool(ref, ref.tokenA, ref.tokenB, DECIMALS, { side: 'sell', quantity: 900_000_000_000n });
    if (!sell.available) throw new Error(sell.reason);
    expect(sell.partial).toBe(false);
    expect(sell.slippageBps).toBeGreaterThan(9_900n);
  });

  it('a partial sell happens where the pool cannot take the amount: a DLMM pair holds only so much of the other token', () => {
    const ref = dlmm('dlmm-proof');
    const sell = quotePool(ref, ref.tokenA, ref.tokenB, DECIMALS, { side: 'sell', quantity: 900_000_000_000n });
    if (!sell.available) throw new Error(sell.reason);
    expect(sell.partial).toBe(true);
    expect(sell.base).toBe(ref.engine.depth(true, PARTIAL_FILL_SLIPPAGE_BPS).maxIn);
    expect(sell.slippageBps).toBeLessThanOrEqual(PARTIAL_FILL_SLIPPAGE_BPS);
  });

  it('a full fill that costs more than the bound is still full, with its slippage shown', () => {
    const ref = damm();
    const q = quotePool(ref, ref.tokenA, ref.tokenB, DECIMALS, { side: 'sell', quantity: 400_000_000n });
    if (!q.available) throw new Error(q.reason);
    expect(q.partial).toBe(false);
    expect(q.slippageBps).toBeGreaterThan(PARTIAL_FILL_SLIPPAGE_BPS);
  });
});

describe('quotePool: refusals', () => {
  it('says why a pool cannot be priced and never invents a price', () => {
    const ref = damm();
    expect(quotePool(ref, ref.tokenA, 'So11111111111111111111111111111111111111112' as Address, DECIMALS, { side: 'sell', quantity: 1n })).toMatchObject({ available: false, reason: 'the pool does not trade this pair' });
    expect(quotePool({ ...ref, open: false, reason: 'the pool opens at timestamp 1800000000' }, ref.tokenA, ref.tokenB, DECIMALS, { side: 'sell', quantity: 1_000_000n })).toMatchObject({ available: false, reason: 'the pool opens at timestamp 1800000000' });
    expect(quotePool(ref, ref.tokenA, ref.tokenB, DECIMALS, { side: 'sell', quantity: 0n })).toMatchObject({ available: false });
    // an amount so small the pool returns nothing for it
    expect(quotePool(dlmm('dlmm-proof'), ref.tokenA, ref.tokenB, DECIMALS, { side: 'sell', quantity: 1n })).toMatchObject({ available: false });
  });

  it('a pool with no liquidity on the side asked for is unavailable, not a zero price', () => {
    const ladder = dlmm('dlmm-ladder');
    // The ladder holds only token X above the active bin and a little token Y below; an empty-quote engine cannot buy.
    const empty: PoolRef = { ...ladder, engine: { ...ladder.engine, swap: () => ({ consumed: 0n, out: 0n, fee: 0n, partial: true }) } };
    expect(quotePool(empty, ladder.tokenA, ladder.tokenB, DECIMALS, { side: 'buy', quantity: 1_000_000n })).toMatchObject({ available: false });
    expect(quotePool(empty, ladder.tokenA, ladder.tokenB, DECIMALS, { side: 'sell', quantity: 1_000_000n })).toMatchObject({ available: false });
  });
});

describe('mergePoolsIntoRanking', () => {
  const A = 'DTB3Jtxb6dy7GvocUbypiJb548ZLGRzVdPrNNCWAKEdC';
  const row = (venue: string, price: bigint, base: bigint, fill: 'full' | 'partial', extra: Record<string, unknown> = {}) => ({ rank: 0, venue, baseAtoms: base.toString(), quoteAtoms: '0', pricePerBase: price.toString(), fill, ...extra });
  const ranking = (over: Partial<SerializedRanking> = {}): SerializedRanking => ({
    schema: 'opening-cross/router-quote/v1',
    venues: [row('cross', 1_500_000_000n, 10n, 'full', { cross: A }), row('jupiter', 1_600_000_000n, 10n, 'full')].map((r, i) => ({ ...r, rank: i + 1 })),
    excluded: [
      { venue: 'jupiter', reason: 'skipped' },
      { venue: 'meteora', reason: 'The router does not price Meteora pools directly. When a Meteora pool has liquidity for the pair, Jupiter may route through it.' },
    ],
    best: { venue: 'cross', cross: A },
    caveats: ['A cross price is indicative.', 'This is a quote comparison only. Nothing is signed or sent.'],
    ...over,
  });
  const quoteOf = (ref: PoolRef, side: 'buy' | 'sell', quantity: bigint): PoolVenueQuote => quotePool(ref, ref.tokenA, ref.tokenB, DECIMALS, { side, quantity });

  it('adds the pool, drops the "Meteora is not priced" line and orders by the router’s rule', () => {
    const ref = damm();
    const q = quoteOf(ref, 'buy', 10n);
    if (!q.available) throw new Error(q.reason);
    const cheap: PoolVenueQuote = { ...q, pricePerBase: 1_400_000_000n, partial: false };
    const r = mergePoolsIntoRanking(ranking(), [cheap], 'buy');
    expect(r.venues.map((v) => [v.rank, v.venue])).toEqual([[1, 'meteora-damm-v2'], [2, 'cross'], [3, 'jupiter']]);
    expect(r.best).toEqual({ venue: 'meteora-damm-v2', pool: ref.pool });
    expect(r.excluded.some((e) => e.venue === 'meteora')).toBe(false);
    expect(r.excluded).toContainEqual({ venue: 'jupiter', reason: 'skipped' });
    expect(r.venues[0]).toMatchObject({ executableNow: true, route: { aToB: false } });
    // the pool caveat sits before the closing "nothing is signed" line, and the Jupiter overlap is called out
    expect(r.caveats.at(-2)).toMatch(/Jupiter route may itself pass through/);
    expect(r.caveats.join(' ')).toMatch(/pool quote is executable now/);
  });

  it('a seller ranks the higher price first; a full fill beats a better partial; partials sort by size', () => {
    const ref = damm();
    const q = quoteOf(ref, 'sell', 10n);
    if (!q.available) throw new Error(q.reason);
    const high: PoolVenueQuote = { ...q, pricePerBase: 1_700_000_000n };
    expect(mergePoolsIntoRanking(ranking(), [high], 'sell').venues[0]!.venue).toBe('meteora-damm-v2');
    const partialBest: PoolVenueQuote = { ...q, pricePerBase: 9_000_000_000n, partial: true, base: 4n };
    const merged = mergePoolsIntoRanking(ranking(), [partialBest], 'sell');
    expect(merged.venues.map((v) => v.venue)).toEqual(['jupiter', 'cross', 'meteora-damm-v2']);
    const two: PoolVenueQuote = { ...partialBest, pool: A as Address, base: 6n };
    expect(mergePoolsIntoRanking(ranking(), [partialBest, two], 'sell').venues.slice(2).map((v) => v.baseAtoms)).toEqual(['6', '4']);
  });

  it('is deterministic when prices tie, whatever the order the pools arrive in', () => {
    const q = quoteOf(damm(), 'buy', 10n);
    if (!q.available) throw new Error(q.reason);
    const p1: PoolVenueQuote = { ...q, pool: 'DTB3Jtxb6dy7GvocUbypiJb548ZLGRzVdPrNNCWAKEdC' as Address, pricePerBase: 1_500_000_000n };
    const p2: PoolVenueQuote = { ...q, pool: '22eBxH5mXpFk3NboAgReTkeNwvgerdKAeNWsrNmDy8Ta' as Address, pricePerBase: 1_500_000_000n };
    const one = mergePoolsIntoRanking(ranking(), [p1, p2], 'buy').venues.map((v) => `${v.venue}:${String(v.pool ?? v.cross ?? '')}`);
    const two = mergePoolsIntoRanking(ranking(), [p2, p1], 'buy').venues.map((v) => `${v.venue}:${String(v.pool ?? v.cross ?? '')}`);
    expect(one).toEqual(two);
  });

  it('a pool that cannot be priced is listed with its reason and changes nothing else', () => {
    const r = mergePoolsIntoRanking(ranking(), [{ venue: 'meteora-dlmm', pool: A as Address, available: false, reason: 'the pair opens at timestamp 1800000000' }], 'buy');
    expect(r.venues.map((v) => v.venue)).toEqual(['cross', 'jupiter']);
    expect(r.excluded).toContainEqual({ venue: 'meteora-dlmm', pool: A, reason: 'the pair opens at timestamp 1800000000' });
    expect(r.caveats.join(' ')).not.toMatch(/pool quote is executable/);
  });

  it('does not mutate its input', () => {
    const input = ranking();
    const copy = JSON.stringify(input);
    mergePoolsIntoRanking(input, [], 'buy');
    expect(JSON.stringify(input)).toBe(copy);
  });

  it('an empty ranking with one pool makes the pool the best venue', () => {
    const q = quoteOf(damm(), 'sell', 1_000_000n);
    const r = mergePoolsIntoRanking(ranking({ venues: [], best: null, excluded: [] }), [q], 'sell');
    expect(r.best).toMatchObject({ venue: 'meteora-damm-v2' });
  });
});

describe('withPools: the best-execution report', () => {
  const SCALE = 1_000_000n;
  const cross = { venue: 'cross' as const, cross: 'DTB3Jtxb6dy7GvocUbypiJb548ZLGRzVdPrNNCWAKEdC' as Address, available: true as const, disclosure: 'open' as const, closeTs: 0n, indicative: { prints: true, price: 1_000_000n, fill: 10n * SCALE, quote: 10_000_000n }, feeBps: 0 };
  const dex = { venue: 'jupiter' as const, available: true as const, quote: 10_100_000n, base: 10n * SCALE, contextSlot: 1n, route: ['A'], priceImpactPct: '0' };
  const poolAt = (quote: bigint, base: bigint, partial = false): PoolVenueQuote => ({ venue: 'meteora-damm-v2', pool: 'DTB3Jtxb6dy7GvocUbypiJb548ZLGRzVdPrNNCWAKEdC' as Address, available: true, side: 'buy', quote, base, pricePerBase: 0n, midPricePerBase: 0n, slippageBps: 0n, fee: 0n, partial, executableNow: true, route: { pool: 'DTB3Jtxb6dy7GvocUbypiJb548ZLGRzVdPrNNCWAKEdC' as Address, aToB: false, inputMint: 'So11111111111111111111111111111111111111112' as Address, outputMint: 'So11111111111111111111111111111111111111112' as Address, amountIn: quote, expectedOut: base } });
  const base = (): BestExecutionReport => bestExecution({ side: 'buy', quantity: 10n * SCALE }, cross, dex, SCALE);

  it('recommends the pool only when it fills the whole amount and beats the best other price', () => {
    const better = withPools(base(), { side: 'buy', quantity: 10n * SCALE }, [poolAt(9_900_000n, 10n * SCALE)], SCALE);
    expect(better.recommendation).toBe('pool');
    expect(better.comparison).toMatchObject({ bestPoolPrice: '990000', poolBetterThanBestOtherByBps: 100 });
    const worse = withPools(base(), { side: 'buy', quantity: 10n * SCALE }, [poolAt(10_300_000n, 10n * SCALE)], SCALE);
    expect(worse.recommendation).toBe('cross');
    expect(worse.comparison.poolBetterThanBestOtherByBps).toBe(-300);
  });

  it('a better partial pool is reported but not recommended', () => {
    const r = withPools(base(), { side: 'buy', quantity: 10n * SCALE }, [poolAt(2_000_000n, 4n * SCALE, true)], SCALE);
    expect(r.recommendation).toBe('cross');
    expect(r.caveats.join(' ')).toMatch(/Partial: the best pool would fill/);
  });

  it('with no other venue the pool is the recommendation, and an unavailable pool is a caveat', () => {
    const none = bestExecution({ side: 'buy', quantity: 10n * SCALE }, { venue: 'cross', cross: cross.cross, available: false, reason: 'cross not found' }, { venue: 'jupiter', available: false, reason: 'mainnet only' }, SCALE);
    const r = withPools(none, { side: 'buy', quantity: 10n * SCALE }, [poolAt(10_000_000n, 10n * SCALE), { venue: 'meteora-dlmm', pool: 'DTB3Jtxb6dy7GvocUbypiJb548ZLGRzVdPrNNCWAKEdC' as Address, available: false, reason: 'the pair is disabled' }], SCALE);
    expect(r.recommendation).toBe('pool');
    expect(r.caveats.join(' ')).toMatch(/unavailable: the pair is disabled/);
  });

  it('leaves the original report’s figures alone', () => {
    const b = base();
    const r = withPools(b, { side: 'buy', quantity: 10n * SCALE }, [], SCALE);
    expect(r.comparison).toMatchObject({ crossPrice: b.comparison.crossPrice, dexPrice: b.comparison.dexPrice });
    expect(r.recommendation).toBe(b.recommendation);
    expect(r.pools).toEqual([]);
  });
});
