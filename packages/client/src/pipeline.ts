// The one path every action takes: a builder produces unsigned transactions, the user's signer signs them, they are sent
// to the cluster and confirmed. Errors come back in the program's own words, never as a stack trace.
//
// Everything that is safe to repeat is repeated with backoff: building a transaction (it sends nothing), reading a
// status, and sending the same signed bytes. If a send ends in a timeout or a 429 that outlasts the retries, the
// pipeline asks the cluster whether that signature landed before it tells anyone the action failed.
import { getBase58Decoder } from '@solana/kit';
import { ActionError } from './errors.js';
import { defaultSleep } from './http.js';
import { type RpcClient, RpcRefused, type Simulation } from './rpc.js';
import type { UnsignedTransaction } from './types.js';

/** Signs one transaction's wire bytes. `many` signs a whole multi-transaction action in a single wallet prompt, when the wallet supports it. */
export type Signer = ((input: { transaction: Uint8Array }) => Promise<{ signedTransaction: Uint8Array }>) & {
  many?: (transactions: Uint8Array[]) => Promise<Uint8Array[]>;
};

export type PipelineOptions = {
  rpc: RpcClient;
  sign: Signer;
  onStatus?: (status: string) => void;
  sleep?: (ms: number) => Promise<void>;
  /** How long to wait for a transaction to confirm before checking whether it landed anyway. */
  confirmTimeoutMs?: number;
};

const b64ToBytes = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** A transaction's id is its first (fee payer's) signature: byte 0 is the signature count, then 64 bytes each. */
export function transactionId(wire: Uint8Array): string {
  return getBase58Decoder().decode(wire.slice(1, 65));
}

async function confirm(rpc: RpcClient, sig: string, ms: number, sleep: (ms: number) => Promise<void>): Promise<void> {
  const deadline = Date.now() + ms;
  for (let n = 0; ; n++) {
    const s = await rpc.signatureStatus(sig).catch(() => null);
    if (s?.err) throw new ActionError(`The transaction failed on chain: ${JSON.stringify(s.err)}`, 'FAILED_ON_CHAIN');
    if (s && (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized')) return;
    if (Date.now() > deadline) throw new ActionError(`Not confirmed after ${Math.round(ms / 1000)} s. Check ${sig} in an explorer before retrying; if it landed, the action is done.`, 'NOT_CONFIRMED');
    await sleep(Math.min(3_000, 900 + n * 300));
  }
}

async function signWith(sign: Signer, wires: Uint8Array[], label: string, onStatus?: (s: string) => void): Promise<Uint8Array[]> {
  onStatus?.(`Waiting for your wallet${label}…`);
  try {
    if (wires.length > 1 && sign.many) {
      const out = await sign.many(wires);
      if (out.length !== wires.length) throw new Error(`the wallet returned ${out.length} signed transactions for ${wires.length}`);
      return out;
    }
    const out: Uint8Array[] = [];
    for (const w of wires) out.push((await sign({ transaction: w })).signedTransaction);
    return out;
  } catch (e) {
    if (e instanceof ActionError) throw e;
    const message = e instanceof Error ? e.message : String(e);
    if (/reject|cancel|denied|declined/i.test(message)) throw new ActionError('You declined in your wallet. Nothing was sent.', 'WALLET_DECLINED');
    throw new ActionError(`Your wallet could not sign: ${message}`, 'WALLET_ERROR');
  }
}

async function sendOne(o: PipelineOptions, signed: Uint8Array, label: string): Promise<string> {
  const sleep = o.sleep ?? defaultSleep;
  const id = transactionId(signed);
  o.onStatus?.(`Sending${label}…`);
  try {
    await o.rpc.send(signed);
  } catch (e) {
    if (e instanceof RpcRefused) throw e;
    // The endpoint kept refusing to answer. The same signed bytes may nonetheless have been accepted: ask for the signature.
    o.onStatus?.(`Checking whether it landed${label}…`);
    const landed = await confirm(o.rpc, id, 45_000, sleep).then(() => true, () => false);
    if (!landed) throw new ActionError(`${e instanceof Error ? e.message : String(e)} The transaction was not seen on chain, so nothing was spent; try again in a minute. (Reference ${id})`, 'RPC_UNREACHABLE');
    return id;
  }
  o.onStatus?.(`Confirming${label}…`);
  await confirm(o.rpc, id, o.confirmTimeoutMs ?? 90_000, sleep);
  return id;
}

/**
 * Signs the transactions (all in one wallet prompt when the signer allows it), then sends and confirms them in order.
 * A failure carries how many had already landed, so a multi-step action can be finished instead of repeated.
 */
export async function signSendConfirm(txs: readonly UnsignedTransaction[], o: PipelineOptions): Promise<string[]> {
  const sigs: string[] = [];
  const batch = txs.length > 1 && Boolean(o.sign.many);
  const signedAll = batch ? await signWith(o.sign, txs.map((t) => b64ToBytes(t.transaction)), ` (${txs.length} transactions)`, o.onStatus) : [];
  for (const [i, t] of txs.entries()) {
    const label = txs.length > 1 ? ` (${i + 1} of ${txs.length})` : '';
    try {
      const wire = batch ? signedAll[i]! : (await signWith(o.sign, [b64ToBytes(t.transaction)], label, o.onStatus))[0]!;
      sigs.push(await sendOne(o, wire, label));
    } catch (e) {
      if (e instanceof ActionError) e.completed = sigs.length;
      throw e;
    }
  }
  return sigs;
}

export type DryRunResult = {
  index: number;
  simulation: Simulation;
  note: string | null;
  /**
   * True when a later transaction failed only because an account the earlier transactions create does not exist yet (for
   * example the shards of a new cross). The simulation cannot chain, so this says nothing about whether it would succeed.
   */
  inconclusive: boolean;
};

const ANCHOR_ACCOUNT_NOT_INITIALIZED = 3012;

/** A failure that means "an account is missing" rather than "this transaction is wrong". */
function needsEarlierStep(err: unknown): boolean {
  if (err === 'AccountNotFound') return true;
  const ie = (err as { InstructionError?: [number, unknown] } | null)?.InstructionError;
  const code = (ie?.[1] as { Custom?: number } | undefined)?.Custom;
  return code === ANCHOR_ACCOUNT_NOT_INITIALIZED;
}

/**
 * Simulates the transactions against the cluster's current state without signing or sending anything. A transaction after
 * the first is simulated without the effects of the earlier ones, so a failure there may only mean "the earlier step has not
 * happened"; the result says so.
 */
export async function dryRun(txs: readonly UnsignedTransaction[], rpc: RpcClient): Promise<DryRunResult[]> {
  const out: DryRunResult[] = [];
  for (const [index, t] of txs.entries()) {
    const simulation = await rpc.simulate(b64ToBytes(t.transaction));
    out.push({
      index,
      simulation,
      note: index === 0 ? null : 'Simulated against the current state, without the earlier transactions of this action.',
      inconclusive: index > 0 && simulation.err !== null && needsEarlierStep(simulation.err),
    });
  }
  return out;
}
