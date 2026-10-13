// GET /v1/crosses/summary (M1): every cross the index holds with the two traits the list filters on (bid disclosure and
// supply mode) already in the row, so the crosses page does not read each cross from chain one by one.
//
// All fields come from the indexer's `crosses` table, which is built from cross_core's own CrossCreated event and kept equal to
// chain by the reconciler. Nothing is derived or defaulted: a value the program never emitted would fail the enum lookup and
// the request would error rather than show a guess.
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';

export type CrossListDeps = { db: pg.Pool };

/** Enum order is the program's: Disclosure { Sealed = 0, Open = 1 } and SupplyMode { Escrow, Mint, DeferredMint }. */
export const DISCLOSURE = ['sealed', 'open'] as const;
export const SUPPLY_MODE = ['escrow', 'mint', 'deferred-mint'] as const;
export const SUMMARY_MAX = 5000;

export type CrossSummaryRow = {
  address: string;
  state: string;
  disclosure: (typeof DISCLOSURE)[number];
  supplyMode: (typeof SUPPLY_MODE)[number];
  /** Orders committed so far (the same count as `orders_committed` in GET /v1/crosses). */
  orders: number;
  openTs: string;
  closeTs: string;
  revealEndTs: string;
  creator: string;
  baseMint: string;
  quoteMint: string;
  clearingPrice: string | null;
  matched: string | null;
};

type DbRow = {
  address: string;
  state: string;
  disclosure: number;
  supply_mode: number;
  orders_committed: number;
  open_ts: string;
  close_ts: string;
  reveal_end_ts: string;
  creator: string;
  base_mint: string;
  quote_mint: string;
  clearing_price: string | null;
  matched: string | null;
};

/** Pure: database rows to the served shape. An enum value outside the program's range throws; it is never mapped to a guess. */
export function shapeSummary(rows: readonly DbRow[]): CrossSummaryRow[] {
  return rows.map((r) => {
    const disclosure = DISCLOSURE[r.disclosure];
    const supplyMode = SUPPLY_MODE[r.supply_mode];
    if (!disclosure || !supplyMode) throw new Error(`cross ${r.address} has an enum value this API does not know (disclosure ${r.disclosure}, supply mode ${r.supply_mode})`);
    return {
      address: r.address,
      state: r.state,
      disclosure,
      supplyMode,
      orders: r.orders_committed,
      openTs: r.open_ts,
      closeTs: r.close_ts,
      revealEndTs: r.reveal_end_ts,
      creator: r.creator,
      baseMint: r.base_mint,
      quoteMint: r.quote_mint,
      clearingPrice: r.clearing_price,
      matched: r.matched,
    };
  });
}

export function registerCrossList(app: FastifyInstance, d: CrossListDeps): void {
  // GET /v1/crosses/summary?limit=1000
  //   Every indexed cross, newest first (by creation slot), capped at `limit` (1 to 5000, default 1000).
  //   200 { count, crosses: [{ address, state, disclosure, supplyMode, orders, openTs, closeTs, revealEndTs, creator, baseMint, quoteMint, clearingPrice, matched }] }
  //   400 bad limit
  // Registered as a static path, which the router ranks above `/v1/crosses/:address`.
  app.get('/v1/crosses/summary', async (req, reply) => {
    const raw = (req.query as { limit?: string }).limit;
    const limit = raw === undefined ? 1000 : Number(raw);
    if (!Number.isInteger(limit) || limit < 1 || limit > SUMMARY_MAX) {
      return reply.code(400).type('application/json').send(JSON.stringify({ error: `limit must be an integer in [1, ${SUMMARY_MAX}]` }));
    }
    const { rows } = await d.db.query<DbRow>(
      `SELECT address, state, disclosure, supply_mode, orders_committed, open_ts::text, close_ts::text, reveal_end_ts::text, creator, base_mint, quote_mint,
              clearing_price::text, matched::text
         FROM crosses ORDER BY created_slot DESC LIMIT $1`,
      [limit],
    );
    const crosses = shapeSummary(rows);
    return reply.code(200).type('application/json').send(JSON.stringify({ count: crosses.length, crosses }));
  });
}
