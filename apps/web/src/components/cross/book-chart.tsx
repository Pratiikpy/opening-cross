'use client';

import type { BookResponse } from '@/lib/types';
import { type Market, formatAtoms, formatPrice } from '@/lib/units';
import type { OwnMark, OwnMarks } from './own-orders';

const CHIP = 'absolute top-1/2 -translate-y-1/2 rounded-sm bg-accent-fill px-1 font-sans text-[10px] font-medium leading-4 text-on-accent';

function Swatch({ className }: { className: string }) {
  return <span className={`inline-block size-3 rounded-sm ${className}`} aria-hidden="true" />;
}

/**
 * Resting quantity by price: buys to the left of each row, sells to the right, the price it trades at marked,
 * quantities in tokens. The connected wallet's own orders are outlined and tagged "You" at their price; a sealed
 * order is never drawn, so the chart cannot give away a bid that has not been revealed.
 */
export function BookChart({
  book,
  market,
  clearing,
  clearingLabel = 'Price it trades at',
  own = { marks: [], unlocated: 0, hidden: 0 },
  connected = false,
}: {
  book: BookResponse | null;
  market: Market;
  clearing: string | null;
  clearingLabel?: string;
  own?: OwnMarks;
  connected?: boolean;
}) {
  if (!book) return <p className="text-sm text-muted">Loading the book…</p>;
  if (book.levels.length === 0 && own.marks.length === 0)
    return (
      <div>
        <p className="text-sm text-muted">{book.disclosure === 'sealed' ? 'No revealed bids yet. Sealed bids show here as they are revealed.' : 'No orders yet.'}</p>
        <Notes own={own} market={market} levels={[]} />
      </div>
    );
  const levels = [...book.levels].sort((a, b) => (BigInt(b.price) > BigInt(a.price) ? 1 : -1));
  const max = levels.reduce((m, l) => [BigInt(l.buy), BigInt(l.sell), m].reduce((a, b) => (a > b ? a : b)), 1n);
  const pct = (v: string) => `${Number((BigInt(v) * 1000n) / max) / 10}%`;
  const qty = (v: string) => (BigInt(v) === 0n ? '0' : formatAtoms(BigInt(v), market.baseDecimals, 2));
  const grid = 'grid grid-cols-[3.75rem_1fr_4.25rem_1fr_3.75rem] items-center gap-1.5 sm:grid-cols-[5rem_1fr_5.5rem_1fr_5rem] sm:gap-2';
  const at = (price: string, side: OwnMark['side']) => own.marks.filter((k) => k.price.toString() === price && k.side === side);
  const hint = (ks: OwnMark[], side: string) => (ks.length ? `Your ${side} order${ks.length > 1 ? 's are' : ' is'} at this price${ks.length === 1 && ks[0]!.quantity !== null ? `, for ${formatAtoms(ks[0]!.quantity, market.baseDecimals)} tokens` : ''}.` : '');
  return (
    <div>
      <ul className="mb-4 flex flex-wrap gap-x-5 gap-y-1.5 text-xs text-muted" aria-label="Legend">
        <li className="flex items-center gap-1.5">
          <Swatch className="bg-ink" /> Buy
        </li>
        <li className="flex items-center gap-1.5">
          <Swatch className="bg-border-strong" /> Sell
        </li>
        <li className="flex items-center gap-1.5">
          <Swatch className="bg-accent-fill" /> {clearingLabel}
        </li>
        {connected ? (
          <li className="flex items-center gap-1.5">
            <Swatch className="bg-bg ring-2 ring-inset ring-accent-fill" /> Your order
          </li>
        ) : null}
      </ul>
      <div className={`mb-2 ${grid} font-mono text-[11px] uppercase tracking-wider text-muted`} aria-hidden="true">
        <span className="col-span-2 text-right">Buy (tokens)</span>
        <span className="text-center">Price</span>
        <span className="col-span-2">Sell (tokens)</span>
      </div>
      <ul className="space-y-1 font-mono text-xs" aria-label="Order book by price">
        {levels.map((l) => {
          const isClearing = l.price === clearing;
          const mineBuy = at(l.price, 'buy');
          const mineSell = at(l.price, 'sell');
          return (
            <li key={l.price} className={`${grid} ${isClearing ? 'font-medium' : ''}`} data-price={l.price} data-mine={mineBuy.length + mineSell.length > 0 || undefined}>
              <span className="truncate text-right" title={`${formatAtoms(BigInt(l.buy), market.baseDecimals)} to buy from ${l.buyOrders} orders`}>
                {qty(l.buy)}
              </span>
              <span className={`relative flex h-5 items-center justify-end rounded-sm bg-surface ${mineBuy.length ? 'ring-2 ring-inset ring-accent-fill' : ''}`} aria-hidden="true">
                <span className="h-5 rounded-sm bg-ink" style={{ width: pct(l.buy) }} />
                {mineBuy.length ? <span className={`${CHIP} left-1`}>You</span> : null}
              </span>
              <span className={`text-center ${isClearing ? 'rounded-sm bg-accent-fill text-on-accent' : ''}`}>
                {formatPrice(BigInt(l.price), market)}
                {isClearing ? <span className="sr-only"> (the price it trades at)</span> : null}
                {mineBuy.length ? <span className="sr-only"> {hint(mineBuy, 'buy')}</span> : null}
                {mineSell.length ? <span className="sr-only"> {hint(mineSell, 'sell')}</span> : null}
              </span>
              <span className={`relative flex h-5 items-center rounded-sm bg-surface ${mineSell.length ? 'ring-2 ring-inset ring-accent-fill' : ''}`} aria-hidden="true">
                <span className="h-5 rounded-sm bg-border-strong" style={{ width: pct(l.sell) }} />
                {mineSell.length ? <span className={`${CHIP} right-1`}>You</span> : null}
              </span>
              <span className="truncate" title={`${formatAtoms(BigInt(l.sell), market.baseDecimals)} to sell from ${l.sellOrders} orders`}>
                {qty(l.sell)}
              </span>
            </li>
          );
        })}
      </ul>
      <Notes own={own} market={market} levels={levels.map((l) => l.price)} />
      <p className="mt-3 text-xs text-muted">{book.note}</p>
    </div>
  );
}

/** What the chart could not show about the wallet's own orders, and why. */
function Notes({ own, market, levels }: { own: OwnMarks; market: Market; levels: string[] }) {
  const missing = own.marks.filter((k) => !levels.includes(k.price.toString()));
  if (!own.hidden && !own.unlocated && missing.length === 0) return null;
  return (
    <div className="mt-3 space-y-1 text-xs text-muted" data-testid="own-notes">
      {missing.map((k) => (
        <p key={k.order}>
          Your {k.side} order at {formatPrice(k.price, market)} is not in the book yet.
        </p>
      ))}
      {own.hidden ? (
        <p>
          {own.hidden} of your sealed order{own.hidden === 1 ? '' : 's'} stay{own.hidden === 1 ? 's' : ''} off this chart until revealed, so the chart cannot give away your price.
        </p>
      ) : null}
      {own.unlocated ? (
        <p>
          {own.unlocated} of your order{own.unlocated === 1 ? '' : 's'} cannot be placed on the chart: the API does not publish an open order’s price, and this browser did not place {own.unlocated === 1 ? 'it' : 'them'}.
        </p>
      ) : null}
    </div>
  );
}
