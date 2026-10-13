// The limit price and size of an open order, read from the chain itself (ROADMAP S1; ADR-0408): GET /v1/orders/:address/terms.
//
// An open order account does not store its price: the price is an argument of the `commit_order` instruction that created it. The
// indexer recovers it from that transaction once the transaction is finalized, which leaves the first minute after an order is placed
// without a price in the index. This route reads the same instruction straight from the cluster: the order account's oldest signature,
// that transaction, the arguments of its commit_order. It answers only for an order account that exists and is owned by cross_core, and
// only from a transaction that really contains the order's commit; a sealed order's commit carries no terms, so none is returned.
import type { FastifyInstance, FastifyReply } from 'fastify';
import { type Address, isAddress } from '@solana/kit';
import { CROSS_CORE_PROGRAM_ADDRESS, ORDER_DISCRIMINATOR } from '@opening-cross/sdk';
import { type TxBody, commitTerms } from '@opening-cross/indexer';
import { RequestError } from '../tx.js';

type ChainAccount = { data: Uint8Array; owner: Address };

export type HolderTermsDeps = {
  account: (a: Address) => Promise<ChainAccount | null>;
  /** The oldest transaction that touched the account, as a `getTransaction` (json) body; null when none can be found. Defaults to JSON-RPC against RPC_URL. */
  firstTransaction?: (a: Address) => Promise<TxBody | null>;
};

const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));
const send = (reply: FastifyReply, v: unknown, status = 200) => reply.code(status).type('application/json').send(json(v));

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const urls = (process.env.RPC_URL ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  let last: unknown = new Error('RPC_URL is not set');
  for (const url of urls) {
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(15_000) });
      const j = (await r.json()) as { result?: T; error?: { message: string } };
      if (j.error) throw new Error(j.error.message);
      return j.result as T;
    } catch (e) {
      last = e;
    }
  }
  throw last;
}

async function firstTransactionOverRpc(a: Address): Promise<TxBody | null> {
  // Signatures come newest first; an order account is touched by a handful of transactions, so one page holds them all.
  const sigs = await rpc<{ signature: string; err: unknown }[]>('getSignaturesForAddress', [a, { limit: 100, commitment: 'confirmed' }]);
  const oldest = [...sigs].reverse().find((s) => s.err === null);
  if (!oldest) return null;
  return rpc<TxBody | null>('getTransaction', [oldest.signature, { encoding: 'json', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]);
}

export function registerHolderTerms(app: FastifyInstance, deps: HolderTermsDeps) {
  const first = deps.firstTransaction ?? firstTransactionOverRpc;
  // The terms of an order never change, so a read is kept for good.
  const known = new Map<string, { price: bigint; quantity: bigint } | null>();

  app.get('/v1/orders/:address/terms', async (req, reply) => {
    const a = (req.params as { address: string }).address;
    if (!isAddress(a)) throw new RequestError(400, 'address must be a base58 Solana address');
    if (known.has(a)) return send(reply, { address: a, terms: known.get(a) ?? null });
    const acct = await deps.account(a);
    const isOrder = acct !== null && acct.owner === CROSS_CORE_PROGRAM_ADDRESS && acct.data.length >= 8 && (ORDER_DISCRIMINATOR as Uint8Array).every((b, i) => acct.data[i] === b);
    if (!isOrder) throw new RequestError(404, `${a} is not an open Opening Cross order`);
    const tx = await first(a).catch(() => null);
    if (!tx) return send(reply, { address: a, terms: null, reason: 'the transaction that placed this order could not be read just now' }, 200);
    const t = commitTerms(tx).get(a) ?? null;
    // A sealed order's commit carries no terms: that is a final answer. A missing transaction is not, so it is not kept.
    known.set(a, t);
    return send(reply, { address: a, terms: t, ...(t ? {} : { reason: 'this order was committed sealed, so its terms are not on chain until it is revealed' }) });
  });
}
