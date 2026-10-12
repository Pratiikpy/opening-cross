import { useId } from 'react';
import { type BookResponse, type Market, formatAtoms, formatPrice } from '@opening-cross/client';

export type BookDepthProps = {
  book: BookResponse | null;
  market: Market;
  /** The price to mark, as on-chain price units: the clearing price when the cross has cleared, otherwise the indicative one. */
  clearing?: string | null;
  className?: string;
};

/**
 * The book as bars per price level: buy interest on the left, sell on the right. It is a picture of a table, and the table is there
 * for screen readers and for anyone who wants the exact numbers.
 */
export function BookDepth({ book, market, clearing, className }: BookDepthProps) {
  const id = useId();
  if (!book || book.levels.length === 0) {
    return <p className={`oc-muted${className ? ` ${className}` : ''}`}>{book?.disclosure === 'sealed' ? 'Sealed: the book appears once bids are revealed.' : 'The book is empty.'}</p>;
  }
  const max = book.levels.reduce((m, l) => {
    const big = BigInt(l.buy) > BigInt(l.sell) ? BigInt(l.buy) : BigInt(l.sell);
    return big > m ? big : m;
  }, 1n);
  const width = (v: string) => `${Number((BigInt(v) * 1000n) / max) / 10}%`;
  return (
    <figure className={`oc-depth${className ? ` ${className}` : ''}`} aria-labelledby={`${id}-cap`}>
      <figcaption id={`${id}-cap`} className="oc-eyebrow">
        Book by price (buy left, sell right)
      </figcaption>
      <div className="oc-depth-rows" aria-hidden="true">
        {book.levels.map((l) => (
          <div key={l.price} className="oc-depth-row" data-clearing={clearing === l.price}>
            <div className="oc-bar-wrap oc-bar-left"><div className="oc-bar oc-bar-buy" style={{ width: width(l.buy) }} /></div>
            <span className="oc-mono oc-depth-price">{formatPrice(BigInt(l.price), market)}</span>
            <div className="oc-bar-wrap"><div className="oc-bar oc-bar-sell" style={{ width: width(l.sell) }} /></div>
          </div>
        ))}
      </div>
      <table className="oc-sr-only">
        <caption>Resting orders by price level</caption>
        <thead>
          <tr><th scope="col">Price</th><th scope="col">Buy tokens</th><th scope="col">Buy orders</th><th scope="col">Sell tokens</th><th scope="col">Sell orders</th></tr>
        </thead>
        <tbody>
          {book.levels.map((l) => (
            <tr key={l.price}>
              <th scope="row">{formatPrice(BigInt(l.price), market)}</th>
              <td>{formatAtoms(BigInt(l.buy), market.baseDecimals)}</td>
              <td>{l.buyOrders}</td>
              <td>{formatAtoms(BigInt(l.sell), market.baseDecimals)}</td>
              <td>{l.sellOrders}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="oc-muted">{book.note}</p>
    </figure>
  );
}
