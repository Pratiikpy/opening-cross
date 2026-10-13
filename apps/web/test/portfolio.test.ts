import { describe, expect, it } from 'vitest';
import { type ChainOrder, type CrossFacts, buildPortfolio, claimNote, percentOf, resultOf } from '../src/lib/portfolio';
import type { OwnerOrder } from '../src/lib/types';

const cross = (over: Partial<CrossFacts> = {}): CrossFacts => ({
  address: 'X1',
  state: 'Finalized',
  decimals: { base: 6, quote: 6 },
  grid: { minPrice: '1000000', tick: '50000', ticks: 40, priceScale: '1000000' },
  baseMint: 'BASE',
  quoteMint: 'QUOTE',
  clearing: { price: '1000000', matched: '81000000', rationed: 'none' },
  noPrintReason: null,
  ...over,
});
const order = (over: Partial<OwnerOrder> = {}): OwnerOrder => ({
  cross_address: 'X1',
  idx: 0,
  address: 'O1',
  side: 'buy',
  escrow: '89100000',
  sealed: false,
  price: '1100000',
  quantity: '81000000',
  status: 'claimed',
  fill: '81000000',
  quote_out: '8100000',
  base_out: '81000000',
  fee: '0',
  ...over,
});
const chain = (over: Partial<ChainOrder> = {}): ChainOrder => ({ address: 'O1', open: true, nonce: '7', revealed: true, ...over });

describe('a settled buy (numbers from a real devnet order: 81 tokens, limit 1.10, cleared at 1.00)', () => {
  const r = resultOf(order(), cross(), undefined);
  it('reads tokens, price paid and refund from the record', () => {
    if (r.kind !== 'settled') throw new Error(r.kind);
    expect(r.filled).toBe(81_000_000n);
    expect(r.quote).toBe(81_000_000n); // escrow 89.1 less the 8.1 refund
    expect(r.quoteOther).toBe(8_100_000n);
    expect(r.average).toBe(1_000_000n);
    expect(r.limit).toBe(1_100_000n);
  });
  it('measures the improvement against the limit with the program ceiling rounding', () => {
    if (r.kind !== 'settled') throw new Error(r.kind);
    expect(r.improvement).toBe(8_100_000n); // 81 x 1.10 = 89.1 at the limit, 81 paid
  });
});

describe('a settled sell', () => {
  it('uses the gross before fee and the floor for the ask', () => {
    const r = resultOf(order({ side: 'sell', escrow: '100000000', price: '1300000', quantity: '100000000', fill: '80000000', quote_out: '103896000', base_out: '20000000', fee: '104000' }), cross(), undefined);
    if (r.kind !== 'settled') throw new Error(r.kind);
    expect(r.filled).toBe(80_000_000n);
    expect(r.quote).toBe(103_896_000n);
    expect(r.quoteOther).toBe(104_000n);
    expect(r.tokensBack).toBe(20_000_000n);
    expect(r.average).toBe(1_300_000n); // 104 gross / 80 tokens
    expect(r.improvement).toBe(0n);
  });
});

describe('orders that did not fill or whose limit is unknown', () => {
  it('a refunded order has no average price and no improvement', () => {
    const r = resultOf(order({ fill: '0', quote_out: '89100000', base_out: '0' }), cross(), undefined);
    if (r.kind !== 'settled') throw new Error(r.kind);
    expect(r.average).toBeNull();
    expect(r.improvement).toBeNull();
    expect(r.quote).toBe(0n);
  });
  it('an unrevealed sealed order has no limit on record, so no improvement is claimed', () => {
    const r = resultOf(order({ sealed: true, price: null, quantity: null }), cross(), undefined);
    if (r.kind !== 'settled') throw new Error(r.kind);
    expect(r.limit).toBeNull();
    expect(r.improvement).toBeNull();
  });
});

describe('what can be claimed', () => {
  const pending = order({ status: 'revealed', fill: null, quote_out: null, base_out: null, fee: null });
  it('an open order in a cleared cross is claimable, with the nonce from the chain', () => {
    expect(resultOf(pending, cross({ state: 'Cleared' }), chain())).toMatchObject({ kind: 'claimable', nonce: '7', claim: 'cleared' });
  });
  it('a no-print cross refunds everything', () => {
    expect(resultOf(pending, cross({ state: 'NoPrint', clearing: null }), chain())).toMatchObject({ kind: 'claimable', claim: 'no-print' });
  });
  it('a sealed bid that was never revealed is refundable and says so', () => {
    expect(resultOf(order({ ...pending, sealed: true, status: 'committed', price: null }), cross({ state: 'Cleared' }), chain({ revealed: false }))).toMatchObject({ kind: 'claimable', claim: 'unrevealed' });
    expect(claimNote('unrevealed')).toMatch(/not revealed in time/);
  });
  it('an order the chain no longer holds is settling, not locked', () => {
    expect(resultOf(pending, cross({ state: 'Cleared' }), chain({ open: false, nonce: null })).kind).toBe('settling');
  });
  it('an order in a live cross is locked, never claimable', () => {
    expect(resultOf(pending, cross({ state: 'Live', clearing: null }), undefined).kind).toBe('locked');
  });
  it('without a chain reading, a closed cross open order is locked and flagged unconfirmed', () => {
    expect(resultOf(pending, cross({ state: 'Cleared' }), undefined)).toMatchObject({ kind: 'locked', confirmed: false });
  });
  it('a cancelled order holds nothing: cancel returns the escrow in the same transaction', () => {
    expect(resultOf(order({ status: 'cancelled' }), cross(), undefined).kind).toBe('cancelled');
  });
});

describe('the portfolio', () => {
  const crosses = new Map([
    ['X1', cross()],
    ['X2', cross({ address: 'X2', state: 'Cleared', baseMint: 'BASE2', quoteMint: 'QUOTE' })],
  ]);
  const orders = [
    order({ address: 'A' }),
    order({ address: 'B', fill: '0', quote_out: '89100000', base_out: '0' }),
    order({ address: 'C', cross_address: 'X2', status: 'revealed', fill: null, quote_out: null, base_out: null, fee: null, escrow: '5000000' }),
    order({ address: 'D', cross_address: 'GONE' }),
  ];
  const p = buildPortfolio(orders, crosses, new Map([['C', chain({ address: 'C' })]]));
  it('leaves out orders whose cross could not be loaded', () => expect(p.orders).toBe(3));
  it('totals per cross', () => {
    const x1 = p.positions.find((x) => x.cross.address === 'X1')!;
    expect(x1.tokensReceived).toBe(81_000_000n);
    expect(x1.quotePaid).toBe(81_000_000n);
    expect(x1.quoteRefunded).toBe(8_100_000n + 89_100_000n);
    expect(x1.filledOrders).toBe(1);
    expect(x1.averagePaid).toBe(1_000_000n);
    expect(x1.improvement).toBe(8_100_000n);
  });
  it('keeps escrow and claims', () => {
    expect(p.claimable).toHaveLength(1);
    expect(p.positions.find((x) => x.cross.address === 'X2')!.lockedQuote).toBe(5_000_000n);
  });
  it('totals per quote mint, never across mints, and per base mint', () => {
    expect(p.quote).toHaveLength(1);
    expect(p.quote[0]).toMatchObject({ mint: 'QUOTE', quotePaid: 81_000_000n, lockedQuote: 5_000_000n });
    expect(p.base.map((b) => b.mint).sort()).toEqual(['BASE', 'BASE2']);
  });
  it('no orders is an empty portfolio, not zeroes dressed as results', () => {
    expect(buildPortfolio([], crosses, new Map())).toMatchObject({ orders: 0, crosses: 0, positions: [], quote: [], base: [] });
  });
});

describe('percentOf', () => {
  it('is exact to a tenth and null for a zero base', () => {
    expect(percentOf(1n, 3n)).toBe('33.3%');
    expect(percentOf(1n, 0n)).toBeNull();
  });
});
