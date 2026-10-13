import { describe, expect, it } from 'vitest';
import { type OwnOrderInput, deriveMarks } from '../src/components/cross/own-orders';

const o = (p: Partial<OwnOrderInput>): OwnOrderInput => ({ address: 'A', side: 'buy', sealed: false, revealed: false, price: null, quantity: null, ...p });

describe('deriveMarks', () => {
  it('marks an open order at the price this browser saved for it', () => {
    const r = deriveMarks([o({ address: 'A' })], { A: { side: 'buy', price: '1300000', quantity: '600000000' } }, false);
    expect(r).toEqual({ marks: [{ order: 'A', side: 'buy', price: 1_300_000n, quantity: 600_000_000n }], unlocated: 0, hidden: 0 });
  });

  it('counts, and never guesses at, an order whose price is not known', () => {
    expect(deriveMarks([o({ address: 'B' })], {}, false)).toEqual({ marks: [], unlocated: 1, hidden: 0 });
  });

  it('never marks a sealed order that has not been revealed, even if a price is on hand', () => {
    const r = deriveMarks([o({ address: 'S', sealed: true, revealed: false, price: '1500000', quantity: '1' })], { S: { side: 'buy', price: '1500000', quantity: '1' } }, false);
    expect(r.marks).toEqual([]);
    expect(r.hidden).toBe(1);
    expect(r.unlocated).toBe(0);
  });

  it('marks a sealed order once it is revealed, from the recorded price', () => {
    const r = deriveMarks([o({ address: 'S', sealed: true, revealed: true, side: 'sell', price: '1200000', quantity: '5' })], {}, false);
    expect(r.marks).toEqual([{ order: 'S', side: 'sell', price: 1_200_000n, quantity: 5n }]);
  });

  it('does not take a saved open-order price for a sealed order whose price the record lacks', () => {
    const r = deriveMarks([o({ address: 'S', sealed: true, revealed: true, price: null })], { S: { side: 'buy', price: '9', quantity: '1' } }, false);
    expect(r.marks).toEqual([]);
    expect(r.unlocated).toBe(1);
  });

  it('skips cancelled orders and does not count a settled order whose price is unknown', () => {
    const r = deriveMarks([o({ address: 'C', status: 'cancelled' }), o({ address: 'D', status: 'claimed' })], {}, true);
    expect(r).toEqual({ marks: [], unlocated: 0, hidden: 0 });
  });
});
