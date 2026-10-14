import { describe, expect, it } from 'vitest';
import type { OrderRecord } from '../src/components/cross/order-record';
import { PUSH_MAX, nextBatch, refundCandidates, refundOnly, refundSentence } from '../src/lib/refunds';

const order = (o: Partial<OrderRecord> = {}): OrderRecord => ({ idx: 0, address: 'a', owner: 'o', side: 'buy', escrow: '10', sealed: false, price: '1500000', quantity: '10', status: 'revealed', fill: null, quote_out: null, base_out: null, fee: null, ...o });
const printed = { state: 'Cleared' as const, clearing: { price: '1400000' } };
const noPrint = { state: 'NoPrint' as const, clearing: null };

describe('refundOnly', () => {
  it('every open order of a cross that did not print', () => {
    expect(refundOnly(noPrint, order())).toBe(true);
    expect(refundOnly(noPrint, order({ side: 'sell', price: '1' }))).toBe(true);
  });
  it('a buy strictly below the clearing price and a sell strictly above it', () => {
    expect(refundOnly(printed, order({ price: '1399999' }))).toBe(true);
    expect(refundOnly(printed, order({ side: 'sell', price: '1400001' }))).toBe(true);
  });
  it('never an order at or through the price, which may have a fill', () => {
    expect(refundOnly(printed, order({ price: '1400000' }))).toBe(false);
    expect(refundOnly(printed, order({ price: '1500000' }))).toBe(false);
    expect(refundOnly(printed, order({ side: 'sell', price: '1400000' }))).toBe(false);
    expect(refundOnly(printed, order({ side: 'sell', price: '1300000' }))).toBe(false);
  });
  it('a sealed bid that was never revealed has no price and no fill', () => {
    expect(refundOnly(printed, order({ price: null, sealed: true, status: 'committed' }))).toBe(true);
  });
  it('not an order already paid out, cancelled, or with a fill on record', () => {
    expect(refundOnly(noPrint, order({ status: 'claimed' }))).toBe(false);
    expect(refundOnly(noPrint, order({ status: 'cancelled' }))).toBe(false);
    expect(refundOnly(printed, order({ price: '1', fill: '5' }))).toBe(false);
  });
  it('nothing while the cross is live or has no clearing to compare with', () => {
    expect(refundOnly({ state: 'Live', clearing: null }, order())).toBe(false);
    expect(refundOnly({ state: 'Finalized', clearing: null }, order())).toBe(false);
  });
});

describe('batches and words', () => {
  it('lists candidates and cuts them into twelve', () => {
    const list = Array.from({ length: 30 }, (_, i) => order({ idx: i, address: String(i) }));
    expect(refundCandidates(noPrint, list)).toHaveLength(30);
    expect(refundCandidates(noPrint, null)).toEqual([]);
    const { batch, after } = nextBatch(refundCandidates(noPrint, list));
    expect(batch).toHaveLength(PUSH_MAX);
    expect(after).toBe(18);
    expect(nextBatch([1, 2])).toEqual({ batch: [1, 2], after: 0 });
  });
  it('says how many transactions it will take', () => {
    expect(refundSentence(0)).toMatch(/has been paid out/);
    expect(refundSentence(1)).toBe('1 order is refund-only and still waiting. Anyone can send it back: 1 transaction of up to 12 orders.');
    expect(refundSentence(25)).toMatch(/25 orders are refund-only.*3 transactions/);
  });
});
