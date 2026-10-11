// The reference data a check runs against: the issuers' own mint lists, the issuer-power rule per family, and the
// indexes the classifier needs. Built from plain JSON so the same book works live, in replay and in tests.
import { lookOf } from './normalise.js';
import type { Family, FamilyRule, FingerprintKey, GenuineMint, RegistryData } from './types.js';

export class BookError extends Error {
  override readonly name = 'BookError';
}

/** Words that name a kind of token or company form, not a company. */
const GENERIC = new Set([
  'inc', 'corp', 'corporation', 'company', 'co', 'ltd', 'limited', 'plc', 'sa', 'ag', 'nv', 'se', 'group', 'holding', 'holdings',
  'the', 'and', 'of', 'class', 'cl', 'series', 'token', 'tokens', 'tokenized', 'tokenised', 'stock', 'stocks', 'xstock', 'xstocks',
  'ondo', 'etf', 'trust', 'fund', 'shares', 'share', 'wrapped', 'coin', 'finance', 'financial', 'international', 'technologies',
  'technology', 'tech', 'systems', 'global', 'new', 'one', 'usd', 'common', 'ordinary', 'adr', 'ads', 'sponsored', 'first',
  'american', 'america', 'united', 'national', 'general', 'capital', 'bank', 'energy', 'health', 'healthcare', 'industries',
  'partners', 'resources', 'services', 'solutions', 'therapeutics', 'pharmaceuticals', 'bancorp', 'index', 'ishares', 'spdr',
  'vanguard', 'invesco', 'proshares', 'direxion', 'select', 'sector', 'portfolio', 'markets', 'market', 'world', 'digital',
  'physical', 'gold', 'silver', 'bond', 'treasury', 'short', 'long', 'ultra', 'ultrapro', 'daily', 'bull', 'bear', 'backed',
]);

/** Distinctive words of a company name: "NVIDIA xStock" gives {"nvidia"}. */
export function brandWordsOf(...names: ReadonlyArray<string | null>): Set<string> {
  const out = new Set<string>();
  for (const n of names) {
    if (!n) continue;
    for (const w of lookOf(n).words) if (w.length >= 3 && !GENERIC.has(w) && !/^\d+$/.test(w)) out.add(w);
  }
  return out;
}

export interface Entry {
  readonly mint: GenuineMint;
  readonly symbolSkeleton: string;
  readonly nameSkeleton: string;
  readonly tickerSkeleton: string | null;
  readonly brandWords: ReadonlySet<string>;
}

export interface Book {
  readonly data: RegistryData;
  readonly byMint: ReadonlyMap<string, Entry>;
  readonly entries: readonly Entry[];
  readonly rules: ReadonlyMap<Family, FamilyRule>;
  /** Symbol skeleton to entries, for exact symbol claims. */
  readonly bySymbol: ReadonlyMap<string, readonly Entry[]>;
  /** Ticker skeleton to entries, for ticker-plus-marker claims. */
  readonly byTicker: ReadonlyMap<string, readonly Entry[]>;
  /** The same two indexes on the loose skeleton (I/l and 0/o treated alike). */
  readonly byLooseSymbol: ReadonlyMap<string, readonly Entry[]>;
  readonly byLooseTicker: ReadonlyMap<string, readonly Entry[]>;
  /** First six and last six characters of each listed mint, for address look-alikes. */
  readonly byEnds: ReadonlyMap<string, readonly Entry[]>;
  /** Families whose complete issuer list the registry holds. */
  readonly coverage: Readonly<Record<Family, boolean>>;
}

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export const endsOf = (mint: string): string => `${mint.slice(0, 6)}…${mint.slice(-6)}`;

function push<V>(m: Map<string, V[]>, k: string, v: V): void {
  const l = m.get(k);
  if (l) l.push(v);
  else m.set(k, [v]);
}

export function buildBook(data: RegistryData): Book {
  const byMint = new Map<string, Entry>();
  const bySymbol = new Map<string, Entry[]>();
  const byTicker = new Map<string, Entry[]>();
  const byLooseSymbol = new Map<string, Entry[]>();
  const byLooseTicker = new Map<string, Entry[]>();
  const byEnds = new Map<string, Entry[]>();
  const entries: Entry[] = [];
  for (const g of data.mints) {
    if (!BASE58.test(g.mint)) throw new BookError(`listed mint ${g.symbol} has an invalid address ${g.mint}`);
    if (byMint.has(g.mint)) throw new BookError(`mint ${g.mint} is listed twice`);
    const e: Entry = {
      mint: g,
      symbolSkeleton: lookOf(g.symbol).skeleton,
      nameSkeleton: lookOf(g.name).skeleton,
      tickerSkeleton: g.ticker ? lookOf(g.ticker).skeleton : null,
      brandWords: brandWordsOf(g.name),
    };
    byMint.set(g.mint, e);
    entries.push(e);
    push(bySymbol, e.symbolSkeleton, e);
    if (e.tickerSkeleton) push(byTicker, e.tickerSkeleton, e);
    push(byLooseSymbol, lookOf(g.symbol).loose, e);
    if (g.ticker) push(byLooseTicker, lookOf(g.ticker).loose, e);
    push(byEnds, endsOf(g.mint), e);
  }
  const rules = new Map<Family, FamilyRule>();
  for (const r of data.rules) rules.set(r.family, r);
  const has = (f: Family): boolean => entries.some((e) => e.mint.family === f);
  return {
    data,
    byMint,
    entries,
    rules,
    bySymbol,
    byTicker,
    byLooseSymbol,
    byLooseTicker,
    byEnds,
    // Both stock families count as covered only when the issuer's own list is in the book.
    coverage: {
      xstock: entries.some((e) => e.mint.family === 'xstock' && e.mint.listedBy.includes('xstocks_api')),
      ondo: entries.some((e) => e.mint.family === 'ondo' && e.mint.listedBy.includes('ondo_csv')),
      canonical: has('canonical'),
    },
  };
}

export interface RuleResult {
  readonly ok: boolean;
  /** Keys whose holder the issuer is not known to use, with what the mint actually has. */
  readonly mismatches: readonly { readonly key: FingerprintKey; readonly holder: string }[];
}

/**
 * Does a mint's issuer-power fingerprint belong to the family? The mint authority must be present and the issuer's;
 * every other power the mint carries must be held by a key the issuer is known to use for it.
 */
export function matchRule(rule: FamilyRule, fingerprint: Readonly<Partial<Record<FingerprintKey, string>>>): RuleResult {
  const mismatches: { key: FingerprintKey; holder: string }[] = [];
  const accepted = rule.accepted;
  const mintAuthority = fingerprint.MINT_AUTHORITY;
  if (!mintAuthority) mismatches.push({ key: 'MINT_AUTHORITY', holder: '(none)' });
  for (const [k, holder] of Object.entries(fingerprint) as [FingerprintKey, string][]) {
    if (!(accepted[k] ?? []).includes(holder)) mismatches.push({ key: k, holder });
  }
  return { ok: mismatches.length === 0, mismatches };
}
