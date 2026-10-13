// What a wallet's tokens are worth, from prices the product itself produced and nothing else (Y9, M6; ADR-0401).
//
// There is no market price here. The only price a token has is the price at which a cross of that token last cleared, so a holding is
// marked at that price and labelled with the cross and the day it comes from. A result is shown only against the average price the
// wallet paid through crosses, in the same quote token, and only for the tokens it bought that way. Amounts in different quote tokens
// are never added together. Everything is exact integer arithmetic.
import type { CrossSummary } from './api';
import type { CrossDetail } from './types';

export type Mark = {
  cross: string;
  quoteMint: string;
  quoteDecimals: number;
  baseDecimals: number;
  /** Quote atoms per one whole base token at the cross's clearing price. */
  perToken: bigint;
  closeTs: number;
  matched: bigint;
};

/** The most recent printed cross of each base mint, from the list the API serves (newest closing wins; a cross that did not print has no price). */
export function latestPrints(all: readonly CrossSummary[]): Map<string, CrossSummary> {
  const out = new Map<string, CrossSummary>();
  for (const c of all) {
    if (c.clearing_price === null || c.state === 'Live' || c.state === 'NoPrint') continue;
    const have = out.get(c.base_mint);
    if (!have || BigInt(c.close_ts) > BigInt(have.close_ts) || (BigInt(c.close_ts) === BigInt(have.close_ts) && c.address > have.address)) out.set(c.base_mint, c);
  }
  return out;
}

/** The mark a cross's detail gives its base token: the clearing price in quote atoms per whole token. Null for a cross that did not print. */
export function markOf(c: Pick<CrossDetail, 'address' | 'quoteMint' | 'decimals' | 'grid' | 'clearing' | 'window'>): Mark | null {
  if (!c.clearing) return null;
  return {
    cross: c.address,
    quoteMint: c.quoteMint,
    quoteDecimals: c.decimals.quote,
    baseDecimals: c.decimals.base,
    perToken: (BigInt(c.clearing.price) * 10n ** BigInt(c.decimals.base)) / BigInt(c.grid.priceScale),
    closeTs: Number(c.window.closeTs),
    matched: BigInt(c.clearing.matched),
  };
}

export type HoldingInput = {
  mint: string;
  decimals: number;
  /** What the wallet holds now, read from chain; null when it could not be read. */
  held: bigint | null;
  /** Through crosses: tokens received by buying, and the quote paid for them, per quote mint. */
  bought: { quoteMint: string; tokens: bigint; paid: bigint }[];
  sold: bigint;
  mark: Mark | null;
};

export type HoldingValue = {
  mint: string;
  decimals: number;
  held: bigint | null;
  received: bigint;
  sold: bigint;
  mark: Mark | null;
  /** Held tokens at the mark, in quote atoms of the mark's quote token. Null without a balance or a mark. */
  value: bigint | null;
  /** Average quote atoms per whole token paid through crosses, in the mark's quote token. Null when nothing was bought in that token. */
  averagePaid: bigint | null;
  /** The tokens the result below covers: those bought through crosses and still held. */
  resultTokens: bigint;
  /** Value at the mark minus what those tokens cost. Null when there is no like-for-like cost. */
  result: bigint | null;
  /** True when the wallet holds tokens it did not buy through a cross (so their cost is unknown). */
  holdsOther: boolean;
};

const pow10 = (d: number) => 10n ** BigInt(d);

export function valueHolding(h: HoldingInput): HoldingValue {
  const received = h.bought.reduce((a, b) => a + b.tokens, 0n);
  const sameQuote = h.mark ? h.bought.filter((b) => b.quoteMint === h.mark!.quoteMint) : [];
  const tokensSame = sameQuote.reduce((a, b) => a + b.tokens, 0n);
  const paidSame = sameQuote.reduce((a, b) => a + b.paid, 0n);
  const averagePaid = tokensSame > 0n ? (paidSame * pow10(h.decimals)) / tokensSame : null;
  const value = h.mark && h.held !== null ? (h.held * h.mark.perToken) / pow10(h.decimals) : null;
  // Tokens bought through crosses and still held: at most what was bought, at most what is held.
  const covered = h.held === null ? 0n : h.held < tokensSame ? h.held : tokensSame;
  let result: bigint | null = null;
  if (h.mark && averagePaid !== null && covered > 0n) {
    const worth = (covered * h.mark.perToken) / pow10(h.decimals);
    const cost = (covered * paidSame) / tokensSame;
    result = worth - cost;
  }
  return { mint: h.mint, decimals: h.decimals, held: h.held, received, sold: h.sold, mark: h.mark, value, averagePaid, resultTokens: covered, result, holdsOther: h.held !== null && h.held > received - (h.sold < received ? h.sold : received) };
}

/** `+1.20`, `-0.35` or `0`: a signed amount with its sign always shown, so a result is never read as a balance. */
export function signed(atoms: bigint, decimals: number, format: (a: bigint, d: number) => string): string {
  return `${atoms > 0n ? '+' : ''}${format(atoms, decimals)}`;
}

/** The next cross that takes orders in a base token: open now first, else the soonest to open. */
export function nextCrossFor(baseMint: string, all: readonly CrossSummary[], now: number): CrossSummary | null {
  const live = all.filter((c) => c.base_mint === baseMint && c.state === 'Live' && Number(c.close_ts) > now);
  const open = live.filter((c) => Number(c.open_ts) <= now).sort((a, b) => Number(a.close_ts) - Number(b.close_ts));
  if (open[0]) return open[0];
  return live.sort((a, b) => Number(a.open_ts) - Number(b.open_ts))[0] ?? null;
}

// ---------------------------------------------------------------- redemption

/** What a holder would receive from a liquidating treasury for `coins`, as the program computes it: coins * snapshot vault / snapshot supply, rounded down. */
export function redemptionPayout(coins: bigint, snapshot: { vault: string; supply: string } | null): bigint | null {
  if (!snapshot) return null;
  const supply = BigInt(snapshot.supply);
  if (supply === 0n) return null;
  return (coins * BigInt(snapshot.vault)) / supply;
}

// ---------------------------------------------------------------- cohort index

export type Print = { baseMint: string; quoteMint: string; closeTs: number; perToken: bigint };

export type CohortIndex = {
  /** Assets with at least two prints in the same quote token, each with its first and latest price. */
  constituents: { baseMint: string; quoteMint: string; first: bigint; latest: bigint; prints: number }[];
  /** Equal-weighted mean of latest / first across constituents, in basis points of the start (10,000 = unchanged). Null with no constituent. */
  levelBps: bigint | null;
  /** Assets that printed once: they have no return yet. */
  unpriced: number;
};

/**
 * A chain-linked index of assets that cleared more than once: each asset's return is its latest clearing price over its first, in the
 * same quote token; the index is their equal-weighted mean. An asset with one print contributes nothing and is counted as unpriced.
 */
export function cohortIndex(prints: readonly Print[]): CohortIndex {
  const byAsset = new Map<string, Print[]>();
  for (const p of prints) byAsset.set(`${p.baseMint}|${p.quoteMint}`, [...(byAsset.get(`${p.baseMint}|${p.quoteMint}`) ?? []), p]);
  const constituents: CohortIndex['constituents'] = [];
  let unpriced = 0;
  for (const list of byAsset.values()) {
    const sorted = [...list].sort((a, b) => a.closeTs - b.closeTs);
    const first = sorted[0]!;
    const last = sorted[sorted.length - 1]!;
    if (sorted.length < 2 || first.perToken === 0n) {
      unpriced += 1;
      continue;
    }
    constituents.push({ baseMint: first.baseMint, quoteMint: first.quoteMint, first: first.perToken, latest: last.perToken, prints: sorted.length });
  }
  const levelBps = constituents.length === 0 ? null : constituents.reduce((a, c) => a + (c.latest * 10_000n) / c.first, 0n) / BigInt(constituents.length);
  return { constituents, levelBps, unpriced };
}
