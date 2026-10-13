import { describe, expect, it } from 'vitest';
import { bucketTicks, coarseRange, imbalance } from '../src/components/cross/holder-coarse';

const grid = { minPrice: '1000000', tick: '100000', ticks: 20 };

describe('coarseRange', () => {
  it('holds the price in a range of whole ticks on the grid', () => {
    expect(bucketTicks(20)).toBe(3);
    expect(bucketTicks(2)).toBe(1);
    expect(bucketTicks(256)).toBe(32);
    const r = coarseRange(1_650_000n, grid);
    expect(r).toEqual({ low: 1_600_000n, high: 1_900_000n });
    expect(r.low <= 1_650_000n && 1_650_000n <= r.high).toBe(true);
  });
  it('keeps a price on a bucket edge in the bucket it starts, and clamps to the grid', () => {
    expect(coarseRange(1_000_000n, grid)).toEqual({ low: 1_000_000n, high: 1_300_000n });
    expect(coarseRange(1_300_000n, grid)).toEqual({ low: 1_300_000n, high: 1_600_000n });
    // The last bucket ends at the last grid price (2.9), not past it.
    expect(coarseRange(2_900_000n, grid).high).toBe(2_900_000n);
    expect(coarseRange(5_000_000n, grid).high).toBe(2_900_000n);
    expect(coarseRange(1n, grid).low).toBe(1_000_000n);
  });
  it('gives a one-tick range on a coarse grid of two prices', () => {
    expect(coarseRange(2_000_000n, { minPrice: '1000000', tick: '1000000', ticks: 2 })).toEqual({ low: 2_000_000n, high: 2_000_000n });
  });
});

describe('imbalance', () => {
  const at = (w: number, o: number) => imbalance(BigInt(w), BigInt(o)).id;
  it('buckets demand against supply', () => {
    expect(at(0, 0)).toBe('none');
    expect(at(5, 0)).toBe('only-buyers');
    expect(at(0, 5)).toBe('only-sellers');
    expect(at(49, 100)).toBe('far-more-offered');
    expect(at(50, 100)).toBe('more-offered');
    expect(at(89, 100)).toBe('more-offered');
    expect(at(90, 100)).toBe('balanced');
    expect(at(110, 100)).toBe('balanced');
    expect(at(111, 100)).toBe('more-wanted');
    expect(at(200, 100)).toBe('more-wanted');
    expect(at(201, 100)).toBe('far-more-wanted');
  });
});
