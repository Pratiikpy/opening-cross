// The request-preview-confirm step of the order ticket: everything a person can know before signing, computed
// from the live book. Pure and exact (bigints end to end, the same rounding as cross_core), so the page can
// show it and the tests can pin it.
import type { BookResponse, CrossDetail } from '../../lib/types';
import { type Market, buyerPays } from '../../lib/units';
import { type Cleared, type Side, simulateAgainstIndicative } from './clearing';

/** What the order costs or pays if it is filled in full at `price`. */
export type Outcome = {
  price: bigint;
  /** Buy: quote atoms paid. Sell: quote atoms received after the seller fee. */
  quote: bigint;
  /** Buy: quote atoms of the escrow that come back. Sell: the seller fee withheld. */
  other: bigint;
};

export type OrderPreview = {
  side: Side;
  /** Sealed crosses hide the book, so only what the order itself fixes is shown. */
  hidden: boolean;
  escrow: bigint;
  /** Buy orders lock quote tokens; sell orders lock the tokens being sold. */
  escrowIs: 'quote' | 'base';
  indicative: bigint | null;
  /** Filled in full at today's indicative price. Null when there is none, or when the limit does not reach it. */
  best: Outcome | null;
  bestMissing: 'no-indicative' | 'limit-does-not-reach' | 'hidden' | null;
  /** Filled in full at the limit itself: the least favourable price the order can trade at. */
  worst: Outcome;
  share: {
    /** Tokens the share is measured against. */
    against: bigint;
    /** Basis points of `against` that the order is. Above 10,000 means the order is larger than what is on offer. */
    bps: bigint;
    /** `buy`: of the supply offered at or below the limit. `sell`: of the supply on offer once this order is added. */
    of: 'offered-at-limit' | 'supply-with-order';
  } | null;
  shareMissing: 'nothing-offered' | null;
  impact: {
    before: bigint | null;
    after: bigint | null;
    /** Signed change of the indicative price, in basis points; null unless both prices exist. */
    bps: bigint | null;
    /** What the order would be filled for if the call closed right after it was added. */
    fill: bigint;
  } | null;
  impactMissing: 'hidden' | 'no-book' | 'unverified' | null;
};

export type PreviewInput = {
  side: Side;
  /** The limit price, on-chain units. */
  price: bigint;
  /** Base atoms. */
  quantity: bigint;
  market: Market;
  grid: CrossDetail['grid'];
  feeBps: number;
  sealed: boolean;
  book: Pick<BookResponse, 'levels' | 'indicative'> | null;
};

const BPS = 10_000n;

function outcome(side: Side, price: bigint, quantity: bigint, escrow: bigint, scale: bigint, feeBps: number): Outcome {
  if (side === 'buy') {
    const paid = buyerPays(quantity, price, scale);
    return { price, quote: paid, other: escrow - paid };
  }
  const gross = (quantity * price) / scale;
  const fee = (gross * BigInt(feeBps)) / BPS;
  return { price, quote: gross - fee, other: fee };
}

export function previewOrder(i: PreviewInput): OrderPreview {
  const scale = i.market.priceScale;
  const escrow = i.side === 'buy' ? buyerPays(i.quantity, i.price, scale) : i.quantity;
  const worst = outcome(i.side, i.price, i.quantity, escrow, scale, i.feeBps);
  const base = { side: i.side, escrow, escrowIs: i.side === 'buy' ? ('quote' as const) : ('base' as const), worst };

  const offeredAt = (limit: bigint | null) =>
    (i.book?.levels ?? []).reduce((sum, l) => (limit === null || BigInt(l.price) <= limit ? sum + BigInt(l.sell) : sum), 0n);

  if (i.sealed) {
    // Bids are hidden until revealed, so there is no indicative price to compare with. The supply side of the
    // book is public and the share can still be stated.
    const against = i.side === 'buy' ? offeredAt(i.price) : offeredAt(null) + i.quantity;
    return {
      ...base,
      hidden: true,
      indicative: null,
      best: null,
      bestMissing: 'hidden',
      share: against > 0n ? { against, bps: (i.quantity * BPS) / against, of: i.side === 'buy' ? 'offered-at-limit' : 'supply-with-order' } : null,
      shareMissing: against > 0n ? null : 'nothing-offered',
      impact: null,
      impactMissing: 'hidden',
    };
  }

  const indicative = i.book?.indicative ? BigInt(i.book.indicative.price) : null;
  let best: Outcome | null = null;
  let bestMissing: OrderPreview['bestMissing'] = null;
  if (indicative === null) bestMissing = 'no-indicative';
  else if (i.side === 'buy' ? indicative > i.price : indicative < i.price) bestMissing = 'limit-does-not-reach';
  else best = outcome(i.side, indicative, i.quantity, escrow, scale, i.feeBps);

  const against = i.side === 'buy' ? offeredAt(i.price) : offeredAt(null) + i.quantity;
  const share = against > 0n ? { against, bps: (i.quantity * BPS) / against, of: i.side === 'buy' ? ('offered-at-limit' as const) : ('supply-with-order' as const) } : null;

  let impact: OrderPreview['impact'] = null;
  let impactMissing: OrderPreview['impactMissing'] = null;
  if (!i.book) impactMissing = 'no-book';
  else {
    const sim = simulateAgainstIndicative(i.book, i.grid, { side: i.side, price: i.price, quantity: i.quantity });
    if (!sim) impactMissing = 'unverified';
    else impact = impactOf(sim.before, sim.after, sim.fill);
  }

  return { ...base, hidden: false, indicative, best, bestMissing, share, shareMissing: share ? null : 'nothing-offered', impact, impactMissing };
}

function impactOf(before: Cleared | null, after: Cleared | null, fill: bigint): NonNullable<OrderPreview['impact']> {
  const b = before?.price ?? null;
  const a = after?.price ?? null;
  // Signed basis points, rounded toward zero.
  const bps = b !== null && a !== null && b > 0n ? ((a - b) * BPS) / b : null;
  return { before: b, after: a, bps, fill };
}
