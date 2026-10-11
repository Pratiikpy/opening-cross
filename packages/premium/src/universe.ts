// Which stock tokens to measure: genuine xStocks (checked against the issuer's own list through the authenticity
// registry) whose underlying has an independent reference, and that Jupiter can route.
import type { Book } from '@opening-cross/authenticity';
import { NoRouteError, type QuoteFn } from './sources/jupiter.js';
import { USDC_MINT } from './collect.js';
import type { Reference } from './types.js';

export interface UniverseEntry {
  readonly ticker: string;
  readonly symbol: string;
  readonly mint: string;
}

/**
 * Listed xStocks whose ticker has a reference. A ticker listed twice (a share class, a duplicate listing) is left out
 * rather than guessed at: the reference would not say which token it prices.
 */
export function candidates(book: Book, references: Iterable<Reference>): UniverseEntry[] {
  const have = new Set<string>();
  for (const r of references) have.add(r.ticker);
  const byTicker = new Map<string, UniverseEntry[]>();
  for (const e of book.entries) {
    if (e.mint.family !== 'xstock' || !e.mint.ticker || !have.has(e.mint.ticker)) continue;
    byTicker.set(e.mint.ticker, [...(byTicker.get(e.mint.ticker) ?? []), { ticker: e.mint.ticker, symbol: e.mint.symbol, mint: e.mint.mint }]);
  }
  return [...byTicker.values()].filter((l) => l.length === 1).map((l) => l[0] as UniverseEntry).sort((a, b) => a.ticker.localeCompare(b.ticker));
}

/** Keeps the candidates Jupiter can route a $1,000 buy for, with the reason each other one was dropped. */
export async function routable(quote: QuoteFn, entries: readonly UniverseEntry[], paceMs = 250): Promise<{ kept: UniverseEntry[]; dropped: { entry: UniverseEntry; reason: string }[] }> {
  const kept: UniverseEntry[] = [];
  const dropped: { entry: UniverseEntry; reason: string }[] = [];
  for (const entry of entries) {
    try {
      await quote(USDC_MINT, entry.mint, 1_000_000_000n);
      kept.push(entry);
    } catch (e) {
      dropped.push({ entry, reason: e instanceof NoRouteError ? 'no route' : `quote failed: ${e instanceof Error ? e.message : String(e)}` });
    }
    await new Promise((r) => setTimeout(r, paceMs));
  }
  return { kept, dropped };
}
