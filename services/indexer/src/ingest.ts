// Applies decoded events to Postgres. One database transaction per chain transaction: the raw
// events are appended to `events` and, only if they were not already there, projected onto
// `crosses` and `orders`. Re-ingesting a signature is therefore a no-op, which lets the source
// replay freely after a crash or a reorg-safe re-scan.
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import { type CrossEvent, decodeLogs, toJson } from './decode.js';
import type { CommitFacts, OrderTerms } from './order-terms.js';

export type ChainTx = {
  signature: string;
  slot: bigint;
  blockTime: bigint | null;
  logs: readonly string[];
  err: unknown;
  /** Limit price and quantity of the open orders this transaction committed, by order account (see order-terms.ts). */
  terms?: ReadonlyMap<string, OrderTerms>;
  /** Nonce, class and lockup of the orders this transaction committed, sealed or open (see order-terms.ts). */
  facts?: ReadonlyMap<string, CommitFacts>;
};

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
      await apply(client, ev, tx.slot.toString(), { terms: tx.terms, facts: tx.facts, events, index: seq, signature: tx.signature });
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

type Ctx = { terms?: ReadonlyMap<string, OrderTerms> | undefined; facts?: ReadonlyMap<string, CommitFacts> | undefined; events: readonly CrossEvent[]; index: number; signature: string };

async function apply(db: pg.PoolClient, ev: CrossEvent, slot: string, ctx: Ctx): Promise<void> {
  const { terms } = ctx;
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
      // An open order is never revealed, so its terms come from the commit instruction itself.
      const t = d.sealed ? undefined : terms?.get(d.order);
      const f = ctx.facts?.get(d.order);
      await db.query(
        `INSERT INTO orders (cross_address, idx, address, owner, side, escrow, sealed, status, price, quantity, created_slot, updated_slot, nonce, class, lock_secs)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11,$12,$13,$14)`,
        [d.cross, d.index, d.order, d.owner, d.side, d.escrow.toString(), d.sealed, d.sealed ? 'committed' : 'revealed', t?.price.toString() ?? null, t?.quantity.toString() ?? null, slot, f?.nonce.toString() ?? null, f?.class ?? null, f?.lockSecs ?? null],
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
    case 'AdminProposed':
    case 'AdminChanged':
      return; // protocol administration; kept in `events` only
    case 'RulesSet': {
      const d = ev.data;
      const j = toJson(d) as Record<string, unknown>;
      await db.query(
        `INSERT INTO cross_rules (cross_address, flags, guards, ending, identity, alloc, insiders, bond_quote, set_slot)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (cross_address) DO NOTHING`,
        [d.cross, d.flags, JSON.stringify(j.guards), JSON.stringify(j.ending), JSON.stringify(j.identity), JSON.stringify(j.alloc), d.insiders, d.bondQuote.toString(), slot],
      );
      return;
    }
    case 'CrossExtSnapshot': {
      await db.query(`UPDATE cross_rules SET ext = $2, ext_slot = $3 WHERE cross_address = $1`, [ev.data.cross, JSON.stringify(toJson(ev.data.ext)), slot]);
      return;
    }
    case 'OrderPlacement': {
      const d = ev.data;
      const x = d.ext;
      await db.query(
        `INSERT INTO order_placements (order_address, cross_address, epoch, bucket, class, flags, lock_cliff, lock_vest, placed_ts, ticket, slot)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (order_address) DO NOTHING`,
        [d.order, d.cross, x.epoch, x.bucket, x.class, x.flags, x.lockCliff, x.lockVest, x.placedTs.toString(), x.ticket, slot],
      );
      return;
    }
    case 'DrawStarted':
      await db.query(`UPDATE cross_rules SET draw_pending_slot = $2, draw_pending_purpose = $3 WHERE cross_address = $1`, [ev.data.cross, ev.data.slot.toString(), ev.data.purpose]);
      return;
    case 'DrawFinished': {
      const d = ev.data;
      // purpose 1 = the ending draw (sets the last counted bucket), 2 = the extension (opens a new epoch and moves the close).
      await db.query(
        `UPDATE cross_rules SET draw_pending_slot = NULL, draw_pending_purpose = NULL, draw_seed = $2, draw_finished_slot = $3,
           end_bucket = CASE WHEN $4::int = 1 AND $5::int <> 255 THEN $5::int ELSE end_bucket END,
           draw_epoch = CASE WHEN $4::int = 2 THEN $6::int + 1 ELSE draw_epoch END,
           extension_pending = CASE WHEN $4::int = 2 THEN false ELSE extension_pending END
         WHERE cross_address = $1`,
        [d.cross, Buffer.from(d.seed).toString('hex'), slot, d.purpose, d.endBucket, d.epoch],
      );
      if (d.purpose === 2) {
        // The extension moved the close; the reveal window keeps its length.
        await db.query(`UPDATE crosses SET reveal_end_ts = $2::bigint + (reveal_end_ts - close_ts), close_ts = $2::bigint, updated_slot = $3 WHERE address = $1`, [d.cross, d.closeTs.toString(), slot]);
      }
      return;
    }
    case 'ExtensionPending':
      await db.query(`UPDATE cross_rules SET extension_pending = true, extension_reason = $2 WHERE cross_address = $1`, [ev.data.cross, ev.data.reason]);
      return;
    case 'InsiderChallenged': {
      const d = ev.data;
      await db.query(
        `INSERT INTO cross_challenges (cross_address, id, challenger, subject, evidence, status, filed_slot) VALUES ($1,$2,$3,$4,$5,'Open',$6) ON CONFLICT DO NOTHING`,
        [d.cross, d.id, d.challenger, d.subject, Buffer.from(d.evidence).toString('hex'), slot],
      );
      return;
    }
    case 'ChallengeResolved':
      await db.query(`UPDATE cross_challenges SET status = $3, slash = $4, resolved_slot = $5 WHERE cross_address = $1 AND id = $2`, [ev.data.cross, ev.data.id, ev.data.upheld ? 'Upheld' : 'Rejected', ev.data.slash.toString(), slot]);
      return;
    case 'ChallengeExpired':
      await db.query(`UPDATE cross_challenges SET status = 'Expired', resolved_slot = $3 WHERE cross_address = $1 AND id = $2`, [ev.data.cross, ev.data.id, slot]);
      return;
    case 'LockCreated': {
      const d = ev.data;
      // The claim that created the lock emitted OrderClaimed for the same cross and owner in this transaction: the nearest one before it, else after.
      let order: string | null = null;
      for (let i = ctx.index; i >= 0 && order === null; i--) {
        const e = ctx.events[i];
        if (e?.name === 'OrderClaimed' && e.data.cross === d.cross && e.data.owner === d.owner) order = e.data.order;
      }
      for (let i = ctx.index + 1; i < ctx.events.length && order === null; i++) {
        const e = ctx.events[i];
        if (e?.name === 'OrderClaimed' && e.data.cross === d.cross && e.data.owner === d.owner) order = e.data.order;
      }
      const nonce = order ? ((await db.query(`SELECT nonce FROM orders WHERE cross_address = $1 AND address = $2`, [d.cross, order])).rows[0]?.nonce ?? null) : null;
      await db.query(
        `INSERT INTO cross_locks (cross_address, owner, order_address, nonce, amount, start_ts, cliff_secs, vest_secs, created_slot, signature, seq)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING`,
        [d.cross, d.owner, order, nonce, d.amount.toString(), d.startTs.toString(), d.cliffSecs, d.vestSecs, slot, ctx.signature, ctx.index],
      );
      return;
    }
    case 'LockReleased': {
      // The event names no lock. An owner's releases are credited to their earliest lock that still has something left; the chain's lockup
      // account (cross, owner, nonce) is the exact record and the API reads it.
      const d = ev.data;
      await db.query(
        `UPDATE cross_locks SET released = released + $3::numeric WHERE (signature, seq) = (
           SELECT signature, seq FROM cross_locks WHERE cross_address = $1 AND owner = $2 AND released < amount ORDER BY created_slot, seq LIMIT 1)`,
        [d.cross, d.owner, d.amount.toString()],
      );
      return;
    }
    case 'HaltChanged': {
      const d = ev.data;
      await db.query(
        `INSERT INTO halt_states (base_mint, halted, reason, changed_slot) VALUES ($1,$2,$3,$4)
         ON CONFLICT (base_mint) DO UPDATE SET halted = EXCLUDED.halted, reason = EXCLUDED.reason, changed_slot = EXCLUDED.changed_slot, changes = halt_states.changes + 1`,
        [d.baseMint, d.halted, d.reason, slot],
      );
      return;
    }
    case 'PrintFed': {
      const d = ev.data;
      await db.query(`INSERT INTO print_feed_prints (base_mint, cross_address, price, matched, slot) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, [d.baseMint, d.cross, d.price.toString(), d.matched.toString(), slot]);
      return;
    }
    case 'SeriesCreated':
      await db.query(`INSERT INTO series (address, authority, created_slot) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [ev.data.series, ev.data.authority, slot]);
      return;
    case 'SeriesSpawned':
      await db.query(`INSERT INTO series_crosses (series, idx, cross_address, close_ts, slot) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, [ev.data.series, ev.data.index.toString(), ev.data.cross, ev.data.closeTs.toString(), slot]);
      return;
  }
}
