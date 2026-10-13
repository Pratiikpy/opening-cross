// Duplicate and look-alike tickers among ARBITRARY tokens (PRODUCT_FEATURES F7: "duplicate ticker/image warnings").
//
// `classify.ts` answers a narrower question: is this mint an issuer's genuine token, a copy of one, or unrelated. It knows only
// the issuers' own lists. This module compares a token with any set of tokens a caller supplies, such as every token already
// listed in a deployment, and reports a collision of ticker or name: the same, the same after folding look-alike characters,
// or, for tickers of five or more characters, one character apart. A match is a warning to read before buying or listing, not a verdict that either token is false: two
// honest tokens can share a ticker, and the caller decides what to do.
//
// Images are not compared. A hash of an image is not a similarity measure and a perceptual one needs the image bytes, which this
// package does not fetch; the absence of an image check is stated by the route that uses this module.
import { lookOf } from './normalise.js';

export type KnownToken = { readonly mint: string; readonly name: string | null; readonly symbol: string | null; readonly source: string };
export type DuplicateRelation = 'same-symbol' | 'look-alike-symbol' | 'near-symbol' | 'same-name' | 'look-alike-name';
export type Severity = 'high' | 'medium' | 'low';

export type Duplicate = {
  readonly mint: string;
  readonly source: string;
  readonly symbol: string | null;
  readonly name: string | null;
  readonly relation: DuplicateRelation;
  readonly severity: Severity;
  readonly why: string;
};

const RANK: Record<Severity, number> = { high: 0, medium: 1, low: 2 };

/** Edit distance between two short strings, stopping early once it exceeds `max`. */
export function editDistance(a: string, b: string, max = 2): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
      best = Math.min(best, cur[j]!);
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length]!;
}

/**
 * The tokens in `known` whose ticker or name collides with `candidate`, most serious first. A token never collides with itself
 * (same mint). Symbols shorter than two characters, after folding, are not compared: they say nothing.
 */
export function findDuplicates(candidate: { readonly mint: string; readonly name: string | null; readonly symbol: string | null }, known: readonly KnownToken[]): Duplicate[] {
  const cs = candidate.symbol ? lookOf(candidate.symbol) : null;
  const cn = candidate.name ? lookOf(candidate.name) : null;
  const out: Duplicate[] = [];
  for (const k of known) {
    if (k.mint === candidate.mint) continue;
    const found: Omit<Duplicate, 'mint' | 'source' | 'symbol' | 'name'>[] = [];
    if (cs && k.symbol && cs.skeleton.length >= 2) {
      const ks = lookOf(k.symbol);
      if (candidate.symbol!.trim().toLowerCase() === k.symbol.trim().toLowerCase()) found.push({ relation: 'same-symbol', severity: 'high', why: `both use the ticker "${k.symbol}"` });
      else if (cs.skeleton === ks.skeleton) found.push({ relation: 'look-alike-symbol', severity: 'high', why: `"${candidate.symbol}" and "${k.symbol}" read the same once look-alike characters, case and punctuation are folded` });
      else if (cs.loose === ks.loose) found.push({ relation: 'look-alike-symbol', severity: 'medium', why: `"${candidate.symbol}" and "${k.symbol}" differ only by characters people read past (0 and O, 1 and l and I)` });
      else if (cs.skeleton.length >= 5 && ks.skeleton.length >= 5 && editDistance(cs.skeleton, ks.skeleton, 1) <= 1) found.push({ relation: 'near-symbol', severity: 'low', why: `"${candidate.symbol}" is one character from "${k.symbol}"` });
    }
    if (cn && k.name && cn.skeleton.length >= 3) {
      const kn = lookOf(k.name);
      if (cn.skeleton === kn.skeleton) found.push({ relation: 'same-name', severity: 'medium', why: `both are named "${k.name}"` });
      else if (cn.loose === kn.loose) found.push({ relation: 'look-alike-name', severity: 'medium', why: `"${candidate.name}" and "${k.name}" differ only by look-alike characters` });
    }
    // One line per token: the most serious reason.
    found.sort((a, b) => RANK[a.severity] - RANK[b.severity]);
    const top = found[0];
    if (top) out.push({ mint: k.mint, source: k.source, symbol: k.symbol, name: k.name, ...top });
  }
  const sorted = out.sort((a, b) => RANK[a.severity] - RANK[b.severity] || (a.mint < b.mint ? -1 : 1));
  // One-character neighbours of a long ticker are common in a large list; the first few say what there is to say.
  const MAX_LOW = 5;
  let low = 0;
  return sorted.filter((d) => d.severity !== 'low' || ++low <= MAX_LOW);
}

/** The one-line summary a screen shows: how many collide and how serious the worst is. */
export function duplicateSummary(d: readonly Duplicate[]): { verdict: 'clear' | 'warn'; worst: Severity | null; count: number } {
  return { verdict: d.length === 0 ? 'clear' : 'warn', worst: d[0]?.severity ?? null, count: d.length };
}
