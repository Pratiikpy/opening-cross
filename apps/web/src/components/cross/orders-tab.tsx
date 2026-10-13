import type { CrossDetail } from '@/lib/types';
import { type Market, formatAtoms, formatPrice, shortAddress } from '@/lib/units';
import type { OrderRecord } from './order-record';
import type { Phase } from './timeline';

function statusOf(o: OrderRecord, cross: CrossDetail): string {
  if (o.status === 'cancelled') return 'Cancelled';
  if (o.status === 'claimed') return cross.clearing ? (o.fill && BigInt(o.fill) > 0n ? 'Filled' : 'Not filled, refunded') : 'Refunded';
  if (o.status === 'revealed') return 'Revealed';
  return o.sealed ? 'Not revealed' : 'In the book';
}

/** Every order the indexer has recorded for this cross. Sealed orders stay out of the list until the reveal window ends. */
export function OrdersTab({ cross, orders, loaded, phase, market: m, owner }: { cross: CrossDetail; orders: OrderRecord[] | null; loaded: boolean; phase: Phase; market: Market; owner: string | null }) {
  const head = (
    <h2 id="orders-h" className="font-mono text-xs uppercase tracking-widest text-muted">
      Orders in this cross
    </h2>
  );
  if (cross.disclosure === 'sealed' && (phase === 'upcoming' || phase === 'open' || phase === 'reveal')) {
    return (
      <section aria-labelledby="orders-h">
        {head}
        <p className="mt-3 text-sm text-muted" data-testid="orders-sealed">
          {cross.orders.total} order{cross.orders.total === 1 ? ' is' : 's are'} in this cross. Their sides and sizes stay hidden until the reveal window ends, so nobody can read the book before it closes. Your own orders are listed in the panel beside this one.
        </p>
      </section>
    );
  }
  if (!orders) {
    return (
      <section aria-labelledby="orders-h">
        {head}
        <p role="status" className="mt-3 text-sm text-muted">
          {loaded ? 'The orders could not be loaded right now.' : 'Loading the orders…'}
        </p>
      </section>
    );
  }
  if (orders.length === 0) {
    return (
      <section aria-labelledby="orders-h">
        {head}
        <p className="mt-3 text-sm text-muted">No orders have been recorded in this cross.</p>
      </section>
    );
  }
  const showPrice = orders.some((o) => o.price !== null);
  const locked = (o: OrderRecord) => (o.side === 'buy' ? formatAtoms(BigInt(o.escrow), m.quoteDecimals) : formatAtoms(BigInt(o.escrow), m.baseDecimals));
  return (
    <section aria-labelledby="orders-h">
      {head}
      <div role="region" aria-label="Orders in this cross" tabIndex={0} className="mt-3 overflow-x-auto">
        <table className="w-full min-w-[520px] text-left text-sm" data-testid="cross-orders">
          <thead className="font-mono text-xs uppercase tracking-wider text-muted">
            <tr>
              <th scope="col" className="py-2 pr-3 font-normal">#</th>
              <th scope="col" className="py-2 pr-3 font-normal">Side</th>
              <th scope="col" className="py-2 pr-3 font-normal">Owner</th>
              {showPrice ? (
                <th scope="col" className="py-2 pr-3 text-right font-normal">Limit</th>
              ) : null}
              <th scope="col" className="py-2 pr-3 text-right font-normal">Locked</th>
              <th scope="col" className="py-2 pr-3 text-right font-normal">Filled</th>
              <th scope="col" className="py-2 font-normal">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {orders.map((o) => {
              const mine = owner !== null && o.owner === owner;
              return (
                <tr key={o.address} className={mine ? 'bg-surface' : undefined} data-mine={mine || undefined}>
                  <td className="py-2.5 pr-3 font-mono text-xs text-muted">{o.idx}</td>
                  <td className="py-2.5 pr-3 capitalize">{o.side}</td>
                  <td className="py-2.5 pr-3 font-mono text-xs">
                    {shortAddress(o.owner)}
                    {mine ? <span className="ml-2 rounded-full bg-accent-fill px-2 py-0.5 font-sans text-[11px] text-on-accent">You</span> : null}
                  </td>
                  {showPrice ? <td className="py-2.5 pr-3 text-right font-mono text-xs">{o.price !== null ? formatPrice(BigInt(o.price), m) : '—'}</td> : null}
                  <td className="py-2.5 pr-3 text-right font-mono text-xs">
                    {locked(o)} <span className="text-muted">{o.side === 'buy' ? 'quote' : 'tokens'}</span>
                  </td>
                  <td className="py-2.5 pr-3 text-right font-mono text-xs">{o.fill !== null ? `${formatAtoms(BigInt(o.fill), m.baseDecimals)}` : '—'}</td>
                  <td className="py-2.5">{statusOf(o, cross)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-xs text-muted">
        “Locked” is what the order put in escrow: quote tokens for a buy, the tokens being sold for a sell. The record does not carry an order’s limit price (see the Book tab for the totals at each price), except for sealed bids once they are revealed.
      </p>
    </section>
  );
}
