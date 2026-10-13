// Where events come from. The production source is the indexer's `events` table; the interface is small so a test (or another
// store) can stand in for it. Positions are the table's `ingest_id` (migration 009), a total order that matches ingestion order.
import type pg from 'pg';

export type EventRow = {
  /** Strictly increasing in ingestion order. */
  position: bigint;
  signature: string;
  seq: number;
  slot: bigint;
  /** Unix seconds, or null when the cluster reported no block time. */
  blockTime: bigint | null;
  name: string;
  cross: string | null;
  /** The decoded event as the indexer stored it (64-bit integers as decimal strings, options as `{ __option }`). */
  payload: Record<string, unknown>;
};

export type EventFilter = { crosses?: ReadonlySet<string>; events?: ReadonlySet<string> };

export interface EventSource {
  /** Up to `limit` events with a position greater than `after`, in position order, that pass the filter. */
  next(after: bigint, limit: number, filter: EventFilter): Promise<EventRow[]>;
  /** The newest position and the number of events. Position 0 and count 0 for an empty log. */
  head(): Promise<{ position: bigint; events: bigint }>;
}

type Row = { ingest_id: string; signature: string; seq: number; slot: string; block_time: string | null; name: string; cross_address: string | null; payload: Record<string, unknown> };

export class PostgresEventSource implements EventSource {
  constructor(private readonly db: pg.Pool) {}

  async next(after: bigint, limit: number, filter: EventFilter): Promise<EventRow[]> {
    const crosses = filter.crosses?.size ? [...filter.crosses] : null;
    const events = filter.events?.size ? [...filter.events] : null;
    const { rows } = await this.db.query<Row>(
      `SELECT ingest_id::text, signature, seq, slot::text, extract(epoch FROM block_time)::bigint::text AS block_time, name, cross_address, payload
         FROM events
        WHERE ingest_id > $1 AND ($2::text[] IS NULL OR cross_address = ANY($2)) AND ($3::text[] IS NULL OR name = ANY($3))
        ORDER BY ingest_id LIMIT $4`,
      [after.toString(), crosses, events, limit],
    );
    return rows.map((r) => ({ position: BigInt(r.ingest_id), signature: r.signature, seq: r.seq, slot: BigInt(r.slot), blockTime: r.block_time === null ? null : BigInt(r.block_time), name: r.name, cross: r.cross_address, payload: r.payload }));
  }

  async head(): Promise<{ position: bigint; events: bigint }> {
    const { rows } = await this.db.query<{ position: string | null; events: string }>('SELECT max(ingest_id)::text AS position, count(*)::text AS events FROM events');
    return { position: BigInt(rows[0]!.position ?? '0'), events: BigInt(rows[0]!.events) };
  }
}
