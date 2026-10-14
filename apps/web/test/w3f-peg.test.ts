import { describe, expect, it } from 'vitest';
import { isPegged, pegPrice } from '../src/lib/peg';

const grid = { minPrice: '1000000', tick: '100000', ticks: 20 };

describe('pegged to the open', () => {
  it('a buy takes the top of the grid and a sell the bottom', () => {
    expect(pegPrice(grid, 'buy')).toBe(2_900_000n);
    expect(pegPrice(grid, 'sell')).toBe(1_000_000n);
  });
  it('knows whether a typed limit is the peg', () => {
    expect(isPegged(grid, 'buy', 2_900_000n)).toBe(true);
    expect(isPegged(grid, 'buy', 2_800_000n)).toBe(false);
    expect(isPegged(grid, 'sell', 'Enter a price')).toBe(false);
    expect(isPegged(grid, 'sell', null)).toBe(false);
  });
});
