import { describe, expect, it } from 'vitest';
import type { CrossSummary } from '../src/lib/api';
import { type HoldingInput, type Mark, cohortIndex, latestPrints, markOf, nextCrossFor, redemptionPayout, signed, valueHolding } from '../src/lib/holder-value';
import { formatAtoms } from '../src/lib/units';

const summary = (over: Partial<CrossSummary> & { address: string }): CrossSummary => ({
  state: 'Finalized',
  creator: 'C',
  base_mint: 'BASE',
  quote_mint: 'QUOTE',
  open_ts: '1000',
  close_ts: '2000',
  reveal_end_ts: '2000',
  clearing_price: '1200000',
  matched: '500000000',
  orders_committed: 2,
  ...over,
});

describe('latestPrints', () => {
  it('picks the latest printed cross of each base mint and ignores live, no-print and unpriced ones', () => {
    const all = [
      summary({ address: 'a', close_ts: '2000' }),
      summary({ address: 'b', close_ts: '3000', clearing_price: '1500000' }),
      summary({ address: 'c', close_ts: '4000', state: 'Live', clearing_price: null }),
      summary({ address: 'd', close_ts: '5000', state: 'NoPrint', clearing_price: null }),
      summary({ address: 'e', close_ts: '6000', state: 'Finalized', clearing_price: null }),
      summary({ address: 'f', base_mint: 'OTHER', close_ts: '100' }),
    ];
    const p = latestPrints(all);
    expect(p.get('BASE')!.address).toBe('b');
    expect(p.get('OTHER')!.address).toBe('f');
    expect(p.size).toBe(2);
  });

  it('breaks a tie on close time by address, so the answer never depends on list order', () => {
    const x = latestPrints([summary({ address: 'a' }), summary({ address: 'b' })]);
    const y = latestPrints([summary({ address: 'b' }), summary({ address: 'a' })]);
    expect(x.get('BASE')!.address).toBe(y.get('BASE')!.address);
  });
});

describe('markOf', () => {
  const detail = { address: 'X', quoteMint: 'Q', decimals: { base: 6, quote: 6 }, grid: { minPrice: '1', tick: '1', ticks: 2, priceScale: '1000000' }, window: { openTs: '1', closeTs: '2000', revealEndTs: '2000' } };
  it('turns the clearing price into quote atoms per whole token', () => {
    const m = markOf({ ...detail, clearing: { price: '1200000', matched: '600000000', rationed: 'none' } })!;
    expect(m.perToken).toBe(1_200_000n);
    expect(m.matched).toBe(600_000_000n);
    expect(m.closeTs).toBe(2000);
  });
  it('handles a base token with more decimals than the price scale', () => {
    const m = markOf({ ...detail, decimals: { base: 9, quote: 6 }, grid: { ...detail.grid, priceScale: '1000000000' }, clearing: { price: '1500000000', matched: '1', rationed: 'none' } })!;
    // 1.5e9 / 1e9 * 1e9 = 1.5e9 quote atoms per whole token with 6-decimal quote: 1500 quote tokens per token.
    expect(m.perToken).toBe(1_500_000_000n);
  });
  it('has no mark for a cross that did not print', () => {
    expect(markOf({ ...detail, clearing: null })).toBeNull();
  });
});

describe('valueHolding', () => {
  const mark: Mark = { cross: 'X', quoteMint: 'Q', quoteDecimals: 6, baseDecimals: 6, perToken: 1_500_000n, closeTs: 2000, matched: 1n };
  const base = (over: Partial<HoldingInput> = {}): HoldingInput => ({ mint: 'BASE', decimals: 6, held: 1_000_000_000n, bought: [{ quoteMint: 'Q', tokens: 1_000_000_000n, paid: 1_200_000_000n }], sold: 0n, mark, ...over });

  it('marks a holding at the last clearing price and shows the result against what was paid', () => {
    const v = valueHolding(base());
    expect(v.value).toBe(1_500_000_000n); // 1000 tokens at 1.5
    expect(v.averagePaid).toBe(1_200_000n); // paid 1.2 each
    expect(v.result).toBe(300_000_000n); // +300
    expect(v.resultTokens).toBe(1_000_000_000n);
    expect(v.holdsOther).toBe(false);
  });

  it('covers only the tokens that were bought through crosses and are still held', () => {
    const v = valueHolding(base({ held: 400_000_000n }));
    expect(v.value).toBe(600_000_000n);
    expect(v.resultTokens).toBe(400_000_000n);
    expect(v.result).toBe(120_000_000n); // 400 * (1.5 - 1.2)
    const more = valueHolding(base({ held: 1_500_000_000n }));
    expect(more.resultTokens).toBe(1_000_000_000n);
    expect(more.result).toBe(300_000_000n);
    expect(more.value).toBe(2_250_000_000n);
    expect(more.holdsOther).toBe(true);
  });

  it('shows no result when the cost was paid in another quote token, and never mixes them', () => {
    const v = valueHolding(base({ bought: [{ quoteMint: 'OTHERQ', tokens: 1_000_000_000n, paid: 900_000_000n }] }));
    expect(v.value).toBe(1_500_000_000n);
    expect(v.averagePaid).toBeNull();
    expect(v.result).toBeNull();
  });

  it('combines purchases in the same quote token into one average', () => {
    const v = valueHolding(base({ held: 3_000_000_000n, bought: [{ quoteMint: 'Q', tokens: 1_000_000_000n, paid: 1_000_000_000n }, { quoteMint: 'Q', tokens: 2_000_000_000n, paid: 3_000_000_000n }] }));
    expect(v.averagePaid).toBe(1_333_333n); // 4000 / 3000, rounded down
    expect(v.result).toBe(500_000_000n); // worth 4500, cost 4000
  });

  it('reports nothing it cannot know: no balance, no mark, nothing bought', () => {
    expect(valueHolding(base({ held: null })).value).toBeNull();
    expect(valueHolding(base({ held: null })).result).toBeNull();
    const none = valueHolding(base({ mark: null }));
    expect(none.value).toBeNull();
    expect(none.result).toBeNull();
    const gift = valueHolding(base({ bought: [] }));
    expect(gift.value).toBe(1_500_000_000n);
    expect(gift.result).toBeNull();
    expect(gift.holdsOther).toBe(true);
  });

  it('shows a loss with its sign', () => {
    const v = valueHolding(base({ bought: [{ quoteMint: 'Q', tokens: 1_000_000_000n, paid: 2_000_000_000n }] }));
    expect(v.result).toBe(-500_000_000n);
    expect(signed(v.result!, 6, formatAtoms)).toBe('-500');
    expect(signed(300_000_000n, 6, formatAtoms)).toBe('+300');
    expect(signed(0n, 6, formatAtoms)).toBe('0');
  });
});

describe('nextCrossFor', () => {
  const live = (address: string, open: number, close: number, base = 'BASE') => summary({ address, state: 'Live', open_ts: String(open), close_ts: String(close), base_mint: base, clearing_price: null });
  it('prefers a cross that is open now, then the soonest to open, and ignores closed ones and other tokens', () => {
    const all = [live('past', 100, 200), live('later', 1000, 2000), live('soon', 600, 900), live('open', 400, 700), live('other', 450, 700, 'OTHER')];
    expect(nextCrossFor('BASE', all, 500)!.address).toBe('open');
    expect(nextCrossFor('BASE', all, 100)!.address).toBe('past');
    expect(nextCrossFor('BASE', [live('past', 100, 200)], 500)).toBeNull();
    expect(nextCrossFor('NONE', all, 500)).toBeNull();
  });
});

describe('redemptionPayout', () => {
  it('is the pro-rata share of the snapshot, rounded down, as the program pays it', () => {
    expect(redemptionPayout(250n, { vault: '1000', supply: '1000' })).toBe(250n);
    expect(redemptionPayout(1n, { vault: '10', supply: '3' })).toBe(3n);
    expect(redemptionPayout(3n, { vault: '10', supply: '3' })).toBe(10n);
    expect(redemptionPayout(5n, null)).toBeNull();
    expect(redemptionPayout(5n, { vault: '10', supply: '0' })).toBeNull();
  });
});

describe('cohortIndex', () => {
  const p = (baseMint: string, closeTs: number, perToken: bigint, quoteMint = 'Q') => ({ baseMint, quoteMint, closeTs, perToken });
  it('averages the latest-over-first return of assets that printed more than once, equal weighted', () => {
    const idx = cohortIndex([p('A', 1, 1_000_000n), p('A', 2, 1_200_000n), p('B', 1, 2_000_000n), p('B', 5, 1_000_000n), p('B', 3, 3_000_000n), p('C', 1, 5_000_000n)]);
    expect(idx.constituents.map((c) => [c.baseMint, c.prints])).toEqual([['A', 2], ['B', 3]]);
    // A: +20% (12000 bps); B: first 2.0 -> latest (close 5) 1.0 = 5000 bps; mean 8500.
    expect(idx.levelBps).toBe(8500n);
    expect(idx.unpriced).toBe(1);
  });
  it('keeps one asset in two quote tokens apart, and says nothing for no repeated print', () => {
    const idx = cohortIndex([p('A', 1, 1n * 10n ** 6n), p('A', 2, 2n * 10n ** 6n, 'OTHERQ')]);
    expect(idx.constituents).toEqual([]);
    expect(idx.levelBps).toBeNull();
    expect(idx.unpriced).toBe(2);
    expect(cohortIndex([]).levelBps).toBeNull();
  });
});
