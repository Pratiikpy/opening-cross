// Applies decoded events to Postgres. One database transaction per chain transaction: the raw
// events are appended to `events` and, only if they were not already there, projected onto
// `crosses` and `orders`. Re-ingesting a signature is therefore a no-op, which lets the source
// replay freely after a crash or a reorg-safe re-scan.
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import { type CrossEvent, decodeLogs, toJson } from './decode.js';

export type ChainTx = { signature: string; slot: bigint; blockTime: bigint | null; logs: readonly string[]; err: unknown };

export async function migrate(db: pg.Pool | pg.Client): Promise<void> {
  const dir = fileURLToPath(new URL('../migrations/', import.meta.url));
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) await db.query(readFileSync(dir + f, 'utf8'));
}

const STATE = ['Live', 'Cleared', 'NoPrint', 'Finalized'] as const;

/** Returns how many events were newly applied (0 when the signature was already ingested or failed). */
export async function ingestTransaction(db: pg.Pool, tx: ChainTx): Promise<number> {
  if (tx.err) return 0; // a failed transaction changes no state, whatever it logged
  const events = decodeLogs(tx.logs);
  if (events.length === 0) return 0;
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    let applied = 0;
    for (const [seq, ev] of events.entries()) {
      const cross = 'cross' in ev.data ? ev.data.cross : null;
      const res = await client.query(
        `INSERT INTO events (signature, seq, slot, block_time, name, cross_address, payload)
         VALUES ($1, $2, $3, to_timestamp($4), $5, $6, $7) ON CONFLICT DO NOTHING`,
        [tx.signature, seq, tx.slot.toString(), tx.blockTime?.toString() ?? null, ev.name, cross, JSON.stringify(toJson(ev.data))],
      );
      if (res.rowCount === 0) continue;
      await apply(client, ev, tx.slot.toString());
      applied++;
    }
    await client.query('COMMIT');
    return applied;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function apply(db: pg.PoolClient, ev: CrossEvent, slot: string): Promise<void> {
  switch (ev.name) {
    case 'CrossCreated': {
      const d = ev.data;
      await db.query(
        `INSERT INTO crosses (address, creator, kind, supply_mode, disclosure, base_mint, quote_mint, open_ts, close_ts,
           reveal_end_ts, protocol_fee_bps, integrator_fee_bps, state, created_slot, updated_slot)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'Live',$13,$13)`,
        [d.cross, d.creator, d.kind, d.supplyMode, d.disclosure, d.baseMint, d.quoteMint, d.openTs.toString(), d.closeTs.toString(),
          d.revealEndTs.toString(), d.protocolFeeBps, d.integratorFeeBps, slot],
      );
      return;
    }
    case 'OrderCommitted': {
      const d = ev.data;
      await db.query(
        `INSERT INTO orders (cross_address, idx, address, owner, side, escrow, sealed, status, created_slot, updated_slot)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)`,
        [d.cross, d.index, d.order, d.owner, d.side, d.escrow.toString(), d.sealed, d.sealed ? 'committed' : 'revealed', slot],
      );
      await db.query(`UPDATE crosses SET orders_committed = orders_committed + 1, updated_slot = $2 WHERE address = $1`, [d.cross, slot]);
      return;
    }
    case 'OrderRevealed': {
      const d = ev.data;
      await db.query(
        `UPDATE orders SET price = $3, quantity = $4, status = 'revealed', updated_slot = $5
         WHERE cross_address = $1 AND address = $2 AND status IN ('committed', 'revealed')`,
        [d.cross, d.order, d.price.toString(), d.quantity.toString(), slot],
      );
      return;
    }
    case 'OrderCancelled':
      await db.query(`UPDATE orders SET status = 'cancelled', updated_slot = $3 WHERE cross_address = $1 AND address = $2 AND status <> 'claimed'`, [ev.data.cross, ev.data.order, slot]);
      return;
    case 'CrossCleared': {
      const d = ev.data;
      const c = d.clearing.__option === 'Some' ? d.clearing.value : null;
      await db.query(
        `UPDATE crosses SET state = $2, clearing_price = $3, matched = $4, rationed = $5, no_print_reason = $6, updated_slot = $7 WHERE address = $1`,
        [d.cross, d.printed ? 'Cleared' : 'NoPrint', c?.price.toString() ?? null, c?.matched.toString() ?? null, c?.rationed ?? null,
          d.noPrintReason.__option === 'Some' ? d.noPrintReason.value : null, slot],
      );
      return;
    }
    case 'OrderClaimed': {
      const d = ev.data;
      await db.query(
        `UPDATE orders SET status = 'claimed', fill = $3, quote_out = $4, base_out = $5, fee = $6, updated_slot = $7 WHERE cross_address = $1 AND address = $2`,
        [d.cross, d.order, d.fill.toString(), d.quoteOut.toString(), d.baseOut.toString(), d.fee.toString(), slot],
      );
      return;
    }
    case 'BaseMintBound':
      await db.query(`UPDATE crosses SET base_bound_mint = $2, base_mint = $2, updated_slot = $3 WHERE address = $1`, [ev.data.cross, ev.data.baseMint, slot]);
      return;
    case 'CrossFinalized': {
      const d = ev.data;
      await db.query(
        `UPDATE crosses SET state = $2, protocol_fee = $3, integrator_fee = $4, proceeds_quote = $5, dust_base = $6, updated_slot = $7 WHERE address = $1`,
        [d.cross, STATE[3], d.protocolFee.toString(), d.integratorFee.toString(), d.proceedsQuote.toString(), d.dustBase.toString(), slot],
      );
      return;
    }
    case 'PauseChanged':
      return; // global flag; kept in `events` only
  }
}
