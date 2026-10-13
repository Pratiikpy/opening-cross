// Launch replay (S12): the ordered on-chain events of a cross, and a listing of recent crosses with a summary each.
// Everything comes from the indexer's `events` and `crosses` tables, which are built only from cross_core's own event
// logs; nothing is inferred or filled in. A time the indexer did not record (block_time null) is reported as null.
import type pg from 'pg';

const KIND: Record<string, string> = {
  CrossCreated: 'created',
  OrderCommitted: 'order_placed',
  OrderRevealed: 'order_revealed',
  OrderCancelled: 'order_cancelled',
  CrossCleared: 'cleared',
  OrderClaimed: 'order_claimed',
  BaseMintBound: 'base_mint_bound',
  CrossFinalized: 'finalized',
  // The rules extension (ADR-0450 to ADR-0462).
  RulesSet: 'rules_set',
  OrderPlacement: 'order_placement',
  DrawStarted: 'draw_started',
  DrawFinished: 'draw_finished',
  ExtensionPending: 'extension_pending',
  InsiderChallenged: 'insider_challenged',
  ChallengeResolved: 'challenge_resolved',
  ChallengeExpired: 'challenge_expired',
  LockCreated: 'lock_created',
  LockReleased: 'lock_released',
  PrintFed: 'print_fed',
};

export type ReplayEvent = {
  /** 1-based position in the cross's history. */
  n: number;
  kind: string;
  event: string;
  slot: string;
  time: string | null;
  signature: string;
  /** The event's own fields as the program emitted them; for an open order, its limit price and quantity from the commit. */
  details: Record<string, unknown>;
};

export type EventRow = { signature: string; seq: number; slot: string; time: Date | null; name: string; payload: Record<string, unknown> };
export type OrderTerm = { price: string | null; quantity: string | null };

/** Pure: rows in chain order -> replay events. `terms` maps an order address to the limit terms recovered at commit. */
export function replayOf(rows: EventRow[], terms: ReadonlyMap<string, OrderTerm>): ReplayEvent[] {
  return rows.map((r, i) => {
    const details: Record<string, unknown> = { ...r.payload };
    if (r.name === 'OrderCommitted' && r.payload.sealed === false) {
      const t = terms.get(String(r.payload.order));
      if (t?.price != null) details.price = t.price;
      if (t?.quantity != null) details.quantity = t.quantity;
    }
    return { n: i + 1, kind: KIND[r.name] ?? r.name, event: r.name, slot: String(r.slot), time: r.time ? r.time.toISOString() : null, signature: r.signature, details };
  });
}

/** One cross's row and its events in chain order (slot, then transaction, then position inside it); null if the index has no such cross. */
export async function replayRow(db: pg.Pool, cross: string) {
  const crossRow = (await db.query(`SELECT * FROM crosses WHERE address = $1`, [cross])).rows[0];
  if (!crossRow) return null;
  const events = (
    await db.query(`SELECT signature, seq, slot::text AS slot, block_time AS time, name, payload FROM events WHERE cross_address = $1 ORDER BY slot, signature, seq`, [cross])
  ).rows as EventRow[];
  const terms = new Map<string, OrderTerm>();
  for (const o of (await db.query(`SELECT address, price::text AS price, quantity::text AS quantity FROM orders WHERE cross_address = $1 AND sealed = false`, [cross])).rows) {
    terms.set(o.address, { price: o.price, quantity: o.quantity });
  }
  return { cross: crossRow, events: replayOf(events, terms) };
}

/** Crosses that opened within the last `days` days, newest first, each with the figures a reader scans: outcome, orders, wallets, timings. */
export async function recentReplays(db: pg.Pool, days: number, limit: number, nowSeconds: number) {
  const { rows } = await db.query(
    `SELECT c.address, c.state, c.kind, c.disclosure, c.base_mint, c.quote_mint, c.open_ts::text, c.close_ts::text, c.reveal_end_ts::text,
            c.clearing_price::text, c.matched::text, c.no_print_reason, c.orders_committed, c.proceeds_quote::text,
            (SELECT count(DISTINCT owner)::int FROM orders o WHERE o.cross_address = c.address) AS wallets,
            (SELECT count(*)::int FROM orders o WHERE o.cross_address = c.address AND o.status = 'claimed') AS claimed,
            (SELECT count(*)::int FROM orders o WHERE o.cross_address = c.address AND o.status = 'cancelled') AS cancelled,
            (SELECT count(*)::int FROM events e WHERE e.cross_address = c.address) AS events,
            (SELECT min(block_time) FROM events e WHERE e.cross_address = c.address AND e.name = 'OrderCommitted') AS first_order_at,
            (SELECT min(block_time) FROM events e WHERE e.cross_address = c.address AND e.name = 'CrossCleared') AS cleared_at,
            (SELECT min(block_time) FROM events e WHERE e.cross_address = c.address AND e.name = 'CrossFinalized') AS finalized_at
       FROM crosses c WHERE c.open_ts >= $1 ORDER BY c.open_ts DESC, c.created_slot DESC LIMIT $2`,
    [nowSeconds - days * 86_400, limit],
  );
  return rows.map((r) => ({
    address: r.address as string,
    state: r.state as string,
    kind: ['launch', 'reopen', 'tender', 'recurring'][r.kind] ?? null,
    disclosure: r.disclosure === 1 ? 'open' : 'sealed',
    baseMint: r.base_mint as string,
    quoteMint: r.quote_mint as string,
    window: { openTs: r.open_ts as string, closeTs: r.close_ts as string, revealEndTs: r.reveal_end_ts as string },
    outcome: r.clearing_price === null ? (r.state === 'Live' ? 'live' : 'no print') : 'printed',
    clearingPrice: r.clearing_price as string | null,
    matched: r.matched as string | null,
    proceedsQuote: r.proceeds_quote as string | null,
    orders: { placed: r.orders_committed as number, wallets: r.wallets as number, claimed: r.claimed as number, cancelled: r.cancelled as number },
    events: r.events as number,
    firstOrderAt: r.first_order_at ? (r.first_order_at as Date).toISOString() : null,
    clearedAt: r.cleared_at ? (r.cleared_at as Date).toISOString() : null,
    finalizedAt: r.finalized_at ? (r.finalized_at as Date).toISOString() : null,
  }));
}
