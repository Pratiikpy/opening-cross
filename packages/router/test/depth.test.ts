// Per-cross depth and price impact (ADR-0922). The accounts are encoded with the program's own account encoders, so the router reads exactly the
// bytes cross_core writes; the book is small enough to clear by hand.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { type Address, getAddressDecoder } from '@solana/kit';
import { CROSS_CORE_PROGRAM_ADDRESS, CrossKind, CrossState, Disclosure, SupplyMode, getCrossEncoder, getLevelsEncoder } from '@opening-cross/cross-core-client';
import { bookAddressOf, referenceClear } from '@opening-cross/verifier';
import { type AccountReader, crossDepth } from '../src/index.js';

const key = (label: string): Address => getAddressDecoder().decode(createHash('sha256').update(`depth test: ${label}`).digest());
const CROSS = key('cross');
const NOW = 1_800_000_000;

function crossBytes(over: Record<string, unknown> = {}): Uint8Array {
  return Uint8Array.from(
    getCrossEncoder().encode({
      creator: key('creator'), crossId: 7n, kind: CrossKind.Launch, supplyMode: SupplyMode.Escrow, disclosure: Disclosure.Open, state: CrossState.Live,
      baseMint: key('base'), quoteMint: key('quote'), baseTokenProgram: key('tp-a'), quoteTokenProgram: key('tp-b'), baseDecimals: 6, quoteDecimals: 6, proceedsTo: key('proceeds'),
      minPrice: 1_000_000n, tick: 50_000n, ticks: 11, priceScale: 1_000_000n, openTs: BigInt(NOW - 60), closeTs: BigInt(NOW + 3_600), revealEndTs: BigInt(NOW + 3_600),
      referencePrice: null, minMatched: 0n, maxImbalanceBps: null, protocolFeeBps: 5, integratorFeeBps: 20, integrator: key('integrator'), feeRecipient: key('fee'), gateMint: null,
      shards: 2, maxOrders: 100, dustBond: 0n, ordersTotal: 4, ordersOpen: 4, mergedMask: 3, clearing: null, noPrintReason: null, buyerPaid: 0n, baseBought: 0n, baseSold: 0n,
      sellerPaid: 0n, feesAccrued: 0n, oracle: null, calendar: null, settler: null, settleDeadlineTs: 0n, baseBound: true, bump: 255, quoteVaultBump: 254, baseVaultBump: 253, bookBump: 252,
      ...over,
    } as never),
  );
}
// Prices 1.00 to 1.50 in steps of 0.05: tick 2 is 1.10, tick 4 is 1.20, tick 5 is 1.25, tick 6 is 1.30.
function levelsBytes(buy: Record<number, bigint>, sell: Record<number, bigint>, orders = 1): Uint8Array {
  const arr = (m: Record<number, bigint>) => Array.from({ length: 256 }, (_, i) => m[i] ?? 0n);
  const cnt = (m: Record<number, bigint>) => Array.from({ length: 256 }, (_, i) => (m[i] ? orders : 0));
  return Uint8Array.from(getLevelsEncoder().encode({ cross: CROSS, buy: arr(buy), sell: arr(sell), buyOrders: cnt(buy), sellOrders: cnt(sell), index: 0, pad: new Uint8Array(7) } as never));
}

async function reader(cross: Uint8Array | null, book: Uint8Array | null): Promise<AccountReader> {
  const bookAddress = await bookAddressOf(CROSS);
  return async (a) => {
    if (a === CROSS) return cross ? { data: cross, owner: CROSS_CORE_PROGRAM_ADDRESS } : null;
    if (a === bookAddress) return book ? { data: book, owner: CROSS_CORE_PROGRAM_ADDRESS } : null;
    return null;
  };
}

const BUY = { 6: 1000n, 4: 500n };
const SELL = { 2: 800n, 5: 900n };

describe('crossDepth: an open book', () => {
  it('lists each price with resting quantity and the cumulative depth a depth chart shows', async () => {
    const d = await crossDepth(await reader(crossBytes(), levelsBytes(BUY, SELL)), CROSS);
    if (!d.available || !d.bookVisible) throw new Error('book must be visible');
    expect(d.levels!.map((l) => [l.price, l.buyQuantity, l.sellQuantity])).toEqual([
      [1_100_000n, 0n, 800n],
      [1_200_000n, 500n, 0n],
      [1_250_000n, 0n, 900n],
      [1_300_000n, 1000n, 0n],
    ]);
    // Everything bid at or above a price, and everything offered at or below it.
    expect(d.levels!.map((l) => [l.cumulativeBuy, l.cumulativeSell])).toEqual([
      [1500n, 800n],
      [1500n, 800n],
      [1000n, 1700n],
      [1000n, 1700n],
    ]);
    expect(d.totals).toEqual({ buyQuantity: 1500n, sellQuantity: 1700n, buyOrders: 2, sellOrders: 2 });
    expect(d.feeBps).toBe(25);
    expect(d.state).toBe('Live');
  });

  it('clears the live book exactly as the reference implementation does', async () => {
    const d = await crossDepth(await reader(crossBytes(), levelsBytes(BUY, SELL)), CROSS);
    if (!d.available || !d.baseline) throw new Error('baseline expected');
    // By hand: demand 1000 at 1.30 only from 1.25 up, supply 1700 there; below that demand is 1500 and supply 800. The most that trades is 1000.
    expect(d.baseline).toMatchObject({ prints: true, matched: 1000n });
    expect([1_250_000n, 1_300_000n]).toContain(d.baseline.price);
    const ref = referenceClear([{ side: 'buy', price: 1_300_000n, quantity: 1000n }, { side: 'buy', price: 1_200_000n, quantity: 500n }, { side: 'sell', price: 1_100_000n, quantity: 800n }, { side: 'sell', price: 1_250_000n, quantity: 900n }], { min: 1_000_000n, tick: 50_000n, ticks: 11 }, null);
    expect(d.baseline.price).toBe(ref!.price);
  });

  it('a market order moves the price against itself, and the move is signed from the order’s side', async () => {
    const d = await crossDepth(await reader(crossBytes(), levelsBytes(BUY, SELL)), CROSS, { sizes: [100n, 1000n] });
    if (!d.available) throw new Error('available');
    const row = (side: 'buy' | 'sell', size: bigint) => d.impact.find((r) => r.side === side && r.size === size)!;
    // A seller of 1000 pushes the clearing price down to where demand 1500 meets supply 1800: between 1.10 and 1.20.
    const sell = row('sell', 1000n);
    expect(sell.prints).toBe(true);
    expect(sell.price!).toBeLessThanOrEqual(1_200_000n);
    expect(sell.impactBps!).toBeGreaterThan(0n);
    expect(sell.fill).toBeGreaterThan(0n);
    // A buyer of 1000 cannot lower the price: the impact is zero or positive, never negative.
    const buy = row('buy', 1000n);
    expect(buy.prints).toBe(true);
    expect(buy.impactBps!).toBeGreaterThanOrEqual(0n);
    // Bigger orders never have less impact than smaller ones on the same side.
    expect(row('sell', 1000n).impactBps!).toBeGreaterThanOrEqual(row('sell', 100n).impactBps!);
    expect(row('buy', 1000n).impactBps!).toBeGreaterThanOrEqual(row('buy', 100n).impactBps!);
  });

  it('chooses sizes as fractions of the volume that clears, both sides of each', async () => {
    const d = await crossDepth(await reader(crossBytes(), levelsBytes(BUY, SELL)), CROSS);
    if (!d.available) throw new Error('available');
    expect([...new Set(d.impact.map((r) => r.size))]).toEqual([10n, 20n, 50n, 100n, 250n, 500n, 1000n]);
    expect(d.impact).toHaveLength(14);
    expect((await crossDepth(await reader(crossBytes(), levelsBytes(BUY, SELL)), CROSS, { sizes: [5n, 6n, 7n], maxSizes: 2 })).available && true).toBe(true);
  });

  it('an empty book has no depth, no price and nothing to size an order against', async () => {
    const d = await crossDepth(await reader(crossBytes(), levelsBytes({}, {})), CROSS);
    if (!d.available || !d.bookVisible) throw new Error('visible');
    expect(d.levels).toEqual([]);
    expect(d.baseline).toEqual({ prints: false, price: null, matched: 0n });
    expect(d.impact).toEqual([]);
  });

  it('an order that creates the first cross has a price but no impact to measure', async () => {
    const d = await crossDepth(await reader(crossBytes(), levelsBytes({ 6: 1000n }, {})), CROSS, { sizes: [500n] });
    if (!d.available) throw new Error('available');
    expect(d.baseline!.prints).toBe(false);
    const sell = d.impact.find((r) => r.side === 'sell')!;
    expect(sell).toMatchObject({ prints: true, impactBps: null });
    expect(sell.fill).toBe(500n);
  });
});

describe('crossDepth: books that cannot be read, and things that are not crosses', () => {
  it('a sealed cross shows no book and says why', async () => {
    const d = await crossDepth(await reader(crossBytes({ disclosure: Disclosure.Sealed }), null), CROSS);
    if (!d.available) throw new Error('available');
    expect(d).toMatchObject({ bookVisible: false, levels: null, baseline: null, impact: [], disclosure: 'sealed' });
    expect(d.hiddenBecause).toMatch(/sealed/);
  });

  it('a cross that has cleared reports its outcome instead of a book to add to', async () => {
    const cleared = crossBytes({ state: CrossState.Cleared, clearing: { price: 1_250_000n, matched: 1000n, demand: 1000n, supply: 1700n, rationed: 0, marginalQuantity: 0n, marginalRemaining: 0n, marginalOrders: 0 } });
    const d = await crossDepth(await reader(cleared, levelsBytes(BUY, SELL)), CROSS);
    if (!d.available) throw new Error('available');
    expect(d.state).toBe('Cleared');
    expect(d.bookVisible).toBe(false);
    expect(d.settled).toMatchObject({ price: 1_250_000n, matched: 1000n });
    expect(d.hiddenBecause).toMatch(/no longer accepting orders/);
  });

  it('names a missing book account rather than showing an empty one', async () => {
    const d = await crossDepth(await reader(crossBytes(), null), CROSS);
    if (!d.available) throw new Error('available');
    expect(d.bookVisible).toBe(false);
    expect(d.hiddenBecause).toMatch(/order book account .* not found/);
  });

  it('refuses an address that is missing or is not a cross', async () => {
    expect(await crossDepth(await reader(null, null), CROSS)).toEqual({ available: false, cross: CROSS, reason: 'cross not found' });
    const other: AccountReader = async () => ({ data: new Uint8Array(500), owner: key('someone else') });
    expect(await crossDepth(other, CROSS)).toMatchObject({ available: false, reason: 'not an Opening Cross account' });
  });
});
