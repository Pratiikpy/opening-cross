// Polls an RPC node for cross_core transactions at `finalized` commitment, so nothing ingested can
// be rolled back. Signatures are walked newest-to-oldest back to the stored cursor, then ingested
// oldest-first; the cursor advances only after each transaction commits, so a crash resumes at the
// first transaction not yet applied. (A Yellowstone gRPC source can replace this; see HUMAN_TASKS H7.)
import type { Address, Signature } from '@solana/kit';
import type pg from 'pg';
import { CROSS_CORE_PROGRAM_ADDRESS } from '@opening-cross/cross-core-client';
import { ingestTransaction } from './ingest.js';
import { type TxBody, commitTerms } from './order-terms.js';
import type { IndexerRpc as Rpc } from './rpc.js';

/** Last cursor we warned about, so a node that keeps rejecting it logs once, not every poll. */
let warnedCursor: string | undefined;

export async function pollOnce(db: pg.Pool, rpc: Rpc, program: Address = CROSS_CORE_PROGRAM_ADDRESS, source = `rpc:${program}`): Promise<number> {
  const { rows } = await db.query('SELECT last_signature, last_slot FROM cursors WHERE source = $1', [source]);
  const until = (rows[0]?.last_signature ?? undefined) as Signature | undefined;
  const lastSlot = rows[0]?.last_slot === undefined || rows[0]?.last_slot === null ? null : BigInt(rows[0].last_slot);
  let pending: { signature: Signature; slot: bigint }[];
  try {
    pending = await listSince(rpc, program, until, null);
  } catch (e) {
    // The cursor signature is an optimisation, not a source of truth. If the node rejects it,
    // page back by slot instead; ingestion is idempotent, so re-reading the cursor's slot is harmless.
    if (!until || lastSlot === null) throw new Error(`getSignaturesForAddress failed: ${String(e)}`);
    if (warnedCursor !== until) {
      warnedCursor = until;
      console.error(JSON.stringify({ at: new Date().toISOString(), warning: 'cursor signature rejected by getSignaturesForAddress(until); listing by slot', until, lastSlot: lastSlot.toString(), error: String(e) }));
    }
    pending = await listSince(rpc, program, undefined, lastSlot);
  }
  let applied = 0;
  pending.reverse();
  for (const s of pending) {
    const tx = await fetchFinalized(rpc, s.signature);
    applied += await ingestTransaction(db, {
      signature: s.signature,
      slot: tx.slot,
      blockTime: tx.blockTime === null ? null : BigInt(tx.blockTime),
      logs: tx.meta?.logMessages ?? [],
      err: tx.meta?.err ?? null,
      terms: commitTerms(tx as unknown as TxBody),
    });
    await db.query(
      `INSERT INTO cursors (source, last_signature, last_slot) VALUES ($1, $2, $3)
       ON CONFLICT (source) DO UPDATE SET last_signature = EXCLUDED.last_signature, last_slot = EXCLUDED.last_slot`,
      [source, s.signature, s.slot.toString()],
    );
  }
  return applied;
}

/** Signatures newer than `until` (exclusive), or at or after `fromSlot`, newest first. */
async function listSince(rpc: Rpc, program: Address, until: Signature | undefined, fromSlot: bigint | null) {
  const out: { signature: Signature; slot: bigint }[] = [];
  let before: Signature | undefined;
  for (;;) {
    const page = await rpc.getSignaturesForAddress(program, { commitment: 'finalized', limit: 1000, ...(until && { until }), ...(before && { before }) }).send();
    if (page.length === 0) break;
    for (const s of page) {
      if (fromSlot !== null && s.slot < fromSlot) return out;
      out.push({ signature: s.signature, slot: s.slot });
    }
    before = page.at(-1)!.signature;
    if (page.length < 1000) break;
  }
  return out;
}

/** The listing already reported the signature as finalized, so its outcome is final. If the node
 *  cannot return the body at `finalized`, read the same transaction at `confirmed`; if it cannot
 *  return it at all, fail with the signature named so the operator can investigate. */
async function fetchFinalized(rpc: Rpc, signature: Signature) {
  const opts = { maxSupportedTransactionVersion: 0, encoding: 'json' } as const;
  try {
    const tx = await rpc.getTransaction(signature, { ...opts, commitment: 'finalized' }).send();
    if (tx) return tx;
  } catch {
    // fall through to the confirmed read
  }
  const tx = await rpc
    .getTransaction(signature, { ...opts, commitment: 'confirmed' })
    .send()
    .catch((e: unknown) => {
      throw new Error(`getTransaction(${signature}) failed at finalized and confirmed: ${String(e)}`);
    });
  if (!tx) throw new Error(`getTransaction(${signature}) returned nothing at finalized or confirmed`);
  console.error(JSON.stringify({ at: new Date().toISOString(), warning: 'finalized body unavailable; read at confirmed', signature }));
  return tx;
}
