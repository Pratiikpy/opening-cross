// The limit price and quantity of an open (unsealed) order.
//
// The OrderCommitted event carries the escrow but not the terms; for a sealed order the terms arrive later
// in OrderRevealed, but an open order is never revealed, so its price and quantity exist only in the
// arguments of the commit_order instruction. Without them the index cannot say what a bidder was willing to
// pay, which price improvement is measured against. They are read from the instruction here, from the
// transaction at ingest time and, for rows indexed before this existed, by `backfillOrderTerms`.
import { getBase58Encoder } from '@solana/kit';
import type pg from 'pg';
import { COMMIT_ORDER_DISCRIMINATOR, CROSS_CORE_PROGRAM_ADDRESS, getCommitOrderInstructionDataDecoder } from '@opening-cross/cross-core-client';
import type { IndexerRpc } from './rpc.js';

export type OrderTerms = { price: bigint; quantity: bigint };

/** The parts of a `getTransaction` (json encoding) result this module reads. */
export type TxBody = {
  transaction: { message: { accountKeys: readonly string[]; instructions: readonly RawInstruction[] } };
  meta?: {
    loadedAddresses?: { writable: readonly string[]; readonly: readonly string[] };
    innerInstructions?: readonly { instructions: readonly RawInstruction[] }[] | null;
  } | null;
};
type RawInstruction = { programIdIndex: number; accounts: readonly number[]; data: string };

/** Position of the order account in commit_order's account list (owner, protocol, cross, order, ...). */
const ORDER_ACCOUNT_INDEX = 3;
const b58 = getBase58Encoder();
const decoder = getCommitOrderInstructionDataDecoder();
/** Orders whose commit transaction could not be read or held no terms, so one stuck order cannot starve the rest of the backlog. */
const unresolved = new Set<string>();

/**
 * Terms of every open order committed by this transaction, keyed by the order account, whether the
 * commit_order instruction ran at the top level or inside another program's CPI. A sealed commit
 * (non-zero commitment, zero terms) yields nothing.
 */
export function commitTerms(tx: TxBody): Map<string, OrderTerms> {
  const loaded = tx.meta?.loadedAddresses;
  const keys = [...tx.transaction.message.accountKeys, ...(loaded?.writable ?? []), ...(loaded?.readonly ?? [])];
  const all = [...tx.transaction.message.instructions, ...(tx.meta?.innerInstructions ?? []).flatMap((i) => i.instructions)];
  const out = new Map<string, OrderTerms>();
  for (const ix of all) {
    if (keys[ix.programIdIndex] !== CROSS_CORE_PROGRAM_ADDRESS) continue;
    const bytes = b58.encode(ix.data);
    if (bytes.length < 8 || !COMMIT_ORDER_DISCRIMINATOR.every((b, i) => bytes[i] === b)) continue;
    const args = decoder.decode(bytes);
    const order = keys[ix.accounts[ORDER_ACCOUNT_INDEX] ?? -1];
    if (!order || args.price === 0n || args.quantity === 0n) continue;
    out.set(order, { price: args.price, quantity: args.quantity });
  }
  return out;
}

/**
 * Fills in the terms of open orders indexed before they were captured. Reads at most `limit` orders per
 * call (each costs one getTransaction), so a long backlog is worked off over a few polls rather than
 * blocking one. Returns how many orders were updated and how many are still waiting (orders whose transaction held no terms are set aside, not retried).
 */
export async function backfillOrderTerms(db: pg.Pool, rpc: IndexerRpc, limit = 25): Promise<{ updated: number; remaining: number }> {
  const { rows } = await db.query(
    `SELECT o.cross_address, o.address, e.signature
       FROM orders o
       JOIN events e ON e.name = 'OrderCommitted' AND e.cross_address = o.cross_address AND e.payload ->> 'order' = o.address
      WHERE NOT o.sealed AND o.price IS NULL AND o.address <> ALL($2::text[])
      ORDER BY o.created_slot LIMIT $1`,
    [limit, [...unresolved]],
  );
  let updated = 0;
  const bySignature = new Map<string, { cross: string; order: string }[]>();
  for (const r of rows) bySignature.set(r.signature, [...(bySignature.get(r.signature) ?? []), { cross: r.cross_address, order: r.address }]);
  for (const [signature, orders] of bySignature) {
    const tx = await rpc.getTransaction(signature as never, { maxSupportedTransactionVersion: 0, encoding: 'json', commitment: 'finalized' }).send();
    const terms = tx ? commitTerms(tx as unknown as TxBody) : new Map<string, OrderTerms>();
    for (const o of orders) {
      const t = terms.get(o.order);
      if (!t) {
        unresolved.add(o.order);
        continue;
      }
      const res = await db.query('UPDATE orders SET price = $3, quantity = $4 WHERE cross_address = $1 AND address = $2 AND price IS NULL AND NOT sealed', [o.cross, o.order, t.price.toString(), t.quantity.toString()]);
      updated += res.rowCount ?? 0;
    }
  }
  const { rows: left } = await db.query('SELECT count(*)::int AS n FROM orders WHERE NOT sealed AND price IS NULL AND address <> ALL($1::text[])', [[...unresolved]]);
  return { updated, remaining: left[0].n };
}

