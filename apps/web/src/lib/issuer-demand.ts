// The sizing tool of the demand check (A3, S13): what the soft commits on a draft listing say against the tokens the issuer plans to
// offer. A soft commit is a statement of interest, not a bid: nothing is escrowed and no one is bound. The figures are exact sums of
// what wallets signed; they are not a prediction of what will happen in a real cross, where fewer people will follow through.
import type { DemandMap } from './issuer-board';
import { parseAtoms } from './units';

export type SizingRow = {
  /** Limit price in quote atoms per whole token. */
  price: bigint;
  /** Tokens wanted at this price or higher, in base atoms. */
  tokensAtOrAbove: bigint;
  /** Budget in quote atoms committed at this price or higher. */
  budgetAtOrAbove: bigint;
  wallets: number;
  /** Share of the planned offer that this demand would cover, in basis points (10_000 = exactly covers it). */
  coverageBps: bigint | null;
};

export type Sizing = {
  rows: SizingRow[];
  offered: bigint | null;
  /** The highest price at which demand still covers the whole offer, and the raise selling it all there would make. Null when no price does. */
  coverPrice: { price: bigint; raise: bigint } | null;
  /** The tokens the draft is offering, and how many soft commits there are, for the headline. */
  wallets: number;
};

/** Demand at or above every price where someone committed, highest price first. */
export function sizing(m: DemandMap): Sizing {
  const bd = m.draft.baseDecimals;
  const offered = parseAtoms(m.draft.offered, bd);
  const levels = [...m.levels].sort((a, b) => (BigInt(a.price) < BigInt(b.price) ? 1 : -1));
  const rows: SizingRow[] = [];
  let tokens = 0n;
  let budget = 0n;
  let wallets = 0;
  for (const l of levels) {
    tokens += BigInt(l.tokens);
    budget += BigInt(l.budget);
    wallets += l.wallets;
    rows.push({ price: BigInt(l.price), tokensAtOrAbove: tokens, budgetAtOrAbove: budget, wallets, coverageBps: offered && offered > 0n ? (tokens * 10_000n) / offered : null });
  }
  let coverPrice: Sizing['coverPrice'] = null;
  if (offered && offered > 0n) {
    const hit = rows.find((r) => r.tokensAtOrAbove >= offered);
    if (hit) coverPrice = { price: hit.price, raise: (offered * hit.price) / 10n ** BigInt(bd) };
  }
  return { rows, offered, coverPrice, wallets: m.commits.wallets };
}

export const pctOf = (bps: bigint | null): string => (bps === null ? 'unknown' : `${(Number(bps) / 100).toFixed(1).replace(/\.0$/, '')}%`);

