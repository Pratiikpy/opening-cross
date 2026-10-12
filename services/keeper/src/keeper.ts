// One keeper pass: discover candidate crosses, re-read each from chain, plan, execute.
//
// Discovery is only a hint (the indexer's table or a getProgramAccounts scan); every decision is
// made from account data fetched in this pass, never from the index. Sends are independent: one
// failure (often a competing keeper that got there first) never stops the rest of the pass.
import type { Address, Instruction, TransactionSigner } from '@solana/kit';
import { type Cross, getAbandonSettlementInstruction, getCrossDecoder, getOrderDecoder } from '@opening-cross/cross-core-client';
import { buildClaim, buildFinalizeWithAccounts, buildSettleBook } from '@opening-cross/sdk';
import { type Action, type OpenOrder, type Skip, plan } from './plan.js';

export type AccountFetcher = (address: Address) => Promise<Uint8Array | null>;

export type KeeperDeps = {
  payer: TransactionSigner;
  /** Unix seconds as the cluster sees it (the program compares against its own Clock). */
  now: () => Promise<bigint>;
  fetch: AccountFetcher;
  /** Candidate crosses that may need work. */
  crosses: () => Promise<Address[]>;
  /** Order account addresses believed open for a cross; each is re-read before use. */
  orders: (cross: Address) => Promise<Address[]>;
  /** Sends one transaction; resolves with its signature or rejects with the program's logs. */
  send: (ixs: Instruction[]) => Promise<string>;
  /** Pyth price update account for oracle-guarded crosses; null means the keeper cannot clear it. */
  oraclePrice?: (cross: Address) => Promise<Address | null>;
  /** Scopes the keeper to some crosses (for example one issuer's). Omitted, it serves every cross it discovers. */
  accept?: (cross: Cross) => boolean;
};

export type PassResult = { done: { action: Action; signature: string }[]; failed: { action: Action; error: string }[]; skipped: Skip[] };

/** Lifecycle stages a cross can move through in one pass: settle/abandon → claims → finalize. */
const MAX_ROUNDS = 4;

export async function runOnce(d: KeeperDeps): Promise<PassResult> {
  const result: PassResult = { done: [], failed: [], skipped: [] };
  const now = await d.now();
  for (const address of await d.crosses()) {
    // Re-plan after every round that changed state, so one pass carries a cross as far as the
    // clock allows. Skips are reported from the final round only.
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const r = await advance(address, d, now, result);
      if (!r.progressed) {
        result.skipped.push(...r.skipped);
        break;
      }
    }
  }
  return result;
}

async function advance(address: Address, d: KeeperDeps, now: bigint, result: PassResult): Promise<{ progressed: boolean; skipped: Skip[] }> {
  const data = await d.fetch(address);
  if (!data) return { progressed: false, skipped: [] };
  const cross = getCrossDecoder().decode(data);
  if (d.accept && !d.accept(cross)) return { progressed: false, skipped: [] };
  const open: OpenOrder[] = [];
  for (const o of await d.orders(address)) {
    const od = await d.fetch(o);
    if (!od) continue; // claimed or cancelled since discovery
    const order = getOrderDecoder().decode(od);
    if (order.cross === address) open.push({ address: o, owner: order.owner, nonce: order.nonce });
  }
  const p = plan(address, cross, open, now);
  let progressed = false;
  for (const action of p.actions) {
    try {
      // Re-read before each step: a previous step changes the cross.
      const fresh = await d.fetch(address);
      if (!fresh) throw new Error('cross disappeared');
      const view = { address, data: getCrossDecoder().decode(fresh) };
      let last = '';
      for (const ixs of await instructionsFor(action, view, d)) last = await d.send(ixs);
      result.done.push({ action, signature: last });
      progressed = true;
    } catch (e) {
      const error = describe(e);
      // The program cannot read this account (written by an earlier layout): retrying cannot
      // succeed, so report it once as skipped with the reason rather than failing every pass.
      if (error.includes('AccountDidNotDeserialize')) p.skipped.push({ cross: address, reason: `the program cannot read this account (${error})` });
      // A cross created without its order-book shards can never be settled either; report it once instead of failing every pass.
      else if (error.includes('AccountNotInitialized')) p.skipped.push({ cross: address, reason: `an account this cross needs was never created, so it cannot be settled (${error})` });
      else result.failed.push({ action, error });
    }
  }
  return { progressed, skipped: p.skipped };
}

/** Each inner array is one transaction. */
async function instructionsFor(a: Action, view: { address: Address; data: Cross }, d: KeeperDeps): Promise<Instruction[][]> {
  switch (a.kind) {
    case 'settle': {
      let oraclePrice: Address | undefined;
      if (view.data.oracle.__option === 'Some') {
        const p = d.oraclePrice ? await d.oraclePrice(a.cross) : null;
        if (!p) throw new Error('oracle-guarded cross: no Pyth price update available');
        oraclePrice = p;
      }
      // One shard merge per transaction keeps each well inside the compute limit.
      return (await buildSettleBook(view, oraclePrice ? { oraclePrice } : {})).map((ix) => [ix]);
    }
    case 'abandon':
      return [[getAbandonSettlementInstruction({ cross: a.cross })]];
    case 'claim':
      return [await buildClaim(view, d.payer, a.order.owner, a.order.nonce)];
    case 'finalize':
      return [await buildFinalizeWithAccounts(view, d.payer)];
  }
}

/** The program's own reason when the node returned simulation logs, else the error's first line. */
export function describe(e: unknown): string {
  type WithLogs = { context?: { logs?: string[] }; cause?: { context?: { logs?: string[] } } };
  const err = e as WithLogs | undefined;
  const logs = err?.cause?.context?.logs ?? err?.context?.logs;
  const reason = logs?.find((l) => l.includes('Error Code:'));
  if (reason) return reason.replace(/^Program log: /, '');
  return e instanceof Error ? e.message.split('\n')[0]! : String(e);
}
