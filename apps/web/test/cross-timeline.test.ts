import { describe, expect, it } from 'vitest';
import type { OrderRecord } from '../src/components/cross/order-record';
import { currentStage, stagesOf, workedExample } from '../src/components/cross/timeline';
import type { BookResponse, CrossDetail } from '../src/lib/types';

const market = { priceScale: 1_000_000n, baseDecimals: 6, quoteDecimals: 6 };

// Cross F6SHDwoT… as the live devnet API served it (GET /v1/crosses/:address, /book, /orders).
const finalized: CrossDetail = {
  address: 'F6SHDwoT2XW9FNYTQXhLkqk1sHbNKLrMYhJm1kSsUD9',
  state: 'Finalized',
  disclosure: 'open',
  kind: 'launch',
  supplyMode: 'mint',
  creator: '73YGjJZeeL2L3wK6RVzBTM13rxBRSQH8fGD3DRkh52dJ',
  baseMint: 'BFkYbAjZR9KEVkcsoAiEuxRfJaQo3KzEZJS1G8FkmoQa',
  quoteMint: '37NDUC3beEb7inUUpKeHD2Yrg5ZdvkuFNEw7AtETBLL1',
  window: { openTs: '1791854857', closeTs: '1791854982', revealEndTs: '1791854982' },
  grid: { minPrice: '1000000', tick: '100000', ticks: 20, priceScale: '1000000' },
  decimals: { base: 6, quote: 6 },
  fees: { protocolBps: 5, integratorBps: 20, integrator: '73YGjJZeeL2L3wK6RVzBTM13rxBRSQH8fGD3DRkh52dJ' },
  orders: { total: 2, open: 0, max: 16 },
  clearing: { price: '1300000', matched: '2800000000', rationed: 'sell' },
  noPrintReason: null,
  gateMint: null,
  oracleGuard: false,
  settlement: { settleDeadlineTs: '0', baseBound: true },
};
const book: BookResponse = {
  disclosure: 'open',
  levels: [
    { price: '1000000', buy: '0', sell: '1500000000', buyOrders: 0, sellOrders: 1 },
    { price: '1300000', buy: '1800000000', sell: '1500000000', buyOrders: 1, sellOrders: 1 },
    { price: '1600000', buy: '1000000000', sell: '0', buyOrders: 1, sellOrders: 0 },
  ],
  indicative: null,
  note: 'The book as it was cleared.',
};
const orders = [
  { idx: 0, address: 'BB7L', owner: 'a', side: 'buy', escrow: '1600000000', sealed: false, price: null, quantity: null, status: 'claimed', fill: '1000000000', quote_out: '300000000', base_out: '1000000000', fee: '0' },
  { idx: 1, address: '3HBn', owner: 'b', side: 'buy', escrow: '2340000000', sealed: false, price: null, quantity: null, status: 'claimed', fill: '1800000000', quote_out: '0', base_out: '1800000000', fee: '0' },
] as OrderRecord[];

describe('stagesOf', () => {
  it('puts a finalized cross at the last stage with all four done and the real window times on the first two', () => {
    const s = stagesOf(finalized, 'settled');
    expect(s.map((x) => x.status)).toEqual(['done', 'done', 'done', 'done']);
    expect(s[0]!.ts).toBe(1791854857n);
    expect(s[1]!.ts).toBe(1791854982n);
    // The API serves no time for settlement, so none is shown.
    expect(s[2]!.ts).toBeNull();
    expect(s[3]!.ts).toBeNull();
    expect(s.every((x) => x.tag === null)).toBe(true);
    expect(s[3]!.label).toBe('Finalized / paid');
  });

  it.each([
    ['upcoming', 0, 'Next'],
    ['open', 0, 'Now'],
    ['awaiting-settlement', 2, 'Now'],
  ] as const)('highlights the right stage while the cross is %s', (phase, index, tag) => {
    const live = { ...finalized, state: 'Live' as const, clearing: null };
    const s = stagesOf(live, phase);
    expect(s.map((x) => x.status).indexOf('current')).toBe(index);
    expect(s[index]!.tag).toBe(tag);
    expect(s.slice(0, index).every((x) => x.status === 'done')).toBe(true);
    expect(s.slice(index + 1).every((x) => x.status === 'upcoming')).toBe(true);
  });

  it('puts a sealed cross in the reveal window at the second stage and names when it ends', () => {
    const sealed = { ...finalized, state: 'Live' as const, clearing: null, disclosure: 'sealed' as const, window: { ...finalized.window, revealEndTs: '1791855282' } };
    expect(currentStage(sealed, 'reveal')).toBe(1);
    expect(stagesOf(sealed, 'reveal')[1]!.note).toMatch(/revealed until 2026-10-\d\d \d\d:\d\d UTC/);
  });

  it('says a cross with no print had no print, and names the reason', () => {
    const nop = { ...finalized, clearing: null, noPrintReason: 'BelowMinimumVolume' };
    const s = stagesOf(nop, 'settled');
    expect(s[2]!.note).toContain('no print');
    expect(s[2]!.note).toContain('below the minimum');
    expect(s[3]!.label).toBe('Finalized / refunded');
  });

  it('keeps a cleared cross waiting at the last stage until it is finalized', () => {
    const s = stagesOf({ ...finalized, state: 'Cleared' }, 'settled');
    expect(s.map((x) => x.status)).toEqual(['done', 'done', 'done', 'current']);
  });
});

describe('workedExample', () => {
  it('works the top bid of a finalized cross through to what it paid, and confirms it from the recorded order', () => {
    const e = workedExample(finalized, book, market, orders);
    expect(e.kind).toBe('result');
    expect(e.text).toBe(
      'A bid for 1,000 tokens with a limit of 1.6 was filled in full at 1.3. It paid 1,300 instead of the 1,600 put in escrow, so 300 came back. Every other order that trades gets the same 1.3.',
    );
  });

  it('uses the computed numbers when no recorded order is available', () => {
    expect(workedExample(finalized, book, market, null).text).toContain('paid 1,300 instead of the 1,600');
  });

  it('projects the same example for a live cross from the indicative price', () => {
    const live = { ...finalized, state: 'Live' as const, clearing: null };
    const b = { ...book, indicative: { price: '1300000', matched: '2800000000' } };
    const e = workedExample(live, b, market, null);
    expect(e.kind).toBe('projection');
    expect(e.text).toContain('would be filled in full at 1.3');
    expect(e.text).toContain('would pay 1,300');
  });

  it('describes pro rata filling for bids at the price when there is nothing above it', () => {
    const b: BookResponse = { ...book, levels: [{ price: '1200000', buy: '1500000000', sell: '1000000000', buyOrders: 2, sellOrders: 1 }] };
    const c = { ...finalized, clearing: { price: '1200000', matched: '1000000000', rationed: 'buy' as const } };
    const e = workedExample(c, b, market, null);
    expect(e.text).toContain('Bids at 1.2 (1,500 tokens in all)');
    expect(e.text).toContain('filled for about 66.6% of its size');
  });

  it('says a cross with no print did not print and why, with no invented price', () => {
    const e = workedExample({ ...finalized, clearing: null, noPrintReason: 'NoCross' }, book, market, orders);
    expect(e.kind).toBe('no-print');
    expect(e.text).toContain('did not print');
    expect(e.text).toContain('no buy order and sell order overlapped');
    expect(e.text).toContain('refunded in full');
  });

  it('offers no example while bids are sealed or when nothing crosses', () => {
    const sealed = { ...finalized, state: 'Live' as const, clearing: null, disclosure: 'sealed' as const };
    expect(workedExample(sealed, book, market).kind).toBe('none');
    expect(workedExample({ ...finalized, state: 'Live', clearing: null }, { ...book, indicative: null }, market).text).toContain('no price to work an example from');
    expect(workedExample(finalized, null, market).kind).toBe('none');
  });
});
