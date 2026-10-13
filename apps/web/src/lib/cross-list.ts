// Pure logic for the crosses list and the calendar: what a cross is doing by its clock, the list filters and how they
// live in the URL query string, and sorting. Kept free of React so every rule is unit-tested.
import type { CrossSummary } from './api';

export type Phase = 'upcoming' | 'open' | 'reveal' | 'awaiting-settlement';

/** What a cross is doing right now. Only a `Live` cross has a clock-driven phase; settled ones are done. */
export function livePhase(c: Pick<CrossSummary, 'state' | 'open_ts' | 'close_ts' | 'reveal_end_ts'>, nowSec: bigint): Phase {
  if (nowSec < BigInt(c.open_ts)) return 'upcoming';
  if (c.state === 'Live' && nowSec < BigInt(c.close_ts)) return 'open';
  return nowSec < BigInt(c.reveal_end_ts) ? 'reveal' : 'awaiting-settlement';
}

/** The result a visitor sees. A cross finalised without a clearing price did not print: it refunded everyone, the same
 * outcome the API's stats count as "no print". */
export type Outcome = 'live' | 'cleared' | 'noprint' | 'finalized';

export function outcomeOf(c: Pick<CrossSummary, 'state' | 'clearing_price'>): Outcome {
  if (c.state === 'NoPrint' || (c.state === 'Finalized' && c.clearing_price === null)) return 'noprint';
  if (c.state === 'Live') return 'live';
  if (c.state === 'Cleared') return 'cleared';
  return 'finalized';
}

export const OUTCOME_LABEL: Record<Outcome, string> = { live: 'Live', cleared: 'Cleared', noprint: 'No print', finalized: 'Finalized' };
export const OUTCOMES = Object.keys(OUTCOME_LABEL) as Outcome[];

export type Disclosure = 'open' | 'sealed';
export type SupplyMode = 'escrow' | 'mint' | 'deferred-mint';
export const SUPPLY_LABEL: Record<SupplyMode, string> = { escrow: 'Escrowed supply', mint: 'Mints at settlement', 'deferred-mint': 'Deferred mint' };
export const DISCLOSURE_LABEL: Record<Disclosure, string> = { open: 'Open bids', sealed: 'Sealed bids' };

export type SortKey = 'newest' | 'close-asc' | 'close-desc' | 'orders-desc';
export const SORT_LABEL: Record<SortKey, string> = {
  newest: 'Newest first',
  'close-asc': 'Closing soonest',
  'close-desc': 'Closing latest',
  'orders-desc': 'Most orders',
};

export type Filters = {
  state: Outcome | null;
  disclosure: Disclosure | null;
  supply: SupplyMode | null;
  q: string;
  sort: SortKey;
};

export const NO_FILTERS: Filters = { state: null, disclosure: null, supply: null, q: '', sort: 'newest' };

const first = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);
const oneOf = <T extends string>(v: string | undefined, allowed: readonly T[]): T | null => (v !== undefined && (allowed as readonly string[]).includes(v) ? (v as T) : null);

/** Reads filters from a query string. Unknown values are dropped, never trusted. */
export function parseFilters(params: Record<string, string | string[] | undefined> | URLSearchParams): Filters {
  const get = (k: string) => (params instanceof URLSearchParams ? (params.get(k) ?? undefined) : first(params[k]));
  return {
    state: oneOf(get('state'), OUTCOMES),
    disclosure: oneOf(get('disclosure'), ['open', 'sealed'] as const),
    supply: oneOf(get('supply'), ['escrow', 'mint', 'deferred-mint'] as const),
    q: (get('q') ?? '').slice(0, 64),
    sort: oneOf(get('sort'), ['newest', 'close-asc', 'close-desc', 'orders-desc'] as const) ?? 'newest',
  };
}

/** The query string for a filter state: defaults are left out so an unfiltered view has a clean URL. */
export function serializeFilters(f: Filters): string {
  const p = new URLSearchParams();
  if (f.state) p.set('state', f.state);
  if (f.disclosure) p.set('disclosure', f.disclosure);
  if (f.supply) p.set('supply', f.supply);
  if (f.q.trim()) p.set('q', f.q.trim());
  if (f.sort !== 'newest') p.set('sort', f.sort);
  return p.toString();
}

/** What the list needs from the per-cross detail endpoint, which is the only place disclosure and supply mode are served. */
export type CrossTraits = { disclosure: Disclosure; supplyMode: SupplyMode };

export const needsDetail = (f: Filters): boolean => f.disclosure !== null || f.supply !== null;

export function matches(c: CrossSummary, f: Filters, traits: CrossTraits | undefined): boolean {
  if (f.state && outcomeOf(c) !== f.state) return false;
  if (f.disclosure && traits?.disclosure !== f.disclosure) return false;
  if (f.supply && traits?.supplyMode !== f.supply) return false;
  const q = f.q.trim().toLowerCase();
  if (q && ![c.address, c.base_mint, c.quote_mint].some((a) => a.toLowerCase().includes(q))) return false;
  return true;
}

/** Filters and sorts. The API returns newest first; that order is kept as the tie-breaker for every sort. */
export function applyFilters(all: readonly CrossSummary[], f: Filters, traits: ReadonlyMap<string, CrossTraits>): CrossSummary[] {
  const rows = all.map((c, i) => ({ c, i })).filter(({ c }) => matches(c, f, traits.get(c.address)));
  const close = (c: CrossSummary) => BigInt(c.close_ts);
  rows.sort((a, b) => {
    let d = 0n;
    if (f.sort === 'close-asc') d = close(a.c) - close(b.c);
    else if (f.sort === 'close-desc') d = close(b.c) - close(a.c);
    else if (f.sort === 'orders-desc') d = BigInt(b.c.orders_committed - a.c.orders_committed);
    return d !== 0n ? (d < 0n ? -1 : 1) : a.i - b.i;
  });
  return rows.map((r) => r.c);
}

export const isFiltered = (f: Filters): boolean => serializeFilters(f) !== '';
