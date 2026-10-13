// The Markets tab (T1, S5; ADR-0409): every token that has cleared in a cross, the price it last cleared at, when it clears next, and
// the tokenized stocks the premium monitor watches. Pure shaping of what the API serves; nothing is invented, and a figure that cannot
// be computed from a clearing price is left out.
import type { CrossSummary } from './api';
import { type Mark, type Print, latestPrints, markOf, nextCrossFor } from './holder-value';
import type { PremiumObservation } from './premium';
import type { CrossDetail } from './types';

export type AssetRow = {
  baseMint: string;
  /** Printed crosses of this token, any quote token. */
  prints: number;
  /** Crosses still to come or taking orders. */
  upcoming: number;
  lastCross: string;
  lastCloseTs: number;
  next: CrossSummary | null;
  mark: Mark | null;
};

/** One row per base token with at least one printed cross, most recently cleared first. */
export function assetRows(all: readonly CrossSummary[], marks: ReadonlyMap<string, Mark | null>, now: number): AssetRow[] {
  const latest = latestPrints(all);
  const rows: AssetRow[] = [];
  for (const [baseMint, c] of latest) {
    rows.push({
      baseMint,
      prints: all.filter((x) => x.base_mint === baseMint && x.clearing_price !== null && x.state !== 'Live' && x.state !== 'NoPrint').length,
      upcoming: all.filter((x) => x.base_mint === baseMint && x.state === 'Live' && Number(x.close_ts) > now).length,
      lastCross: c.address,
      lastCloseTs: Number(c.close_ts),
      next: nextCrossFor(baseMint, all, now),
      mark: marks.get(c.address) ?? null,
    });
  }
  return rows.sort((a, b) => b.lastCloseTs - a.lastCloseTs || (a.baseMint < b.baseMint ? -1 : 1));
}

/** The prints the cohort index works from: each printed cross's clearing price per whole token, from the details of those crosses. */
export function printsOf(details: readonly CrossDetail[]): Print[] {
  const out: Print[] = [];
  for (const d of details) {
    const m = markOf(d);
    if (m && d.baseMint) out.push({ baseMint: d.baseMint, quoteMint: d.quoteMint, closeTs: m.closeTs, perToken: m.perToken });
  }
  return out;
}

export type StockRow = { ticker: string; symbol: string; mint: string; session: PremiumObservation['session']; at: number; premiumBpsX100: string | null; status: string };

/**
 * The newest priced observation of each ticker (the $1,000 buy leg when there is one), else its newest attempt with the reason it did
 * not price. Raw reference prices are not carried: only the premium and the status are shown (HUMAN_TASKS H15).
 */
export function stockRows(obs: readonly PremiumObservation[]): StockRow[] {
  const byTicker = new Map<string, PremiumObservation[]>();
  for (const o of obs) byTicker.set(o.ticker, [...(byTicker.get(o.ticker) ?? []), o]);
  const rows: StockRow[] = [];
  for (const [ticker, list] of byTicker) {
    const newest = Math.max(...list.map((o) => o.at));
    const round = list.filter((o) => o.at === newest);
    const pick = round.find((o) => o.leg === 'buy' && o.sizeUsd === 1000 && o.status === 'ok') ?? round.find((o) => o.status === 'ok') ?? round[0]!;
    rows.push({ ticker, symbol: pick.symbol, mint: pick.mint, session: pick.session, at: pick.at, premiumBpsX100: pick.status === 'ok' ? pick.premiumBpsX100 : null, status: pick.status });
  }
  return rows.sort((a, b) => (a.ticker < b.ticker ? -1 : 1));
}
