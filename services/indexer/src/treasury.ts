// Indexer for the ownership-coin treasury program (programs/treasury, ADR-0014).
//
// Same discipline as the cross_core indexer: events are attributed by the invoke stack (a data line counts only while the treasury
// program is on top, so a look-alike payload written by another program is ignored), a failed transaction changes nothing, one
// database transaction per chain transaction, and a signature already ingested is a no-op. The poller reads at `finalized` and keeps
// its own cursor in the shared `cursors` table under `rpc:<treasury program>`.
//
// Not in the events, so not indexed: the attestation being renewed (`record_attested` emits nothing) and the current period's spend
// window. The API reads those from the treasury account itself.
import type { Address, Signature } from '@solana/kit';
import type pg from 'pg';
import {
  ATTESTATION_LAPSED_EVENT_DISCRIMINATOR,
  LIQUIDATION_STARTED_EVENT_DISCRIMINATOR,
  REDEEMED_EVENT_DISCRIMINATOR,
  SPENT_EVENT_DISCRIMINATOR,
  TREASURY_CREATED_EVENT_DISCRIMINATOR,
  TREASURY_PROGRAM_ADDRESS,
  type AttestationLapsedEvent,
  type LiquidationStartedEvent,
  type RedeemedEvent,
  type SpentEvent,
  type TreasuryCreatedEvent,
  getAttestationLapsedEventDecoder,
  getLiquidationStartedEventDecoder,
  getRedeemedEventDecoder,
  getSpentEventDecoder,
  getTreasuryCreatedEventDecoder,
} from '@opening-cross/treasury-client';
import { UnattributableLogs, toJson } from './decode.js';
import type { ChainTx } from './ingest.js';
import type { IndexerRpc as Rpc } from './rpc.js';

export type TreasuryEventRecord =
  | { name: 'TreasuryCreated'; data: TreasuryCreatedEvent }
  | { name: 'Spent'; data: SpentEvent }
  | { name: 'AttestationLapsed'; data: AttestationLapsedEvent }
  | { name: 'LiquidationStarted'; data: LiquidationStartedEvent }
  | { name: 'Redeemed'; data: RedeemedEvent };

const DECODERS: [Uint8Array, TreasuryEventRecord['name'], { decode(b: Uint8Array): unknown }][] = [
  [TREASURY_CREATED_EVENT_DISCRIMINATOR as Uint8Array, 'TreasuryCreated', getTreasuryCreatedEventDecoder()],
  [SPENT_EVENT_DISCRIMINATOR as Uint8Array, 'Spent', getSpentEventDecoder()],
  [ATTESTATION_LAPSED_EVENT_DISCRIMINATOR as Uint8Array, 'AttestationLapsed', getAttestationLapsedEventDecoder()],
  [LIQUIDATION_STARTED_EVENT_DISCRIMINATOR as Uint8Array, 'LiquidationStarted', getLiquidationStartedEventDecoder()],
  [REDEEMED_EVENT_DISCRIMINATOR as Uint8Array, 'Redeemed', getRedeemedEventDecoder()],
];

const INVOKE = /^Program (\w+) invoke \[\d+\]$/;
const EXIT = /^Program (\w+) (success|failed)/;
const DATA = 'Program data: ';

/** Treasury events written while the treasury program is the innermost running program. */
export function decodeTreasuryLogs(logs: readonly string[], program: Address = TREASURY_PROGRAM_ADDRESS): TreasuryEventRecord[] {
  const stack: string[] = [];
  const out: TreasuryEventRecord[] = [];
  for (const line of logs) {
    if (line === 'Log truncated') throw new UnattributableLogs('log output was truncated by the runtime');
    const inv = INVOKE.exec(line);
    if (inv) {
      stack.push(inv[1]!);
      continue;
    }
    const ex = EXIT.exec(line);
    if (ex) {
      if (stack.at(-1) !== ex[1]) throw new UnattributableLogs(`unbalanced exit for ${ex[1]}`);
      stack.pop();
      continue;
    }
    if (!line.startsWith(DATA) || stack.at(-1) !== program) continue;
    const bytes = Uint8Array.from(Buffer.from(line.slice(DATA.length), 'base64'));
    const match = DECODERS.find(([d]) => bytes.length >= 8 && d.every((b, i) => bytes[i] === b));
    if (!match) continue;
    out.push({ name: match[1], data: match[2].decode(bytes) } as TreasuryEventRecord);
  }
  return out;
}

/** Returns how many events were newly applied (0 when the signature was already ingested or failed). */
export async function ingestTreasuryTransaction(db: pg.Pool, tx: ChainTx): Promise<number> {
  if (tx.err) return 0;
  const events = decodeTreasuryLogs(tx.logs);
  if (events.length === 0) return 0;
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    let applied = 0;
    for (const [seq, ev] of events.entries()) {
      const res = await client.query(
        `INSERT INTO treasury_events (signature, seq, slot, block_time, name, treasury, payload)
         VALUES ($1, $2, $3, to_timestamp($4), $5, $6, $7) ON CONFLICT DO NOTHING`,
        [tx.signature, seq, tx.slot.toString(), tx.blockTime?.toString() ?? null, ev.name, ev.data.treasury, JSON.stringify(toJson(ev.data))],
      );
      if (res.rowCount === 0) continue;
      await apply(client, ev, tx);
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

async function apply(db: pg.PoolClient, ev: TreasuryEventRecord, tx: ChainTx): Promise<void> {
  const slot = tx.slot.toString();
  const at = tx.blockTime?.toString() ?? null;
  switch (ev.name) {
    case 'TreasuryCreated': {
      const d = ev.data;
      await db.query(
        `INSERT INTO treasuries (address, coin_mint, authority, allowance, period_secs, created_signature, created_slot, created_at, state, updated_slot)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'Active',$7) ON CONFLICT (address) DO NOTHING`,
        [d.treasury, d.coinMint, d.authority, d.allowance.toString(), d.periodSecs.toString(), tx.signature, slot, at],
      );
      return;
    }
    case 'Spent':
      await db.query(`UPDATE treasuries SET spent_total = spent_total + $2, spend_count = spend_count + 1, updated_slot = $3 WHERE address = $1`, [ev.data.treasury, ev.data.amount.toString(), slot]);
      return;
    case 'AttestationLapsed':
      await db.query(`UPDATE treasuries SET lapse_count = lapse_count + 1, last_lapse_at = $2, updated_slot = $3 WHERE address = $1`, [ev.data.treasury, ev.data.at.toString(), slot]);
      return;
    case 'LiquidationStarted':
      await db.query(`UPDATE treasuries SET state = 'Liquidating', liquidation_vault = $2, liquidation_supply = $3, liquidated_at = $4, updated_slot = $5 WHERE address = $1`, [ev.data.treasury, ev.data.vault.toString(), ev.data.supply.toString(), at, slot]);
      return;
    case 'Redeemed':
      await db.query(
        `UPDATE treasuries SET redeemed_burned = redeemed_burned + $2, redeemed_paid = redeemed_paid + $3, redemption_count = redemption_count + 1, updated_slot = $4 WHERE address = $1`,
        [ev.data.treasury, ev.data.burned.toString(), ev.data.paid.toString(), slot],
      );
      return;
  }
}

/** Signatures newer than `until` (exclusive), newest first. */
async function listSince(rpc: Rpc, program: Address, until: Signature | undefined) {
  const out: { signature: Signature; slot: bigint }[] = [];
  let before: Signature | undefined;
  for (;;) {
    const page = await rpc.getSignaturesForAddress(program, { commitment: 'finalized', limit: 1000, ...(until && { until }), ...(before && { before }) }).send();
    if (page.length === 0) break;
    for (const s of page) out.push({ signature: s.signature, slot: s.slot });
    before = page.at(-1)!.signature;
    if (page.length < 1000) break;
  }
  return out;
}

/**
 * One pass: ingest every finalized treasury-program transaction after the stored cursor, oldest first, advancing the cursor only
 * after each commits. Returns the number of events applied.
 */
export async function pollTreasuryOnce(db: pg.Pool, rpc: Rpc, program: Address = TREASURY_PROGRAM_ADDRESS, source = `rpc:${program}`): Promise<number> {
  const { rows } = await db.query('SELECT last_signature FROM cursors WHERE source = $1', [source]);
  const until = (rows[0]?.last_signature ?? undefined) as Signature | undefined;
  const pending = await listSince(rpc, program, until);
  pending.reverse();
  let applied = 0;
  const opts = { maxSupportedTransactionVersion: 0, encoding: 'json' } as const;
  for (const s of pending) {
    // The listing already said finalized, so the body is final; if the node cannot return it at that level, read it at confirmed.
    const tx =
      (await rpc.getTransaction(s.signature, { ...opts, commitment: 'finalized' }).send().catch(() => null)) ??
      (await rpc.getTransaction(s.signature, { ...opts, commitment: 'confirmed' }).send());
    if (!tx) throw new Error(`getTransaction(${s.signature}) returned nothing at finalized or confirmed`);
    applied += await ingestTreasuryTransaction(db, {
      signature: s.signature,
      slot: tx.slot,
      blockTime: tx.blockTime === null ? null : BigInt(tx.blockTime),
      logs: tx.meta?.logMessages ?? [],
      err: tx.meta?.err ?? null,
    });
    await db.query(
      `INSERT INTO cursors (source, last_signature, last_slot) VALUES ($1, $2, $3)
       ON CONFLICT (source) DO UPDATE SET last_signature = EXCLUDED.last_signature, last_slot = EXCLUDED.last_slot`,
      [source, s.signature, s.slot.toString()],
    );
  }
  return applied;
}
