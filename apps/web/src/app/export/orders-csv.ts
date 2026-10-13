// A wallet's orders and fills as a CSV for its own records (R10). It reports what the chain index recorded for each order and
// the times and transactions of its events; it computes no gain, cost basis or tax. Amounts are written twice, as raw atoms and
// as decimals, so the file can be checked against the chain and read by a person.
import type { OwnerOrder } from '../../lib/types';
import { type Market, formatAtoms, formatPrice } from '../../lib/units';
import { toCsv } from './figures';

export const NOT_TAX_ADVICE = 'Not tax advice. This file lists what the Opening Cross index recorded for one wallet. It does not compute gains, losses, cost basis or any tax, and it may be incomplete or wrong. Check it against the chain and ask a qualified adviser.';

/** On every row, so the line travels with the data when a row is copied out of the file. */
export const NOTICE = 'Not tax advice. Records only: no gains, losses or cost basis are computed.';

export const ORDER_COLUMNS = [
  'cross',
  'order',
  'order_index',
  'side',
  'bids',
  'status',
  'placed_at_utc',
  'placed_tx',
  'settled_at_utc',
  'settled_tx',
  'base_mint',
  'quote_mint',
  'limit_price',
  'quantity_tokens',
  'clearing_price',
  'filled_tokens',
  'tokens_received',
  'quote_escrowed',
  'quote_paid',
  'quote_returned',
  'quote_received',
  'fee_quote',
  'quantity_atoms',
  'filled_atoms',
  'quote_escrowed_atoms',
  'quote_out_atoms',
  'base_out_atoms',
  'fee_atoms',
  'network',
  'notice',
] as const;

export type CrossFacts = {
  state: string;
  disclosure: 'open' | 'sealed';
  baseMint: string | null;
  quoteMint: string;
  priceScale: string;
  decimals: { base: number; quote: number };
  clearing: { price: string } | null;
};

export type OrderEvents = { placedAt: string | null; placedTx: string | null; settledAt: string | null; settledTx: string | null };

const empty = (v: unknown) => (v === null || v === undefined ? '' : String(v));

/** One CSV row of one order. A value the index does not have is left empty, never zero. */
export function orderRow(o: OwnerOrder, c: CrossFacts, ev: OrderEvents, network: string): string[] {
  const m: Market = { priceScale: BigInt(c.priceScale), baseDecimals: c.decimals.base, quoteDecimals: c.decimals.quote };
  const base = (v: string | null) => (v === null ? '' : formatAtoms(BigInt(v), m.baseDecimals));
  const quote = (v: bigint | string | null) => (v === null ? '' : formatAtoms(BigInt(v), m.quoteDecimals));
  const settled = o.status === 'claimed';
  const buy = o.side === 'buy';
  return [
    o.cross_address,
    o.address,
    String(o.idx),
    o.side,
    c.disclosure,
    o.status,
    empty(ev.placedAt),
    empty(ev.placedTx),
    empty(ev.settledAt),
    empty(ev.settledTx),
    empty(c.baseMint),
    c.quoteMint,
    o.price === null ? '' : formatPrice(BigInt(o.price), m).replace(/,/g, ''),
    base(o.quantity).replace(/,/g, ''),
    c.clearing ? formatPrice(BigInt(c.clearing.price), m).replace(/,/g, '') : '',
    settled ? base(o.fill).replace(/,/g, '') : '',
    settled && buy ? base(o.base_out).replace(/,/g, '') : '',
    buy ? quote(o.escrow).replace(/,/g, '') : '',
    settled && buy && o.quote_out !== null ? quote(BigInt(o.escrow) - BigInt(o.quote_out)).replace(/,/g, '') : '',
    settled && buy ? quote(o.quote_out).replace(/,/g, '') : '',
    settled && !buy ? quote(o.quote_out).replace(/,/g, '') : '',
    settled && !buy ? quote(o.fee).replace(/,/g, '') : '',
    empty(o.quantity),
    settled ? empty(o.fill) : '',
    empty(o.escrow),
    settled ? empty(o.quote_out) : '',
    settled ? empty(o.base_out) : '',
    settled ? empty(o.fee) : '',
    network,
    NOTICE,
  ];
}

/** The whole file: the header, then one row per order. */
export function ordersCsv(rows: readonly string[][]): string {
  return toCsv(ORDER_COLUMNS, rows);
}

export function csvFilename(owner: string): string {
  return `opening-bell-orders-${owner.slice(0, 8)}.csv`;
}
