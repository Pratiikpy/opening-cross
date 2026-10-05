// Polls an RPC node for cross_core transactions at `finalized` commitment, so nothing ingested can
// be rolled back. Signatures are walked newest-to-oldest back to the stored cursor, then ingested
// oldest-first; the cursor advances only after each transaction commits, so a crash resumes at the
// first transaction not yet applied. (A Yellowstone gRPC source can replace this; see HUMAN_TASKS H7.)
import type { Address, Signature } from '@solana/kit';
import type pg from 'pg';
import { CROSS_CORE_PROGRAM_ADDRESS } from '@opening-cross/cross-core-client';
import { ingestTransaction } from './ingest.js';
import type { IndexerRpc as Rpc } from './rpc.js';

export async function pollOnce(db: pg.Pool, rpc: Rpc, program: Address = CROSS_CORE_PROGRAM_ADDRESS, source = `rpc:${program}`): Promise<number> {
  const { rows } = await db.query('SELECT last_signature FROM cursors WHERE source = $1', [source]);
  const until = (rows[0]?.last_signature ?? undefined) as Signature | undefined;
  const pending: { signature: Signature; slot: bigint }[] = [];
  let before: Signature | undefined;
  for (;;) {
    const page = await rpc.getSignaturesForAddress(program, { commitment: 'finalized', limit: 1000, ...(until && { until }), ...(before && { before }) }).send();
    if (page.length === 0) break;
    pending.push(...page.map((s) => ({ signature: s.signature, slot: s.slot })));
    before = page.at(-1)!.signature;
    if (page.length < 1000) break;
  }
  let applied = 0;
  for (const s of pending.reverse()) {
    const tx = await rpc.getTransaction(s.signature, { commitment: 'finalized', maxSupportedTransactionVersion: 0, encoding: 'json' }).send();
    if (!tx) throw new Error(`finalized transaction ${s.signature} not returned by the node`);
    applied += await ingestTransaction(db, {
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
