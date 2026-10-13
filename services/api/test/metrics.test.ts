// Pure computation of the measured metrics: no database, no chain. Every expected value is worked out by hand in the comments.
import { describe, expect, it } from 'vitest';
import { type CrossFact, type CrossStatics, type OrderFact, executionQuality, externalFlow, fairness, parseOwnWallets, quantile } from '../src/metrics.js';

const statics = (over: Partial<CrossStatics> = {}): CrossStatics => ({
  priceScale: 1_000_000n,
  quoteDecimals: 6,
  baseDecimals: 6,
  creator: 'CREATOR',
  proceedsTo: 'PROCEEDS',
  integrator: 'INTEGRATOR',
  feeRecipient: 'FEES',
  gateMint: null,
  sealed: false,
  ...over,
});
const order = (o: Partial<OrderFact> & Pick<OrderFact, 'owner' | 'side'>): OrderFact => ({ escrow: 0n, price: null, quantity: null, status: 'claimed', fill: 0n, quoteOut: 0n, ...o });
const cross = (c: Partial<CrossFact> & Pick<CrossFact, 'address' | 'orders'>): CrossFact => ({
  state: 'Finalized', closeTs: 1000, clearingPrice: 1_300_000n, matched: 1n, clearedAt: 1010, finalizedAt: 1060, statics: statics(), ...c,
});

// Clearing price 1.3, scale 1e6. Bids (limit, quantity, fill -> escrow, paid, refund):
//   b1 2.0, 1000, 1000 -> escrow 2000, paid 1300, refund 700   improvement 700 atoms, 3500 bps
//   b2 1.3,  500,  250 -> escrow  650, paid  325, refund 325   improvement   0 atoms,    0 bps (at the clearing price, partial)
//   b3 1.6,  100,  100 -> escrow  160, paid  130, refund  30   improvement  30 atoms, 1875 bps
//   b4 1.0,  100,    0 -> priced out, escrow 100 refunded
//   b5 cancelled, escrow 50 returned on cancel
//   b6 sealed, never revealed, escrow 40 refunded
const printed = cross({
  address: 'A',
  orders: [
    order({ owner: 'w1', side: 'buy', escrow: 2000n, price: 2_000_000n, quantity: 1000n, fill: 1000n, quoteOut: 700n }),
    order({ owner: 'w2', side: 'buy', escrow: 650n, price: 1_300_000n, quantity: 500n, fill: 250n, quoteOut: 325n }),
    order({ owner: 'w3', side: 'buy', escrow: 160n, price: 1_600_000n, quantity: 100n, fill: 100n, quoteOut: 30n }),
    order({ owner: 'w4', side: 'buy', escrow: 100n, price: 1_000_000n, quantity: 100n, fill: 0n, quoteOut: 100n }),
    order({ owner: 'w5', side: 'buy', escrow: 50n, price: 1_500_000n, quantity: 10n, status: 'cancelled', fill: null, quoteOut: null }),
    order({ owner: 'w6', side: 'buy', escrow: 40n, price: null, quantity: null, fill: 0n, quoteOut: 40n }),
    order({ owner: 's1', side: 'sell', escrow: 1350n, price: 1_000_000n, quantity: 1350n, fill: 1350n, quoteOut: 1000n }),
  ],
});

describe('quantile', () => {
  it('is nearest-rank and null on an empty sample', () => {
    expect(quantile([], 0.5)).toBeNull();
    expect(quantile([5, 1, 3], 0.5)).toBe(3);
    expect(quantile([5, 1, 3], 0.1)).toBe(1);
    expect(quantile([5, 1, 3], 1)).toBe(5);
    expect(quantile([30n, 700n, 0n], 0.5)).toBe(30n);
  });
});

describe('executionQuality', () => {
  const r = executionQuality([
    printed,
    cross({ address: 'NP', clearingPrice: null, matched: null, orders: [order({ owner: 'x', side: 'buy', escrow: 9n, quoteOut: 9n })] }),
    cross({ address: 'LIVE', state: 'Live', orders: [order({ owner: 'x', side: 'buy', escrow: 9n })] }),
  ]);

  it('samples only finalized crosses that printed and counts the finalized ones that did not', () => {
    expect(r.crosses).toBe(1);
    expect(r.finalizedWithoutPrint).toBe(1);
  });

  it('classifies every bid and computes the fill rate', () => {
    expect(r.bids).toEqual({ placed: 6, filled: 3, fillRate: 0.5, fullyFilled: 2, partiallyFilled: 1, notFilledPricedOut: 1, cancelled: 1, unrevealed: 1, unaccounted: 0 });
  });

  it('measures price improvement against each bids own limit', () => {
    // sorted bps [0, 1875, 3500] and atoms [0, 30, 700]; nearest-rank median is the middle, p10 the smallest
    expect(r.priceImprovement).toEqual({ filledBids: 3, atClearingPrice: 1, bps: { median: 1875, p10: 0 }, quoteAtoms: { median: '30', p10: '0', quoteDecimals: [6] }, inconsistent: 0 });
  });

  it('measures the share of bid escrow returned', () => {
    // escrowed 2000+650+160+100+50+40 = 3000; returned 700+325+30+100+50+40 = 1245
    expect(r.refundShare).toEqual({ crosses: 1, median: 0.415, min: 0.415, max: 0.415 });
  });

  it('measures time from close to the cleared and finalized events', () => {
    expect(r.closeToFinalizedSeconds).toEqual({ n: 1, median: 60, p90: 60, max: 60, excluded: 0 });
    expect(r.closeToClearedSeconds.median).toBe(10);
  });

  it('flags a bid whose recorded payment contradicts its limit instead of counting it', () => {
    const bad = cross({ address: 'B', orders: [order({ owner: 'w', side: 'buy', escrow: 2000n, price: 1_300_000n, quantity: 1000n, fill: 1000n, quoteOut: 0n })] });
    // paid 2000 but the cost at its limit is 1300: negative improvement, which cannot happen on chain
    const x = executionQuality([bad]);
    expect(x.priceImprovement.inconsistent).toBe(1);
    expect(x.priceImprovement.filledBids).toBe(0);
  });

  it('does not call a filled bid with no known limit price unrevealed', () => {
    const x = executionQuality([cross({ address: 'S', orders: [order({ owner: 'w', side: 'buy', escrow: 10n, price: null, quantity: null, fill: 5n, quoteOut: 0n })] })]);
    expect(x.bids).toMatchObject({ placed: 1, filled: 0, unrevealed: 0, unaccounted: 1 });
    expect(x.priceImprovement.filledBids).toBe(0);
  });

  it('reports nulls, not zeros, for an empty sample', () => {
    const e = executionQuality([]);
    expect(e.bids.fillRate).toBeNull();
    expect(e.priceImprovement.bps.median).toBeNull();
    expect(e.refundShare.median).toBeNull();
    expect(e.closeToFinalizedSeconds.median).toBeNull();
  });

  it('excludes a missing or negative duration and says how many', () => {
    const x = executionQuality([cross({ address: 'N', finalizedAt: null, orders: [] }), cross({ address: 'M', finalizedAt: 900, orders: [] })]);
    expect(x.closeToFinalizedSeconds).toEqual({ n: 0, median: null, p90: null, max: null, excluded: 2 });
  });
});

describe('fairness', () => {
  // 12 filled buyers: one takes 40, eleven take 10 each, total 150.
  const wide = cross({
    address: 'WIDE',
    orders: [
      order({ owner: 'big', side: 'buy', fill: 40n }),
      ...Array.from({ length: 11 }, (_, i) => order({ owner: `m${i}`, side: 'buy', fill: 10n })),
      order({ owner: 'big', side: 'sell', fill: 150n }),
    ],
  });
  // Two filled buyers: 90 and 10.
  const narrow = cross({ address: 'NARROW', statics: statics({ gateMint: 'GATE' }), orders: [order({ owner: 'a', side: 'buy', fill: 90n }), order({ owner: 'b', side: 'buy', fill: 10n }), order({ owner: 'c', side: 'sell', fill: 100n })] });

  const f = fairness([wide, narrow, cross({ address: 'LIVE', state: 'Live', orders: [order({ owner: 'z', side: 'buy', fill: 5n })] })]);

  it('computes cluster shares per cross', () => {
    const w = f.perCross.find((p) => p.address === 'WIDE')!;
    expect(w.bidders).toBe(12);
    expect(w.buy.wallets).toBe(12);
    expect(w.buy.top1).toBeCloseTo(40 / 150, 6);
    expect(w.buy.top5).toBeCloseTo(80 / 150, 6);
    expect(w.buy.top10).toBeCloseTo(130 / 150, 6);
    expect(w.sell).toEqual({ wallets: 1, top1: 1, top5: 1, top10: 1 });
    expect(w.bothSides).toBe(1);
  });

  it('counts identities honestly: gated crosses count gate-passing wallets, others say wallets not people', () => {
    expect(f.perCross.find((p) => p.address === 'WIDE')!.identity).toEqual({ count: 12, basis: 'wallets, not people', gated: false });
    expect(f.perCross.find((p) => p.address === 'NARROW')!.identity).toEqual({ count: 2, basis: 'gate-passing wallets', gated: true });
  });

  it('leaves unfinished crosses out and takes the Wilson interval over crosses', () => {
    expect(f.crosses).toBe(2);
    expect(f.topBuyerAboveThreshold.k).toBe(2);
    expect(f.topBuyerAboveThreshold.n).toBe(2);
    expect(f.topBuyerAboveThreshold.proportion).toBe(1);
    // Wilson 95% for 2 of 2: lower bound 0.342, upper 1
    expect(f.topBuyerAboveThreshold.wilsonLo).toBeCloseTo(0.3424, 3);
    expect(f.topBuyerAboveThreshold.wilsonHi).toBeCloseTo(1, 6);
  });

  it('takes medians only over crosses where the share is not trivially 100%', () => {
    expect(f.medianBuySide.crossesOver1).toBe(2);
    expect(f.medianBuySide.crossesOver5).toBe(1);
    expect(f.medianBuySide.crossesOver10).toBe(1);
    expect(f.medianBuySide.top5).toBeCloseTo(80 / 150, 6);
    expect(f.crossesWithSelfCross).toBe(1);
  });

  it('honours the threshold', () => {
    expect(fairness([wide, narrow], 0.5).topBuyerAboveThreshold.k).toBe(1); // only NARROW's 90% exceeds 50%
  });

  it('gives null, not a number, when nothing was filled', () => {
    const e = fairness([]);
    expect(e.topBuyerAboveThreshold).toEqual({ k: 0, n: 0, proportion: null, wilsonLo: null, wilsonHi: null });
    expect(e.medianBuySide.top1).toBeNull();
  });
});

describe('externalFlow', () => {
  const x1 = cross({ address: 'X1', orders: [order({ owner: 'CREATOR', side: 'sell', fill: 5n }), order({ owner: 'ours', side: 'buy', fill: 5n }), order({ owner: 'stranger', side: 'buy', fill: 0n })] });
  const x2 = cross({ address: 'X2', state: 'Live', statics: statics({ creator: 'OTHER' }), orders: [order({ owner: 'OTHER', side: 'buy' }), order({ owner: 'stranger', side: 'buy' })] });
  const x3 = cross({ address: 'X3', orders: [order({ owner: 'ours', side: 'buy', fill: 2n }), order({ owner: 'INTEGRATOR', side: 'sell', fill: 2n })] });
  const empty = cross({ address: 'EMPTY', orders: [] });

  it('excludes OWN_WALLETS and each cross own roles, and leaves the rest as external', () => {
    const r = externalFlow([x1, x2, x3, empty], new Set(['ours']), 'devnet');
    expect(r.crosses).toEqual({ withOrders: 3, withAnExternalWallet: 2, onlyOwnWallets: 1 });
    // wallets: CREATOR, ours, stranger, OTHER, INTEGRATOR. Own everywhere: CREATOR (own on X1), ours, INTEGRATOR; OTHER (own on X2). External: stranger.
    expect(r.wallets).toEqual({ total: 5, own: 4, external: 1, externalShare: 0.2 });
    expect(r.orders).toEqual({ total: 7, byExternal: 2, filled: 4, filledByExternal: 0 });
    expect(r.filledWallets).toEqual({ total: 3, own: 3, external: 0 });
    expect(r.verdict).toBe('external wallets seen, not known to be ours (upper bound on outside users)');
  });

  it('a creator who also trades on someone elses cross is external there, so external overall', () => {
    const y = cross({ address: 'Y', statics: statics({ creator: 'someone' }), orders: [order({ owner: 'CREATOR', side: 'buy', fill: 1n })] });
    const r = externalFlow([x1, y], new Set(), 'devnet');
    expect(r.wallets.external).toBe(3); // CREATOR (external on Y), ours and stranger (no ownership list configured)
  });

  it('says the figure is an upper bound when no ownership list is configured, and reports none when there is none', () => {
    expect(externalFlow([x1], new Set(), 'devnet').verdict).toBe('external wallets seen, ownership list not configured (upper bound)');
    expect(externalFlow([x3], new Set(['ours']), 'devnet').verdict).toBe('no external wallets seen');
    expect(externalFlow([], new Set(), 'devnet').wallets).toEqual({ total: 0, own: 0, external: 0, externalShare: null });
  });
});

describe('parseOwnWallets', () => {
  const ok = (s: string) => /^[A-Z]+$/.test(s);
  it('accepts commas and whitespace, ignores blanks, and rejects anything that is not an address', () => {
    expect([...parseOwnWallets(' AAA,BBB\nCCC ,, ', ok)]).toEqual(['AAA', 'BBB', 'CCC']);
    expect(parseOwnWallets(undefined, ok).size).toBe(0);
    expect(() => parseOwnWallets('AAA,not-an-address', ok)).toThrow(/OWN_WALLETS/);
  });
});
