// The coarse view of the final minutes (S1; ADR-0408). The program has no hidden or coarse final window: the book is public and exact
// at every moment, and it stays one click away. In the last minutes of an open call the page rounds what it leads with, a price range
// instead of a price and a bucket instead of a ratio, so a page does not flicker with every order. It is a display choice only.

export type Grid = { minPrice: string; tick: string; ticks: number };

/** How many ticks one bucket spans: about an eighth of the price grid, at least one tick. */
export const bucketTicks = (ticks: number): number => Math.max(1, Math.ceil(ticks / 8));

/** The range of grid prices, as `[low, high]`, that holds `price`. Both ends are on the grid and low <= price <= high. */
export function coarseRange(price: bigint, grid: Grid): { low: bigint; high: bigint } {
  const min = BigInt(grid.minPrice);
  const tick = BigInt(grid.tick);
  const width = BigInt(bucketTicks(grid.ticks));
  const last = min + BigInt(grid.ticks - 1) * tick;
  const p = price < min ? min : price > last ? last : price;
  const index = (p - min) / tick / width;
  const low = min + index * width * tick;
  const high = low + width * tick;
  return { low, high: high > last ? last : high };
}

export type Imbalance = { id: 'none' | 'only-buyers' | 'only-sellers' | 'far-more-offered' | 'more-offered' | 'balanced' | 'more-wanted' | 'far-more-wanted'; label: string };

/** Demand against supply in five coarse buckets, from the tokens wanted by buyers and offered by sellers. */
export function imbalance(wanted: bigint, offered: bigint): Imbalance {
  if (wanted === 0n && offered === 0n) return { id: 'none', label: 'No orders yet' };
  if (offered === 0n) return { id: 'only-buyers', label: 'Only buyers so far' };
  if (wanted === 0n) return { id: 'only-sellers', label: 'Only sellers so far' };
  const pct = (wanted * 100n) / offered;
  if (pct < 50n) return { id: 'far-more-offered', label: 'Far more offered than wanted' };
  if (pct < 90n) return { id: 'more-offered', label: 'More offered than wanted' };
  if (pct <= 110n) return { id: 'balanced', label: 'About balanced' };
  if (pct <= 200n) return { id: 'more-wanted', label: 'More wanted than offered' };
  return { id: 'far-more-wanted', label: 'Far more wanted than offered' };
}
