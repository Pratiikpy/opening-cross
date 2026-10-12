// Compares the indexed view with chain state. Events can be lost to log truncation or a source
// outage, so the chain is the source of truth: every disagreement is returned and recorded in
// `reconciliation_alerts` for an operator (or the API's health check) to act on.
import type { Address } from '@solana/kit';
import type pg from 'pg';
import { CrossState, getCrossDecoder } from '@opening-cross/cross-core-client';

export type AccountFetcher = (address: Address) => Promise<Uint8Array | null>;
export type Drift = { cross: string; field: string; indexed: string | null; onchain: string | null };

const STATE = ['Live', 'Cleared', 'NoPrint', 'Finalized'];

export async function reconcile(db: pg.Pool, fetch: AccountFetcher, opts: { record?: boolean } = {}): Promise<Drift[]> {
  const drift: Drift[] = [];
  const { rows: crosses } = await db.query('SELECT * FROM crosses ORDER BY created_slot');
  for (const row of crosses) {
    const push = (field: string, indexed: unknown, onchain: unknown) => {
      const a = indexed === null || indexed === undefined ? null : String(indexed);
      const b = onchain === null || onchain === undefined ? null : String(onchain);
      if (a !== b) drift.push({ cross: row.address, field, indexed: a, onchain: b });
    };
    const data = await fetch(row.address);
    if (!data) {
      push('exists', true, false);
      continue;
    }
    const c = getCrossDecoder().decode(data);
    const clr = c.clearing.__option === 'Some' ? c.clearing.value : null;
    push('state', row.state, STATE[c.state]);
    push('base_mint', row.base_mint, c.baseMint);
    push('orders_committed', row.orders_committed, c.ordersTotal);
    if (c.state !== CrossState.Live) {
      push('clearing_price', row.clearing_price, clr?.price ?? null);
      push('matched', row.matched, clr?.matched ?? null);
      push('no_print_reason', row.no_print_reason, c.noPrintReason.__option === 'Some' ? c.noPrintReason.value : null);
    }
    // Open orders must still have their account; claimed and cancelled ones are closed on chain.
    const { rows: orders } = await db.query('SELECT idx, address, status FROM orders WHERE cross_address = $1 ORDER BY idx', [row.address]);
    let open = 0;
    for (const o of orders) {
      const live = o.status === 'committed' || o.status === 'revealed';
      if (live) open++;
      const exists = (await fetch(o.address)) !== null;
      if (exists !== live) drift.push({ cross: row.address, field: `order[${o.idx}].exists`, indexed: String(live), onchain: String(exists) });
    }
    push('orders_open', open, c.ordersOpen);
  }
  if (opts.record && drift.length) {
    for (const d of drift) {
      await db.query('INSERT INTO reconciliation_alerts (cross_address, field, indexed, onchain) VALUES ($1,$2,$3,$4)', [d.cross, d.field, d.indexed, d.onchain]);
    }
  }
  return drift;
}

/**
 * Reconciles allowing for ingestion lag. The indexer follows finalized transactions and the reconciler reads
 * finalized accounts a moment later, so on a busy cluster a cross can already have moved on chain while its
 * transactions are still being ingested. Disagreement that disappears once ingestion catches up is lag, not
 * drift: `catchUp` is run (and the comparison repeated) up to `attempts` times, and only what persists is
 * returned — and recorded, when `record` is set.
 */
export async function reconcileSettled(
  db: pg.Pool,
  fetch: AccountFetcher,
  catchUp: () => Promise<unknown>,
  opts: { attempts?: number; waitMs?: number; record?: boolean } = {},
): Promise<Drift[]> {
  let drift = await reconcile(db, fetch);
  for (let i = 0; drift.length > 0 && i < (opts.attempts ?? 3); i++) {
    await new Promise((r) => setTimeout(r, opts.waitMs ?? 10_000));
    await catchUp();
    drift = await reconcile(db, fetch);
  }
  return drift.length > 0 && opts.record ? reconcile(db, fetch, { record: true }) : drift;
}
