// classifyMint: one mint's chain observation, plus the book, gives one identity verdict with the reasons for it.
// Pure and deterministic: the same observation and book always give the same verdict. No network, no model.
//
// The verdict states identity only. GENUINE means "the issuer lists this address and the chain agrees"; it never
// means safe or a good buy (that is the token-safety report's job).
//
// Order of decisions:
//  1. No account, or not a token mint: NOT_A_MINT.
//  2. The issuer lists the address. A stock-token family must also match the chain (the mint authority and every
//     other power held by keys the issuer uses); otherwise UNKNOWN, because a listing never outranks the chain.
//  3. Unlisted, but held by the issuer's own keys: FAMILY_UNLISTED (a listing newer than the snapshot).
//  4. Unlisted and declaring an issuer's symbol or name: IMPERSONATOR.
//  5. Unlisted, ends of the address copy a listed mint: ADDRESS_LOOKALIKE.
//  5b. Unlisted, a tokenized stock of the same company without the issuer's own marker: UNVERIFIED_STOCK_TOKEN.
//  6. Anything else: UNRELATED_TOKEN.
import { type Book, type Entry, endsOf, matchRule } from './book.js';
import { lookOf } from './normalise.js';
import { FAMILY_LABEL, type MintObservation, type MintRef, type Reason, type Verdict } from './types.js';

const SYMBOL_PREFIX = ['', 'x', 'w', 'b'] as const;
const SYMBOL_SUFFIX = ['', 'x', 'on', 'xstock', 'ondo', 'stock'] as const;
/** Words only a covered issuer puts in its token names. */
const ISSUER_MARKERS = new Set(['xstock', 'xstocks', 'ondo', 'backed']);
/** Words any tokenized-stock issuer uses. */
const STOCK_MARKERS = new Set(['tokenized', 'tokenised', 'stock', 'equity']);
/** A ticker this short plus a marker letter ("fx", "tx") is far more often a different coin than a forgery. */
const MIN_TICKER_FOR_MARKER_FORM = 3;
/** Shorter symbols must match letter for letter; longer ones match whatever the case. */
const MIN_SYMBOL_FOR_CASE_INSENSITIVE = 4;

const refOf = (e: Entry): MintRef => ({ mint: e.mint.mint, symbol: e.mint.symbol, name: e.mint.name, family: e.mint.family });

interface Claim {
  readonly entry: Entry;
  /** SYMBOL and NAME copy a covered issuer's token; COMPANY names the same company without the issuer's marker; LOOSE matches only after I/l and 0/o swaps; TICKER is a bare ticker. */
  readonly kind: 'SYMBOL' | 'NAME' | 'COMPANY' | 'LOOSE' | 'TICKER';
}

/** Genuine tokens a symbol or name declares itself to be. */
function claimsOf(book: Book, name: string | null, symbol: string | null): Claim[] {
  const found = new Map<string, Claim>();
  const add = (entry: Entry, kind: Claim['kind']): void => {
    const prev = found.get(entry.mint.mint);
    // SYMBOL and NAME outrank COMPANY, which outranks the weak TICKER kind.
    const rank = { SYMBOL: 4, NAME: 4, COMPANY: 3, LOOSE: 2, TICKER: 1 } as const;
    if (!prev || rank[kind] > rank[prev.kind]) found.set(entry.mint.mint, { entry, kind });
  };
  if (symbol) {
    const look = lookOf(symbol);
    // Letter for letter first; then the I/l and 0/o swaps, which only ever make a weak claim because two honest
    // tickers can differ by just those letters.
    for (const strict of [true, false]) {
      const sk = strict ? look.skeleton : look.loose;
      const bySymbol = strict ? book.bySymbol : book.byLooseSymbol;
      const byTicker = strict ? book.byTicker : book.byLooseTicker;
      const strong = strict ? 'SYMBOL' : 'LOOSE';
      // A very short symbol in different letter case ("FX" for Ford's "Fx") is as likely a different coin as a copy.
      for (const e of bySymbol.get(sk) ?? []) add(e, sk.length < MIN_SYMBOL_FOR_CASE_INSENSITIVE && symbol !== e.mint.symbol ? 'TICKER' : strong);
      for (const p of SYMBOL_PREFIX) {
        for (const x of SYMBOL_SUFFIX) {
          if (!p && !x) continue;
          if (!sk.startsWith(p) || !sk.endsWith(x) || sk.length <= p.length + x.length) continue;
          const t = sk.slice(p.length, sk.length - x.length);
          if (t.length < MIN_TICKER_FOR_MARKER_FORM) continue;
          for (const e of byTicker.get(t) ?? []) add(e, strong);
        }
      }
      // A bare ticker is only a weak claim: plenty of unrelated coins share a ticker with a listed company.
      if (strict && sk.length >= 2) for (const e of byTicker.get(sk) ?? []) add(e, 'TICKER');
    }
  }
  if (name) {
    const look = lookOf(name);
    const words = new Set(look.words);
    const issuerMarker = look.words.some((w) => ISSUER_MARKERS.has(w));
    const stockMarker = look.words.some((w) => STOCK_MARKERS.has(w));
    for (const e of book.entries) {
      if (look.skeleton === e.nameSkeleton) add(e, 'NAME');
      else if ((issuerMarker || stockMarker) && e.brandWords.size > 0 && [...e.brandWords].every((w) => words.has(w))) add(e, issuerMarker ? 'NAME' : 'COMPANY');
    }
  }
  return [...found.values()];
}

function verdict(book: Book, o: MintObservation, v: Pick<Verdict, 'verdict' | 'reasons'> & Partial<Pick<Verdict, 'listing' | 'impersonates'>>): Verdict {
  return {
    mint: o.mint,
    verdict: v.verdict,
    reasons: v.reasons,
    listing: v.listing ?? null,
    impersonates: v.impersonates ?? [],
    observed: { name: o.name, symbol: o.symbol, owner: o.owner },
    registry: { snapshotHash: book.data.snapshotHash, generatedAt: book.data.generatedAt },
  };
}

export function classifyMint(book: Book, o: MintObservation): Verdict {
  if (!o.exists) {
    return verdict(book, o, { verdict: 'NOT_A_MINT', reasons: [{ code: 'NO_ACCOUNT', message: 'No account exists at this address.' }] });
  }
  if (!o.isMint) {
    return verdict(book, o, { verdict: 'NOT_A_MINT', reasons: [{ code: 'NOT_A_TOKEN_MINT', message: 'The account exists but is not a token mint of the Token or Token-2022 program.' }] });
  }

  // 2. Issuer-listed.
  const listed = book.byMint.get(o.mint);
  if (listed) {
    const g = listed.mint;
    const listing = refOf(listed);
    const issuerLine = `${FAMILY_LABEL[g.family]} lists this address as ${g.symbol}.`;
    if (g.family === 'canonical') {
      return verdict(book, o, { verdict: 'GENUINE', listing, reasons: [{ code: 'ISSUER_LISTED', message: issuerLine }] });
    }
    const rule = book.rules.get(g.family);
    const result = rule ? matchRule(rule, o.fingerprint) : null;
    if (result?.ok) {
      return verdict(book, o, {
        verdict: 'GENUINE',
        listing,
        reasons: [
          { code: 'ISSUER_LISTED', message: issuerLine },
          { code: 'AUTHORITIES_MATCH_ISSUER', message: 'The mint authority and every other issuer power on the mint are held by keys this issuer uses.' },
        ],
      });
    }
    const why = result
      ? result.mismatches.map((m) => `${m.key} is held by ${m.holder}`).join('; ')
      : `the registry has no on-chain rule for ${FAMILY_LABEL[g.family]}`;
    return verdict(book, o, {
      verdict: 'UNKNOWN',
      listing,
      reasons: [
        { code: 'ISSUER_LISTED', message: issuerLine },
        { code: 'CHAIN_CONTRADICTS_LISTING', message: `The chain does not match the listing: ${why}. The issuer may have rotated keys, or the listing is wrong; do not treat this as the issuer's token until the registry is refreshed.` },
      ],
    });
  }

  // 3. Held by the issuer's own keys but not on its list.
  for (const rule of book.rules.values()) {
    if (rule.family === 'canonical') continue;
    if (matchRule(rule, o.fingerprint).ok) {
      return verdict(book, o, {
        verdict: 'FAMILY_UNLISTED',
        reasons: [
          { code: 'ISSUER_KEY_CONTROLS_UNLISTED_MINT', message: `This mint is controlled by ${FAMILY_LABEL[rule.family]}'s own keys but is not on the issuer's list in this snapshot. It is probably a newer listing; refresh the registry before relying on it.` },
          ...(book.coverage[rule.family] ? [] : [{ code: 'REGISTRY_NOT_COMPLETE' as const, message: `The registry does not hold ${FAMILY_LABEL[rule.family]}'s complete list.` }]),
        ],
      });
    }
  }

  // 4 and 5. Unlisted and not the issuer's: does it pretend to be?
  const claims = claimsOf(book, o.name, o.symbol);
  const disguised = (o.symbol ? lookOf(o.symbol).disguised : false) || (o.name ? lookOf(o.name).disguised : false);
  const reasons: Reason[] = [];
  const strong = claims.filter((c) => c.kind === 'SYMBOL' || c.kind === 'NAME');
  const company = claims.filter((c) => c.kind === 'COMPANY');
  const weak = claims.filter((c) => c.kind === 'TICKER');
  const loose = claims.filter((c) => c.kind === 'LOOSE');
  const ends = book.byEnds.get(endsOf(o.mint)) ?? [];

  if (strong.length > 0) {
    for (const c of strong) {
      reasons.push(
        c.kind === 'SYMBOL'
          ? { code: 'CLAIMS_ISSUER_SYMBOL', message: `Its symbol "${o.symbol}" is ${c.entry.mint.symbol}'s symbol or a marked form of ${c.entry.mint.ticker ?? c.entry.mint.symbol}; the real ${c.entry.mint.symbol} is ${c.entry.mint.mint}.` }
          : { code: 'CLAIMS_ISSUER_NAME', message: `Its name "${o.name}" declares it to be "${c.entry.mint.name}"; the real one is ${c.entry.mint.mint}.` },
      );
    }
    if (disguised) reasons.push({ code: 'DISGUISED_CHARACTERS', message: 'The name or symbol uses characters from another script or invisible characters to read like a genuine one.' });
    if (ends.length > 0) reasons.push({ code: 'ADDRESS_ENDS_MATCH_GENUINE', message: `The first and last six characters of the address match ${ends[0]!.mint.symbol} (${ends[0]!.mint.mint}).` });
    return verdict(book, o, { verdict: 'IMPERSONATOR', reasons, impersonates: dedupe([...strong.map((c) => c.entry), ...ends]) });
  }
  if (ends.length > 0) {
    return verdict(book, o, {
      verdict: 'ADDRESS_LOOKALIKE',
      reasons: [{ code: 'ADDRESS_ENDS_MATCH_GENUINE', message: `The first and last six characters of the address match ${ends[0]!.mint.symbol} (${ends[0]!.mint.mint}); it is a different mint made to look the same in a shortened address.` }],
      impersonates: dedupe(ends),
    });
  }

  if (company.length > 0) {
    return verdict(book, o, {
      verdict: 'UNVERIFIED_STOCK_TOKEN',
      reasons: [{ code: 'SAME_COMPANY_OTHER_ISSUER', message: `It presents itself as a tokenized stock of ${company.map((c) => c.entry.mint.ticker ?? c.entry.mint.name).join(', ')}, but it is not a token of a covered issuer. The registry cannot say whether its issuer is real; confirm the issuer yourself.` }],
    });
  }

  // 6. Unrelated to the issuers.
  if (weak.length > 0) {
    reasons.push({ code: 'TICKER_COLLISION', message: `Its symbol "${o.symbol}" is the ticker of ${weak.map((c) => c.entry.mint.ticker).join(', ')}, which the registry lists as ${weak.map((c) => c.entry.mint.symbol).join(', ')}. This is not that token.` });
  }
  if (loose.length > 0) {
    reasons.push({ code: 'RESEMBLES_ISSUER_SYMBOL', message: `Its symbol "${o.symbol}" reads like ${loose.map((c) => c.entry.mint.symbol).join(', ')} once I/l and 0/o are treated alike, but it is spelled differently. This is not that token.` });
  }
  if (o.name === null && o.symbol === null) {
    reasons.push({ code: 'NO_ON_CHAIN_NAME', message: 'The mint declares no name or symbol, so a name-based copy cannot be ruled out from the chain alone.' });
  }
  return verdict(book, o, { verdict: 'UNRELATED_TOKEN', reasons });
}

function dedupe(entries: readonly Entry[]): MintRef[] {
  const seen = new Map<string, MintRef>();
  for (const e of entries) if (!seen.has(e.mint.mint)) seen.set(e.mint.mint, refOf(e));
  return [...seen.values()];
}
