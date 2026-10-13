// Ranking for GET /v1/router/quote. Pure: takes the quotes the router package produced and orders them.
//
// Every price is quote atoms per ONE WHOLE base token (10^baseDecimals atoms), so crosses with different price
// grids and a DEX route are comparable. Buyers round the price up and sellers round it down, as the cross does.
// Venues that fill the whole amount rank ahead of venues that fill part of it (a good price on a sliver is not
// best execution); within each group the better price wins for the side.
import type { Address } from '@solana/kit';
import type { CrossQuote, DexQuote } from '@opening-cross/router';

export type Side = 'buy' | 'sell';

export type RankedVenue =
  | {
      rank: number;
      venue: 'cross';
      cross: Address;
      disclosure: 'open' | 'sealed';
      closeTs: bigint;
      quoteAtoms: bigint;
      baseAtoms: bigint;
      pricePerBase: bigint;
      fill: 'full' | 'partial';
      feeBps: number;
      indicative: true;
      executableNow: false;
    }
  | {
      rank: number;
      venue: 'jupiter';
      quoteAtoms: bigint;
      baseAtoms: bigint;
      pricePerBase: bigint;
      fill: 'full' | 'partial';
      route: string[];
      priceImpactPct: string;
      contextSlot: bigint;
      executableNow: true;
    };

export type Excluded = { venue: 'cross' | 'jupiter' | 'meteora'; cross?: Address; reason: string };

export type Ranking = { venues: RankedVenue[]; excluded: Excluded[]; best: { venue: 'cross' | 'jupiter'; cross?: Address } | null; caveats: string[] };

const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

export const METEORA_EXCLUSION =
  'The router does not price Meteora pools directly. When a Meteora pool has liquidity for the pair, Jupiter may route through it; its route plan names every pool used.';

type Unranked = RankedVenue extends infer V ? (V extends unknown ? Omit<V, 'rank'> : never) : never;

export function rankVenues(p: {
  side: Side;
  /** Base atoms asked for. */
  amount: bigint;
  baseDecimals: number;
  /** Quotes for each live cross of the pair, in the order read. */
  crosses: CrossQuote[];
  /** The DEX quote, or `skipped` with the reason it was not asked. */
  dex: DexQuote | { skipped: string };
}): Ranking {
  const unit = 10n ** BigInt(p.baseDecimals);
  const price = (quote: bigint, base: bigint) => (p.side === 'buy' ? ceilDiv(quote * unit, base) : (quote * unit) / base);
  const venues: Unranked[] = [];
  const excluded: Excluded[] = [];

  if (p.crosses.length === 0) excluded.push({ venue: 'cross', reason: 'No live cross trades this pair.' });
  for (const c of p.crosses) {
    if (!c.available) {
      excluded.push({ venue: 'cross', cross: c.cross, reason: c.reason });
    } else if (c.indicative === null) {
      excluded.push({ venue: 'cross', cross: c.cross, reason: 'Sealed cross: the book is hidden until reveal, so there is no indicative price. You can still bid with a limit.' });
    } else if (!c.indicative.prints || c.indicative.fill === 0n) {
      excluded.push({ venue: 'cross', cross: c.cross, reason: 'On the current book this order would not trade: the cross would not print, or the book gives it no fill.' });
    } else {
      venues.push({
        venue: 'cross',
        cross: c.cross,
        disclosure: c.disclosure,
        closeTs: c.closeTs,
        quoteAtoms: c.indicative.quote,
        baseAtoms: c.indicative.fill,
        pricePerBase: price(c.indicative.quote, c.indicative.fill),
        fill: c.indicative.fill >= p.amount ? 'full' : 'partial',
        feeBps: c.feeBps,
        indicative: true,
        executableNow: false,
      });
    }
  }

  if ('skipped' in p.dex) excluded.push({ venue: 'jupiter', reason: p.dex.skipped });
  else if (!p.dex.available) excluded.push({ venue: 'jupiter', reason: p.dex.reason });
  else if (p.dex.base === 0n) excluded.push({ venue: 'jupiter', reason: 'Jupiter returned a route that moves no base tokens.' });
  else {
    venues.push({
      venue: 'jupiter',
      quoteAtoms: p.dex.quote,
      baseAtoms: p.dex.base,
      pricePerBase: price(p.dex.quote, p.dex.base),
      fill: p.dex.base >= p.amount ? 'full' : 'partial',
      route: p.dex.route,
      priceImpactPct: p.dex.priceImpactPct,
      contextSlot: p.dex.contextSlot,
      executableNow: true,
    });
  }
  excluded.push({ venue: 'meteora', reason: METEORA_EXCLUSION });

  const better = (a: bigint, b: bigint) => (p.side === 'buy' ? (a < b ? -1 : a > b ? 1 : 0) : a > b ? -1 : a < b ? 1 : 0);
  const key = (v: Unranked) => (v.venue === 'cross' ? `cross:${v.cross}` : 'jupiter');
  venues.sort((a, b) => {
    if (a.fill !== b.fill) return a.fill === 'full' ? -1 : 1;
    if (a.fill === 'partial' && a.baseAtoms !== b.baseAtoms) return a.baseAtoms > b.baseAtoms ? -1 : 1;
    const byPrice = better(a.pricePerBase, b.pricePerBase);
    if (byPrice !== 0) return byPrice;
    return key(a) < key(b) ? -1 : 1;
  });
  const ranked = venues.map((v, i) => ({ ...v, rank: i + 1 }) as RankedVenue);

  const top = ranked[0];
  const caveats: string[] = [];
  if (ranked.some((v) => v.venue === 'cross')) caveats.push('A cross price is indicative: orders placed before the call closes can change it, and it settles after the call closes.');
  if (ranked.some((v) => v.venue === 'jupiter')) caveats.push('A Jupiter quote is executable now within its slippage bound; it moves with the market.');
  if (ranked.some((v) => v.fill === 'partial')) caveats.push('A venue marked partial fills less than the amount asked for; the rest would need another venue.');
  caveats.push('This is a quote comparison only. Nothing is signed or sent.');
  return { venues: ranked, excluded, best: top ? (top.venue === 'cross' ? { venue: 'cross', cross: top.cross } : { venue: 'jupiter' }) : null, caveats };
}
