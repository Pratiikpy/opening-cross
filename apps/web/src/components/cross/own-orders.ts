// Which price level each of the connected wallet's own orders sits at, for marking the book chart.
//
// The chain read of an open order gives its side and escrow but not its price (the price lives in the merged book, which is not
// attributed to an owner). The indexer records an open order's limit from its commit and a sealed bid's once it is revealed, so a mark
// can come from two places only, and a sealed bid that is still sealed never gets one:
//   - the price the indexer recorded (an open order's commit, or a sealed bid's reveal: public from then on),
//   - the price this browser saved when it placed an open order,
//   - for a sealed bid that is still sealed: nothing. It is never drawn, so the chart cannot reveal it.
// An order whose price is not known is counted, not guessed at.
import type { OwnerOrder } from '../../lib/types';

export type OwnMark = { order: string; side: 'buy' | 'sell'; price: bigint; quantity: bigint | null };

export type OwnOrderInput = {
  address: string;
  side: 'buy' | 'sell';
  /** Sealed cross: the price is only public once the order is revealed. */
  sealed: boolean;
  revealed: boolean;
  /** Price and quantity the indexer recorded (revealed sealed orders only). */
  price: string | null;
  quantity: string | null;
  status?: OwnerOrder['status'];
};

/** The limit terms the indexer holds, by order address (GET /v1/owners/:owner/orders). Null where it holds none: a sealed order that is not yet revealed, or one it has not seen yet. */
export function indexedTerms(rows: readonly { address: string; price: string | null; quantity: string | null }[]): Map<string, { price: string | null; quantity: string | null }> {
  return new Map(rows.map((r) => [r.address, { price: r.price, quantity: r.quantity }]));
}

export type Terms = { side: 'buy' | 'sell'; price: string; quantity: string };

export type OwnMarks = {
  marks: OwnMark[];
  /** Orders that rest in the book at a price this browser does not know. */
  unlocated: number;
  /** Sealed orders that stay off the chart until they are revealed. */
  hidden: number;
};

/** Orders that are no longer resting (cancelled or already claimed) are not in the book and get no mark. */
export function deriveMarks(orders: readonly OwnOrderInput[], saved: Readonly<Record<string, Terms>>, cleared: boolean): OwnMarks {
  const marks: OwnMark[] = [];
  let unlocated = 0;
  let hidden = 0;
  for (const o of orders) {
    if (o.status === 'cancelled') continue;
    if (o.sealed && !o.revealed) {
      hidden += 1;
      continue;
    }
    const t = saved[o.address];
    const price = o.price ?? (o.sealed ? null : (t?.price ?? null));
    if (price === null) {
      // After the cross has cleared the book is a record of what happened; an unknown price is still unknown.
      if (!(cleared && o.status === 'claimed')) unlocated += 1;
      continue;
    }
    marks.push({ order: o.address, side: o.side, price: BigInt(price), quantity: o.quantity !== null ? BigInt(o.quantity) : t ? BigInt(t.quantity) : null });
  }
  return { marks, unlocated, hidden };
}

const key = (cross: string, owner: string) => `ob:terms:${cross}:${owner}`;

export function loadTerms(cross: string, owner: string): Record<string, Terms> {
  try {
    const raw = localStorage.getItem(key(cross, owner));
    return raw ? (JSON.parse(raw) as Record<string, Terms>) : {};
  } catch {
    return {};
  }
}

/** Remembers what an open order was placed at, in this browser only, so the chart can mark it. */
export function rememberTerms(cross: string, owner: string, order: string, terms: Terms): void {
  try {
    localStorage.setItem(key(cross, owner), JSON.stringify({ ...loadTerms(cross, owner), [order]: terms }));
  } catch {
    // Storage can be unavailable; the order is unaffected and simply goes unmarked.
  }
}
