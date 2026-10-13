// Market-maker obligations and the rebate split (PRODUCT_FEATURES W7: "registered market makers with two-sided quote
// obligations, rebate pool: 25% of protocol fees on reopens").
//
// What is measured here is read from orders that exist on chain (the indexer's `orders` table): a maker that was
// registered is held to a published rule, cross by cross, and the rebate pool is split in proportion to the two-sided
// liquidity that met the rule. What stays outside this file: moving the rebate. The pool is a share of fees already
// paid to the protocol fee wallet, so paying it is an ordinary token transfer made by whoever holds that wallet; the
// split below is the instruction for it, and `docs/economics/FEE_MODEL.md` carries the figures.
import { REBATE_SHARE_BPS, mulBps } from '@opening-cross/fees';

export type MakerObligation = {
  /** Least base atoms on EACH side for a cross to count. */
  readonly minQuantity: bigint;
  /** Widest allowed distance between the best bid and the best ask, in basis points of their midpoint. */
  readonly maxSpreadBps: number;
};

export type MakerOrderFact = {
  readonly side: 'buy' | 'sell';
  readonly price: bigint;
  readonly quantity: bigint;
  /** `revealed` and `claimed` orders were in the book at the close; `cancelled` and `committed` (never revealed) were not. */
  readonly status: 'committed' | 'revealed' | 'cancelled' | 'claimed';
};

export type CrossCompliance = {
  readonly bestBid: bigint | null;
  readonly bestAsk: bigint | null;
  readonly buyQuantity: bigint;
  readonly sellQuantity: bigint;
  /** Spread in basis points of the midpoint, rounded up; null when a side is missing. */
  readonly spreadBps: number | null;
  readonly compliant: boolean;
  readonly reasons: readonly string[];
  /** min(bid notional, ask notional) in quote atoms (price units): what the rebate weighs. Zero when not compliant. */
  readonly weight: bigint;
};

export function crossCompliance(orders: readonly MakerOrderFact[], rule: MakerObligation, priceScale: bigint): CrossCompliance {
  const live = orders.filter((o) => o.status === 'revealed' || o.status === 'claimed');
  const buys = live.filter((o) => o.side === 'buy');
  const sells = live.filter((o) => o.side === 'sell');
  const sum = (xs: readonly MakerOrderFact[]) => xs.reduce((a, o) => a + o.quantity, 0n);
  const notional = (xs: readonly MakerOrderFact[]) => xs.reduce((a, o) => a + (o.quantity * o.price) / priceScale, 0n);
  const bestBid = buys.reduce<bigint | null>((m, o) => (m === null || o.price > m ? o.price : m), null);
  const bestAsk = sells.reduce<bigint | null>((m, o) => (m === null || o.price < m ? o.price : m), null);
  const buyQuantity = sum(buys);
  const sellQuantity = sum(sells);
  const reasons: string[] = [];
  if (buyQuantity < rule.minQuantity) reasons.push(`bids total ${buyQuantity}, the rule needs at least ${rule.minQuantity}`);
  if (sellQuantity < rule.minQuantity) reasons.push(`asks total ${sellQuantity}, the rule needs at least ${rule.minQuantity}`);
  let spreadBps: number | null = null;
  if (bestBid !== null && bestAsk !== null) {
    const mid2 = bestBid + bestAsk;
    if (bestAsk <= bestBid) {
      // The maker's own orders cross each other: that is not quoting a spread, it is trading with itself.
      reasons.push('the best bid is at or above the best ask');
    } else {
      spreadBps = Number(((bestAsk - bestBid) * 20_000n + mid2 - 1n) / mid2);
      if (spreadBps > rule.maxSpreadBps) reasons.push(`the spread is ${spreadBps} bps, the rule allows at most ${rule.maxSpreadBps}`);
    }
  }
  const compliant = reasons.length === 0;
  const weight = compliant ? (() => {
    const a = notional(buys);
    const b = notional(sells);
    return a < b ? a : b;
  })() : 0n;
  return { bestBid, bestAsk, buyQuantity, sellQuantity, spreadBps, compliant, reasons, weight };
}

/** The rebate pool of one cross: the rebate share of its protocol fee, for reopens only (other kinds fund no rebate). */
export function rebatePoolOf(kind: 'launch' | 'reopen' | 'tender' | 'recurring', protocolFee: bigint): bigint {
  return kind === 'reopen' ? mulBps(protocolFee, REBATE_SHARE_BPS) : 0n;
}

export type RebateSplit = { readonly shares: ReadonlyMap<string, bigint>; readonly undistributed: bigint };

/**
 * Splits `pool` by weight. Each share is floored, so the shares never add up to more than the pool; the remainder stays
 * undistributed instead of being handed to anyone. Makers with zero weight get nothing; the order of the input does not
 * change the result.
 */
export function splitRebate(pool: bigint, weights: ReadonlyMap<string, bigint>): RebateSplit {
  if (pool < 0n) throw new RangeError('a rebate pool cannot be negative');
  const total = [...weights.values()].reduce((a, w) => a + w, 0n);
  const shares = new Map<string, bigint>();
  if (total === 0n) return { shares, undistributed: pool };
  let paid = 0n;
  for (const [maker, w] of [...weights.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (w <= 0n) continue;
    const share = (pool * w) / total;
    if (share > 0n) {
      shares.set(maker, share);
      paid += share;
    }
  }
  return { shares, undistributed: pool - paid };
}
