// What happened to a rated cross afterwards (V5). The rating feed is only worth reading if its track record is published, and the track record needs, for each rated cross, the move of
// its token from the price it cleared at to the price some time later. This module writes that move to `rating_outcomes` (the table the API's track-record route reads) from a price
// source, and writes nothing it could not get from one: a cross whose token has no pool in its quote asset, no trade in the hour, or a horizon that has not arrived is left pending with
// the reason, and the track record says how many are pending.
import type { Address } from '@solana/kit';
import { CROSS_CORE_PROGRAM_ADDRESS, CROSS_DISCRIMINATOR, getCrossDecoder } from '@opening-cross/sdk';
import type { PriceSource } from './price.js';

export const DEFAULT_HORIZON_SECS = 7 * 86_400;

export interface PendingRating {
  cross: string;
  baseMint: string;
  quoteMint: string;
  /** When trading in the token could begin: the end of the cross's reveal window. */
  startsTs: number;
}

export interface RatingStore {
  /** Rated, finalized crosses with no outcome yet whose horizon has passed (`startsTs + horizon <= now`), oldest first. */
  pending(version: string, dueBy: number, limit: number): Promise<PendingRating[]>;
  /** Records an outcome once. A second write for the same cross is ignored. */
  write(o: { cross: string; outcomeBps: number; horizonSecs: number; source: string }): Promise<void>;
}

export interface Pg {
  query<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: R[] }>;
}

/** The store over the indexer's database. The statements use only the tables and columns of migrations 001 and 012. */
export class PgRatingStore implements RatingStore {
  constructor(private readonly db: Pg) {}
  async pending(version: string, dueBy: number, limit: number): Promise<PendingRating[]> {
    const { rows } = await this.db.query<{ cross_address: string; base_mint: string; quote_mint: string; reveal_end_ts: string }>(
      `SELECT s.cross_address, c.base_mint, c.quote_mint, c.reveal_end_ts::text AS reveal_end_ts
         FROM rating_snapshots s
         JOIN crosses c ON c.address = s.cross_address
         LEFT JOIN rating_outcomes o ON o.cross_address = s.cross_address
        WHERE s.version = $1 AND s.status = 'rated' AND o.cross_address IS NULL AND c.state = 'Finalized' AND c.reveal_end_ts <= $2
        ORDER BY c.reveal_end_ts ASC
        LIMIT $3`,
      [version, dueBy, limit],
    );
    return rows.map((r) => ({ cross: r.cross_address, baseMint: r.base_mint, quoteMint: r.quote_mint, startsTs: Number(r.reveal_end_ts) }));
  }
  async write(o: { cross: string; outcomeBps: number; horizonSecs: number; source: string }): Promise<void> {
    await this.db.query('INSERT INTO rating_outcomes (cross_address, outcome_bps, horizon_secs, source) VALUES ($1, $2, $3, $4) ON CONFLICT (cross_address) DO NOTHING', [o.cross, o.outcomeBps, o.horizonSecs, o.source]);
  }
}

export class MemoryRatingStore implements RatingStore {
  readonly outcomes = new Map<string, { outcomeBps: number; horizonSecs: number; source: string }>();
  constructor(readonly rows: PendingRating[] = []) {}
  async pending(_v: string, dueBy: number, limit: number) {
    return this.rows.filter((r) => !this.outcomes.has(r.cross) && r.startsTs <= dueBy).sort((a, b) => a.startsTs - b.startsTs).slice(0, limit);
  }
  async write(o: { cross: string; outcomeBps: number; horizonSecs: number; source: string }) {
    if (!this.outcomes.has(o.cross)) this.outcomes.set(o.cross, { outcomeBps: o.outcomeBps, horizonSecs: o.horizonSecs, source: o.source });
  }
}

export type OutcomeResult =
  | { cross: string; status: 'written'; outcomeBps: number; clearing: number; later: number; source: string }
  | { cross: string; status: 'pending'; code: 'NO_CROSS' | 'NO_CLEARING' | 'NO_PRICE'; why: string };

export interface OutcomeDeps {
  store: RatingStore;
  prices: PriceSource;
  account: (a: Address) => Promise<{ data: Uint8Array; owner: Address } | null>;
  now: () => number;
  version: string;
  horizonSecs?: number;
  limit?: number;
}

const INT_MAX = 2_000_000_000;

/** The price the cross cleared at, in quote tokens per base token (human units): quote atoms per `priceScale` base atoms, corrected for the two decimals. */
export function clearingPriceHuman(price: bigint, priceScale: bigint, baseDecimals: number, quoteDecimals: number): number {
  if (priceScale <= 0n) throw new RangeError('priceScale must be positive');
  // price / 10^quoteDec quote tokens buy priceScale / 10^baseDec base tokens.
  return (Number(price) / 10 ** quoteDecimals) / (Number(priceScale) / 10 ** baseDecimals);
}

/** The outcome in basis points, rounded toward zero and held inside a 32-bit integer (the column's type). */
export function outcomeBps(clearing: number, later: number): number {
  if (!(clearing > 0) || !(later > 0)) throw new RangeError('both prices must be positive');
  return Math.max(-10_000, Math.min(INT_MAX, Math.trunc((later / clearing - 1) * 10_000)));
}

export async function resolveOutcomes(d: OutcomeDeps): Promise<OutcomeResult[]> {
  const horizon = d.horizonSecs ?? DEFAULT_HORIZON_SECS;
  const due = d.now() - horizon;
  const rows = await d.store.pending(d.version, due, d.limit ?? 25);
  const out: OutcomeResult[] = [];
  for (const r of rows) {
    const acct = await d.account(r.cross as Address);
    if (!acct || acct.owner !== CROSS_CORE_PROGRAM_ADDRESS || !Array.from(CROSS_DISCRIMINATOR as Uint8Array).every((b, i) => acct.data[i] === b)) {
      out.push({ cross: r.cross, status: 'pending', code: 'NO_CROSS', why: 'the cross account was not found on chain' });
      continue;
    }
    const c = getCrossDecoder().decode(acct.data);
    if (c.clearing.__option !== 'Some') {
      out.push({ cross: r.cross, status: 'pending', code: 'NO_CLEARING', why: 'the cross has no clearing price' });
      continue;
    }
    const p0 = clearingPriceHuman(c.clearing.value.price, c.priceScale, c.baseDecimals, c.quoteDecimals);
    const at = r.startsTs + horizon;
    const ans = await d.prices.priceAt(r.baseMint, r.quoteMint, at);
    if (!ans.ok) {
      out.push({ cross: r.cross, status: 'pending', code: 'NO_PRICE', why: ans.why });
      continue;
    }
    const bps = outcomeBps(p0, ans.point.price);
    await d.store.write({ cross: r.cross, outcomeBps: bps, horizonSecs: horizon, source: ans.point.source });
    out.push({ cross: r.cross, status: 'written', outcomeBps: bps, clearing: p0, later: ans.point.price, source: ans.point.source });
  }
  return out;
}
