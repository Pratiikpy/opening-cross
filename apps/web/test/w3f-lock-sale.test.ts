import { describe, expect, it } from 'vitest';
import { type SaleCross, saleSentence, saleVenues } from '../src/lib/lock-sale';

const c = (o: Partial<SaleCross> = {}): SaleCross => ({ address: 'A', state: 'Live', supplyMode: 'escrow', baseMint: 'M', openTs: '100', closeTs: '1000', creator: 'X', ...o });

describe('where a released lock can be sold', () => {
  it('lists open and upcoming escrow crosses of the token, soonest to close first', () => {
    const v = saleVenues([c({ address: 'late', closeTs: '5000' }), c({ address: 'soon', closeTs: '900' }), c({ address: 'later', openTs: '800', closeTs: '9000' })], 'M', 500);
    expect(v.map((x) => [x.address, x.phase])).toEqual([['soon', 'open'], ['late', 'open'], ['later', 'upcoming']]);
  });
  it('leaves out another token, a settled cross, a cross whose call has closed, and one that mints its token', () => {
    expect(saleVenues([c({ baseMint: 'N' }), c({ state: 'Cleared' }), c({ closeTs: '400' }), c({ supplyMode: 'mint' }), c({ supplyMode: 'deferred-mint' })], 'M', 500)).toEqual([]);
  });
  it('says what there is', () => {
    expect(saleSentence([])).toMatch(/No cross of this token is taking orders/);
    expect(saleSentence(saleVenues([c()], 'M', 500))).toBe('1 cross is taking orders now. Place a sell order in one to sell the tokens you have released.');
    expect(saleSentence(saleVenues([c({ address: 'b', openTs: '800' })], 'M', 500))).toMatch(/No cross is taking orders yet, 1 more opens later/);
    expect(saleSentence(saleVenues([c(), c({ address: 'b', openTs: '800' })], 'M', 500))).toMatch(/1 cross is taking orders now and 1 more opens later/);
  });
});
