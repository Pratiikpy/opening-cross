'use client';

import type { BookResponse } from '@/lib/types';
import { type Market, formatAtoms, formatPrice } from '@/lib/units';

/** Resting quantity by price: buys to the left of each row, sells to the right, clearing row marked. */
export function BookChart({ book, market, clearing }: { book: BookResponse | null; market: Market; clearing: string | null }) {
  if (!book) return <p className="text-sm text-muted">Loading the book…</p>;
  if (book.levels.length === 0) return <p className="text-sm text-muted">{book.disclosure === 'sealed' ? 'No revealed bids yet. Sealed bids show here as they are revealed.' : 'No orders yet.'}</p>;
  const levels = [...book.levels].sort((a, b) => (BigInt(b.price) > BigInt(a.price) ? 1 : -1));
  const max = levels.reduce((m, l) => [BigInt(l.buy), BigInt(l.sell), m].reduce((a, b) => (a > b ? a : b)), 1n);
  const pct = (v: string) => `${Number((BigInt(v) * 1000n) / max) / 10}%`;
  return (
    <div>
      <div className="mb-2 grid grid-cols-[1fr_5.5rem_1fr] gap-2 font-mono text-[11px] uppercase tracking-wider text-muted">
        <span className="text-right">Buy</span>
        <span className="text-center">Price</span>
        <span>Sell</span>
      </div>
      <ul className="space-y-1 font-mono text-xs" aria-label="Order book by price">
        {levels.map((l) => {
          const at = l.price === clearing;
          return (
            <li key={l.price} className={`grid grid-cols-[1fr_5.5rem_1fr] items-center gap-2 ${at ? 'font-medium' : ''}`}>
              <span className="flex h-5 items-center justify-end rounded-sm bg-surface" title={`${formatAtoms(BigInt(l.buy), market.baseDecimals)} to buy from ${l.buyOrders} orders`}>
                <span className="h-5 rounded-sm bg-ink" style={{ width: pct(l.buy) }} />
              </span>
              <span className={`text-center ${at ? 'rounded-sm bg-accent-fill text-on-accent' : ''}`}>{formatPrice(BigInt(l.price), market)}</span>
              <span className="flex h-5 items-center rounded-sm bg-surface" title={`${formatAtoms(BigInt(l.sell), market.baseDecimals)} to sell from ${l.sellOrders} orders`}>
                <span className="h-5 rounded-sm bg-border-strong" style={{ width: pct(l.sell) }} />
              </span>
            </li>
          );
        })}
      </ul>
      <p className="mt-3 text-xs text-muted">{book.note}</p>
    </div>
  );
}
