// Postgres access for the premium monitor. The API and the /premium page read only from here.
import type pg from 'pg';
import { type Leg, type Observation, type ObservationStatus, type ReferenceKind, type Session } from '@opening-cross/premium';

export async function insertObservations(db: pg.Pool, cluster: string, obs: readonly Observation[]): Promise<number> {
  if (obs.length === 0) return 0;
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    for (const o of obs) {
      await client.query(
        `INSERT INTO premium_observations (at, cluster, ticker, symbol, mint, leg, size_usd, session, reference_kind, status, reference_e6, per_share_e6, premium_bps_x100, price_impact_bps_x100, route, multiplier)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
        [o.at, cluster, o.ticker, o.symbol, o.mint, o.leg, o.sizeUsd, o.session, o.referenceKind, o.status, o.referenceE6?.toString() ?? null, o.perShareE6?.toString() ?? null, o.premiumBpsX100?.toString() ?? null, o.priceImpactBpsX100?.toString() ?? null, o.route, o.multiplier],
      );
    }
    await client.query('COMMIT');
    return obs.length;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

type Row = {
  at: string;
  ticker: string;
  symbol: string;
  mint: string;
  leg: string;
  size_usd: number;
  session: string;
  reference_kind: string;
  status: string;
  reference_e6: string | null;
  per_share_e6: string | null;
  premium_bps_x100: string | null;
  price_impact_bps_x100: string | null;
  route: string | null;
  multiplier: string | null;
};

const big = (v: string | null): bigint | null => (v === null ? null : BigInt(v.split('.')[0] as string));

function toObservation(r: Row): Observation {
  return {
    at: Number(r.at),
    ticker: r.ticker,
    symbol: r.symbol,
    mint: r.mint,
    leg: r.leg as Leg,
    sizeUsd: r.size_usd,
    session: r.session as Session,
    referenceKind: r.reference_kind as ReferenceKind,
    status: r.status as ObservationStatus,
    referenceE6: big(r.reference_e6),
    perShareE6: big(r.per_share_e6),
    premiumBpsX100: big(r.premium_bps_x100),
    priceImpactBpsX100: big(r.price_impact_bps_x100),
    route: r.route,
    multiplier: r.multiplier,
  };
}

/** Every observation of a cluster at or after `since` (unix seconds), oldest first. */
export async function observationsSince(db: pg.Pool, cluster: string, since: number): Promise<Observation[]> {
  const { rows } = await db.query('SELECT * FROM premium_observations WHERE cluster = $1 AND at >= $2 ORDER BY at, id', [cluster, since]);
  return (rows as Row[]).map(toObservation);
}

/** The newest round for each ticker: every observation sharing that ticker's latest `at`. */
export async function latestPerTicker(db: pg.Pool, cluster: string): Promise<Observation[]> {
  const { rows } = await db.query(
    `SELECT o.* FROM premium_observations o
     JOIN (SELECT ticker, MAX(at) AS at FROM premium_observations WHERE cluster = $1 GROUP BY ticker) m ON m.ticker = o.ticker AND m.at = o.at
     WHERE o.cluster = $1 ORDER BY o.ticker, o.size_usd, o.leg`,
    [cluster],
  );
  return (rows as Row[]).map(toObservation);
}

export async function coverage(db: pg.Pool, cluster: string, since: number): Promise<{ rounds: number; tickers: number; first: number | null; last: number | null }> {
  const { rows } = await db.query('SELECT COUNT(DISTINCT at) AS rounds, COUNT(DISTINCT ticker) AS tickers, MIN(at) AS first, MAX(at) AS last FROM premium_observations WHERE cluster = $1 AND at >= $2', [cluster, since]);
  const r = rows[0] as { rounds: string; tickers: string; first: string | null; last: string | null };
  return { rounds: Number(r.rounds), tickers: Number(r.tickers), first: r.first === null ? null : Number(r.first), last: r.last === null ? null : Number(r.last) };
}
