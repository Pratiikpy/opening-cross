// One keeper pass: discover candidate crosses, re-read each from chain, plan, execute.
//
// Discovery is only a hint (the indexer's table or a getProgramAccounts scan); every decision is
// made from account data fetched in this pass, never from the index. Sends are independent: one
// failure (often a competing keeper that got there first) never stops the rest of the pass.
import type { Address, Instruction, TransactionSigner } from '@solana/kit';
import { type Cross, OrderSide, getAbandonSettlementInstruction, getCrossDecoder, getOrderDecoder, readCrossExt, readOrderExt } from '@opening-cross/cross-core-client';
import { buildClaim, buildDrawBegin, buildDrawFinish, buildFinalizeWithAccounts, buildSettleBook } from '@opening-cross/sdk';
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
  /** The cluster's current slot. Needed to time the two steps of a draw; without it a cross that is owed a draw is skipped with a reason. */
  slot?: () => Promise<bigint>;
  /** Pyth price update account for oracle-guarded crosses; null means the keeper cannot clear it. */
  oraclePrice?: (cross: Address) => Promise<Address | null>;
  /** Scopes the keeper to some crosses (for example one issuer's). Omitted, it serves every cross it discovers. */
  accept?: (cross: Cross) => boolean;
  /**
   * Whether a mint is, right now, in a state that stops transfers or settlement (paused, an active transfer hook, a
   * pending multiplier change inside the halt window). Null when it is fine. Omitted, the keeper does not look.
   * See `mintHaltCheck` in halt.ts for the token-safety implementation.
   */
  mintHalt?: (mint: Address) => Promise<MintHalt | null>;
  /**
   * What the keeper has already found impossible, kept by the caller across passes so a halted cross is not
   * re-sent every pass. Omitted, nothing is remembered and a halted mint is re-attempted each pass.
   */
  memory?: Map<string, Deferred>;
};

export type MintHalt = { code: string; message: string };
/** A step that cannot succeed until `sig` changes (the set of halts in force), or, for a frozen account, until a delay passes. */
export type Deferred = { sig: string; at: bigint };

/** Seconds before a step refused for a frozen token account is tried again; the issuer can thaw it at any time. */
const LAYOUT = 'LAYOUT';
const LAYOUT_RETRY_SECONDS = 3600n;
const FROZEN_RETRY_SECONDS = 600n;
const FROZEN = 'ACCOUNT_FROZEN';
type Halt = MintHalt & { role: 'base' | 'quote'; mint: Address };

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
  const slot = d.slot ? await d.slot().catch(() => null) : null;
  const p = plan(address, cross, open, now, { ext: readCrossExt(data), slot });
  const halts: Halt[] = [];
  if (d.mintHalt) {
    for (const [role, mint] of [['base', cross.baseBound ? cross.baseMint : null], ['quote', cross.quoteMint]] as const) {
      // A mint that cannot be read (closed, RPC down) must not stop the pass for every other cross: act as the keeper did
      // before the check existed. The on-chain program still refuses whatever cannot move.
      const h = mint ? await d.mintHalt(mint).catch(() => null) : null;
      if (mint && h) halts.push({ ...h, role, mint });
    }
  }
  const sig = halts.map((h) => `${h.code}:${h.mint}`).join(',');
  const memory = d.memory;
  const mark = `${address}|`;
  if (memory && halts.length === 0) {
    // Whatever was holding this cross back is gone; forget it so the steps are tried again (a frozen-account entry keeps its own delay).
    for (const [k, v] of memory) if (k.startsWith(mark) && v.sig !== FROZEN && v.sig !== LAYOUT) memory.delete(k);
  }
  const why = (h: Halt) => `the ${h.role} mint ${h.mint} cannot move right now: ${h.message}`;
  let progressed = false;
  let held = 0;
  let frozen = 0;
  for (const action of p.actions) {
    // A halted mint stops a print outright: a price nobody can be paid at is not worth fixing on chain.
    if (action.kind === 'settle' && halts.length > 0) {
      p.skipped.push({ cross: address, code: halts[0]!.code, reason: `settlement is withheld while ${why(halts[0]!)}` });
      continue;
    }
    const key = `${mark}${action.kind}|${action.kind === 'claim' ? action.order.address : ''}`;
    const known = memory?.get(key);
    if (known?.sig === LAYOUT && now - known.at < LAYOUT_RETRY_SECONDS) {
      p.skipped.push({ cross: address, code: LAYOUT, reason: 'an account of this cross belongs to a different program than this one expects (an earlier layout), so it cannot be settled; checked again hourly' });
      continue;
    }
    if (known && ((known.sig === FROZEN && now - known.at < FROZEN_RETRY_SECONDS) || (known.sig !== FROZEN && halts.length > 0 && known.sig === sig))) {
      if (known.sig === FROZEN) frozen++;
      else held++;
      continue;
    }
    try {
      // Re-read before each step: a previous step changes the cross.
      const fresh = await d.fetch(address);
      if (!fresh) throw new Error('cross disappeared');
      const view = { address, data: getCrossDecoder().decode(fresh), ext: readCrossExt(fresh) };
      let last = '';
      for (const ixs of await instructionsFor(action, view, d)) last = await d.send(ixs);
      result.done.push({ action, signature: last });
      memory?.delete(key);
      progressed = true;
    } catch (e) {
      const error = describe(e);
      // The program cannot read this account (written by an earlier layout): retrying cannot
      // succeed, so report it once as skipped with the reason rather than failing every pass.
      if (error.includes('AccountDidNotDeserialize')) p.skipped.push({ cross: address, reason: `the program cannot read this account (${error})` });
      // A cross created without its order-book shards can never be settled either; report it once instead of failing every pass.
      else if (error.includes('AccountOwnedByWrongProgram')) {
        // An account of an earlier program layout: the same step will be refused every pass, so it is remembered for an hour.
        memory?.set(key, { sig: LAYOUT, at: now });
        p.skipped.push({ cross: address, code: LAYOUT, reason: `an account of this cross belongs to a different program than this one expects, so it cannot be settled (${error})` });
      } else if (error.includes('AccountNotInitialized')) p.skipped.push({ cross: address, reason: `an account this cross needs was never created, so it cannot be settled (${error})` });
      // The step was refused while a mint is halted on chain: that is the cause, not a fault to retry every pass. Remember it
      // and try again only when the set of halts changes.
      else if (halts.length > 0) {
        memory?.set(key, { sig, at: now });
        held++;
      }
      // A token account holding or receiving this cross's tokens is frozen by the issuer; only the issuer can fix it.
      else if (/Account is frozen|custom program error: 0x11\b/.test(error)) {
        memory?.set(key, { sig: FROZEN, at: now });
        frozen++;
      } else result.failed.push({ action, error });
    }
  }
  if (held > 0) p.skipped.push({ cross: address, code: halts[0]?.code ?? 'MINT_HALTED', reason: `${held} step(s) held back, not retried until the halt changes: ${halts.map(why).join('; ')}` });
  if (frozen > 0) p.skipped.push({ cross: address, code: FROZEN, reason: `${frozen} step(s) refused because a token account is frozen by the issuer; retried after ${FROZEN_RETRY_SECONDS / 60n} minutes` });
  return { progressed, skipped: p.skipped };
}

/** Each inner array is one transaction. */
async function instructionsFor(a: Action, view: { address: Address; data: Cross; ext: ReturnType<typeof readCrossExt> }, d: KeeperDeps): Promise<Instruction[][]> {
  switch (a.kind) {
    case 'settle': {
      let oraclePrice: Address | undefined;
      if (view.data.oracle.__option === 'Some') {
        const p = d.oraclePrice ? await d.oraclePrice(a.cross) : null;
        if (!p) throw new Error('oracle-guarded cross: no Pyth price update available');
        oraclePrice = p;
      }
      // One shard merge per transaction keeps each well inside the compute limit.
      return (await buildSettleBook(view, { ...(oraclePrice ? { oraclePrice } : {}), now: await d.now() })).map((ix) => [ix]);
    }
    case 'draw-begin':
      return [[buildDrawBegin(a.cross)]];
    case 'draw-finish':
      return [[buildDrawFinish(a.cross)]];
    case 'abandon':
      return [[getAbandonSettlementInstruction({ cross: a.cross })]];
    case 'claim':
    {
      // A cross with rules pays from accounts that depend on the order's own tail (bucket, class, lockup), so read it.
      if (!view.ext) return [await buildClaim(view, d.payer, a.order.owner, a.order.nonce)];
      const raw = await d.fetch(a.order.address);
      if (!raw) throw new Error('order disappeared');
      const facts = { ext: readOrderExt(raw), isBuy: getOrderDecoder().decode(raw).side === OrderSide.Buy };
      return [await buildClaim(view, d.payer, a.order.owner, a.order.nonce, facts)];
    }
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
