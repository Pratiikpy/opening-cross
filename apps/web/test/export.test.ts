import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FIGURE_COLUMNS, csvField, figureRows, figuresCsv, toCsv } from '../src/app/export/figures';
import { type CrossFacts, NOTICE, ORDER_COLUMNS, orderRow, ordersCsv } from '../src/app/export/orders-csv';
import { finalWindow } from '../src/components/cross/final-window';
import { deriveMarks, indexedTerms } from '../src/components/cross/own-orders';
import type { OwnerOrder } from '../src/lib/types';

const read = (p: string) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));
// The four public sources as the live devnet API served them on 2026-10-13.
const inputs = { stats: read('./fixtures/stats.json'), execution: read('./fixtures/metrics-execution.json'), fairness: read('./fixtures/metrics-fairness.json'), flow: read('./fixtures/metrics-flow.json') };

describe('public figures', () => {
  const { rows, missing } = figureRows(inputs);
  it('has a row for every source, each with a sample size, a unit and a method', () => {
    expect(missing).toEqual([]);
    expect(new Set(rows.map((r) => r.source))).toEqual(new Set(['/v1/stats', '/v1/metrics/execution', '/v1/metrics/fairness', '/v1/metrics/external-flow']));
    for (const r of rows) {
      expect(r.sampleSize, r.metric).not.toBe('');
      expect(r.unit, r.metric).not.toBe('');
      expect(r.method, r.metric).not.toBe('');
    }
    expect(new Set(rows.map((r) => r.metric)).size).toBe(rows.length);
  });
  it('carries the API\'s own numbers unchanged', () => {
    const v = (m: string) => rows.find((r) => r.metric === m)!.value;
    expect(v('crosses_total')).toBe(String(inputs.stats.crosses_total));
    expect(v('bids_filled')).toBe(String(inputs.execution.bids.filled));
    expect(rows.find((r) => r.metric === 'bids_filled')!.sampleSize).toBe(String(inputs.execution.bids.placed));
    expect(v('wallets_external')).toBe(String(inputs.flow.wallets.external));
  });
  it('leaves a figure with no data empty instead of writing zero, and names a source that did not answer', () => {
    const none = JSON.parse(JSON.stringify(inputs));
    none.execution.priceImprovement.bps.median = null;
    const out = figureRows({ ...none, flow: null });
    expect(out.rows.find((r) => r.metric === 'price_improvement_median_bps')!.value).toBe('');
    expect(out.missing).toEqual(['/v1/metrics/external-flow']);
    expect(out.rows.some((r) => r.source === '/v1/metrics/external-flow')).toBe(false);
  });
  it('writes a CSV that parses back to the same rows', () => {
    const text = figuresCsv(rows, 'devnet', '2026-10-13T00:00:00.000Z');
    const lines = text.trimEnd().split('\r\n');
    expect(lines[0]).toBe(FIGURE_COLUMNS.join(','));
    expect(lines).toHaveLength(rows.length + 1);
    expect(parseCsv(text)[1]).toEqual([rows[0]!.metric, rows[0]!.value, rows[0]!.unit, rows[0]!.sampleSize, rows[0]!.sampleUnit, rows[0]!.method, rows[0]!.source, 'devnet', '2026-10-13T00:00:00.000Z']);
  });
});

describe('csv escaping', () => {
  it('quotes commas, quotes and newlines and doubles inner quotes', () => {
    expect(csvField('a,b')).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField('a\nb')).toBe('"a\nb"');
    expect(csvField('plain')).toBe('plain');
  });
  it('defuses a cell a spreadsheet would run as a formula, but keeps negative numbers', () => {
    expect(csvField('=1+1')).toBe("'=1+1");
    expect(csvField('+cmd')).toBe("'+cmd");
    expect(csvField('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvField('-cmd')).toBe("'-cmd");
    expect(csvField('-12.5')).toBe('-12.5');
  });
  it('round-trips awkward fields', () => {
    const rows = [['a,b', 'c"d', 'e\r\nf', '']];
    expect(parseCsv(toCsv(['x', 'y', 'z', 'w'], rows))[1]).toEqual(rows[0]);
  });
});

describe('wallet orders csv', () => {
  const cross: CrossFacts = { state: 'Finalized', disclosure: 'open', baseMint: 'BASE', quoteMint: 'QUOTE', priceScale: '1000000', decimals: { base: 6, quote: 6 }, clearing: { price: '1200000' } };
  const claimed: OwnerOrder = { cross_address: 'CROSS', idx: 0, address: 'ORDER', side: 'buy', escrow: '2250000000', sealed: false, price: '1500000', quantity: '1500000000', status: 'claimed', fill: '1500000000', quote_out: '450000000', base_out: '1500000000', fee: '0' };
  const ev = { placedAt: '2026-10-12T03:19:35.000Z', placedTx: 'TXA', settledAt: '2026-10-12T03:29:57.000Z', settledTx: 'TXB' };
  const col = (row: string[], name: string) => row[ORDER_COLUMNS.indexOf(name as never)];

  it('writes a filled buy in tokens and in atoms, the real order from the live cross 5UfrmxAv', () => {
    const r = orderRow(claimed, cross, ev, 'devnet');
    expect(r).toHaveLength(ORDER_COLUMNS.length);
    expect(col(r, 'limit_price')).toBe('1.5');
    expect(col(r, 'quantity_tokens')).toBe('1500');
    expect(col(r, 'clearing_price')).toBe('1.2');
    expect(col(r, 'filled_tokens')).toBe('1500');
    expect(col(r, 'quote_escrowed')).toBe('2250');
    expect(col(r, 'quote_paid')).toBe('1800');
    expect(col(r, 'quote_returned')).toBe('450');
    expect(col(r, 'quote_received')).toBe('');
    expect(col(r, 'quote_out_atoms')).toBe('450000000');
    expect(col(r, 'placed_tx')).toBe('TXA');
    expect(col(r, 'notice')).toBe(NOTICE);
    // paid = fill x clearing price, the rule's own arithmetic, so the file can be checked against itself
    expect(Number(col(r, 'quote_paid'))).toBeCloseTo(Number(col(r, 'filled_tokens')) * Number(col(r, 'clearing_price')), 6);
  });
  it('leaves what the index does not hold empty: an unrevealed price, an unsettled fill, a missing event time', () => {
    const sealed: OwnerOrder = { ...claimed, sealed: true, price: null, quantity: null, status: 'committed', fill: null, quote_out: null, base_out: null };
    const r = orderRow(sealed, { ...cross, state: 'Live', clearing: null }, { placedAt: null, placedTx: null, settledAt: null, settledTx: null }, 'devnet');
    for (const name of ['limit_price', 'quantity_tokens', 'clearing_price', 'filled_tokens', 'quote_paid', 'quote_returned', 'placed_at_utc', 'settled_tx']) expect(col(r, name), name).toBe('');
    expect(col(r, 'quote_escrowed')).toBe('2250');
  });
  it('writes a sell by what it received and its fee', () => {
    const sell: OwnerOrder = { ...claimed, side: 'sell', escrow: '1000000000', quantity: '1000000000', fill: '600000000', quote_out: '717000000', base_out: '400000000', fee: '3000000' };
    const r = orderRow(sell, cross, ev, 'devnet');
    expect(col(r, 'quote_received')).toBe('717');
    expect(col(r, 'fee_quote')).toBe('3');
    expect(col(r, 'quote_escrowed')).toBe('');
    expect(col(r, 'tokens_received')).toBe('');
  });
  it('is a valid CSV with the header first, and an empty wallet yields the header only', () => {
    expect(parseCsv(ordersCsv([orderRow(claimed, cross, ev, 'devnet')]))).toHaveLength(2);
    expect(ordersCsv([])).toBe(`${ORDER_COLUMNS.join(',')}\r\n`);
  });
});

describe('final window', () => {
  const open = 1_000n;
  it('is a quarter of the call, never more than ten minutes, and inactive before it starts or after it ends', () => {
    const close = open + 3600n; // a one hour call: ten minutes, since a quarter would be fifteen
    expect(finalWindow(open, close, close - 601n).active).toBe(false);
    expect(finalWindow(open, close, close - 600n)).toMatchObject({ active: true, remaining: 600n, length: 600n });
    expect(finalWindow(open, close, close - 1n).active).toBe(true);
    expect(finalWindow(open, close, close).active).toBe(false);
    expect(finalWindow(open, close, open - 5n).active).toBe(false);
    const short = open + 360n; // a six minute call: a quarter is 90 s
    expect(finalWindow(open, short, short - 91n).active).toBe(false);
    expect(finalWindow(open, short, short - 90n)).toMatchObject({ active: true, length: 90n });
  });
  it('never activates on a call with no length', () => {
    expect(finalWindow(open, open, open).active).toBe(false);
    expect(finalWindow('5', '3', 4n).active).toBe(false);
  });
});

describe('own open-order price from the index', () => {
  it('takes an open order\'s limit from the index and leaves an unknown one null', () => {
    const t = indexedTerms([
      { address: 'A', price: '1500000', quantity: '1000' },
      { address: 'B', price: null, quantity: null },
    ]);
    expect(t.get('A')).toEqual({ price: '1500000', quantity: '1000' });
    expect(t.get('B')).toEqual({ price: null, quantity: null });
    expect(t.get('C')).toBeUndefined();
  });
  it('marks an open order at the indexed price even when this browser saved nothing, and never marks a sealed one', () => {
    const marks = deriveMarks(
      [
        { address: 'A', side: 'buy', sealed: false, revealed: false, price: '1500000', quantity: '1000' },
        { address: 'S', side: 'buy', sealed: true, revealed: false, price: null, quantity: null },
        { address: 'U', side: 'sell', sealed: false, revealed: false, price: null, quantity: null },
      ],
      {},
      false,
    );
    expect(marks.marks.map((m) => [m.order, m.price])).toEqual([['A', 1_500_000n]]);
    expect(marks).toMatchObject({ hidden: 1, unlocated: 1 });
  });
});

/** A small RFC 4180 reader, written here so the test does not rely on the writer's own escaping rules. */
function parseCsv(text: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [];
  let f = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (q) {
      if (c === '"' && text[i + 1] === '"') (f += '"'), i++;
      else if (c === '"') q = false;
      else f += c;
    } else if (c === '"') q = true;
    else if (c === ',') (row.push(f), (f = ''));
    else if (c === '\r' && text[i + 1] === '\n') (row.push(f), out.push(row), (row = []), (f = ''), i++);
    else f += c;
  }
  if (f !== '' || row.length) (row.push(f), out.push(row));
  return out;
}
