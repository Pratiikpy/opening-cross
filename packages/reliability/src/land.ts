// Getting a signed transaction onto the chain. A transaction is valid until its blockhash expires (the cluster's block height
// passes `lastValidBlockHeight`), and a leader may drop it any time before then. So: send it by every route, send it again
// every couple of seconds, and watch both its signature and the block height. When the height passes, the transaction can
// never land; that is the one moment it is safe to say it did not, after a last look at the signature.
import { FailoverRpc } from './failover.js';
import { bytesToBase64, signatureOf } from './wire.js';

export type LandStatus = 'landed' | 'failed' | 'expired';

export interface LandResult {
  status: LandStatus;
  signature: string;
  /** Times the transaction was sent (each send goes to every live endpoint). */
  sends: number;
  slot: number | null;
  err: unknown;
  elapsedMs: number;
  /** Endpoints that accepted a send, so a slow landing can be traced to a route. */
  accepted: string[];
}

export interface LandOptions {
  /** Time between sends. Default 2,000 ms. */
  resendEveryMs?: number;
  /** Time between status checks. Default 800 ms. */
  pollEveryMs?: number;
  /** Commitment to wait for. Default 'confirmed'. */
  commitment?: 'confirmed' | 'finalized';
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  onEvent?: (event: string) => void;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Replies by which a node says it already has the transaction: success for our purposes.
const ALREADY = /already (processed|been processed)|AlreadyProcessed/i;
// Replies that mean this transaction can never land, whichever node says so. "Blockhash not found" is deliberately not here:
// a node that has not yet seen a fresh blockhash says it too, and the resends fix that; an expired one is caught by the block height.
const FATAL = /signature verification failure|custom program error|InstructionError|insufficient funds|AccountNotFound/i;

interface Status {
  err: unknown;
  confirmationStatus?: string;
  slot?: number;
}

async function statusOf(rpc: FailoverRpc, signature: string, history: boolean): Promise<Status | null> {
  const r = await rpc.call<{ value: (Status | null)[] }>('getSignatureStatuses', [[signature], { searchTransactionHistory: history }]);
  return r.value[0] ?? null;
}

export async function landTransaction(rpc: FailoverRpc, wire: Uint8Array, lastValidBlockHeight: bigint, opts: LandOptions = {}): Promise<LandResult> {
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? Date.now;
  const resendEvery = opts.resendEveryMs ?? 2_000;
  const pollEvery = opts.pollEveryMs ?? 800;
  const want = opts.commitment ?? 'confirmed';
  const signature = signatureOf(wire);
  const b64 = bytesToBase64(wire);
  const started = now();
  const accepted = new Set<string>();
  let sends = 0;
  let lastSend = -Infinity;
  let fatal: string | null = null;

  const done = (status: LandStatus, s: Status | null, err: unknown = s?.err ?? null): LandResult => ({ status, signature, sends, slot: s?.slot ?? null, err, elapsedMs: now() - started, accepted: [...accepted] });
  const reached = (s: Status | null) => s?.confirmationStatus === 'finalized' || (want === 'confirmed' && s?.confirmationStatus === 'confirmed');

  for (;;) {
    if (now() - lastSend >= resendEvery) {
      lastSend = now();
      sends += 1;
      // The first send runs the cluster's own checks; the repeats skip them, since the node already said yes and re-simulating only costs time.
      const replies = await rpc.broadcast('sendTransaction', [b64, { encoding: 'base64', skipPreflight: sends > 1, preflightCommitment: 'confirmed', maxRetries: 0 }]);
      for (const r of replies) {
        if (r.reply?.result) accepted.add(r.endpoint);
        const msg = r.reply?.error ? `${r.reply.error.message} ${JSON.stringify(r.reply.error.data ?? '')}` : '';
        if (r.reply?.error && ALREADY.test(msg)) accepted.add(r.endpoint);
        else if (r.reply?.error && FATAL.test(msg) && sends === 1) fatal = msg;
      }
      opts.onEvent?.(`send ${sends}: ${accepted.size} endpoint(s) accepted`);
      // A refusal on the first send that every route agrees on is the cluster saying this transaction is wrong; waiting will not change that.
      if (fatal && replies.every((r) => r.reply?.error || r.problem)) {
        const s = await statusOf(rpc, signature, true).catch(() => null);
        if (s && !s.err) return done('landed', s);
        return done('failed', null, fatal);
      }
    }

    const s = await statusOf(rpc, signature, false).catch(() => null);
    if (s?.err) return done('failed', s);
    if (reached(s)) return done('landed', s);

    const height = await rpc.call<number>('getBlockHeight', [{ commitment: 'confirmed' }]).catch(() => null);
    if (height !== null && BigInt(height) > lastValidBlockHeight) {
      // The blockhash is dead: nothing sent can still land. One look through history settles whether it did before that.
      const last = await statusOf(rpc, signature, true).catch(() => null);
      if (last?.err) return done('failed', last);
      if (last) return done('landed', last);
      return done('expired', null, 'the blockhash expired before the transaction landed');
    }
    await sleep(pollEvery);
  }
}

export interface Built {
  wire: Uint8Array;
  lastValidBlockHeight: bigint;
}

export interface RetryOptions extends LandOptions {
  /** Most transactions to build and try. Default 3. */
  maxBuilds?: number;
  /** Starting fee, micro-lamports per unit. */
  microLamports: bigint;
  /** Fee multiplier for each rebuild after an expiry. Default 2. */
  escalation?: number;
  /** The highest fee a rebuild may use. */
  maxMicroLamports: bigint;
}

export interface RetryResult extends LandResult {
  /** Every transaction tried, with the fee it paid. */
  attempts: { signature: string; microLamports: bigint; status: LandStatus }[];
}

/**
 * Lands a transaction that is rebuilt, with a fresh blockhash and a higher fee, each time one expires. Rebuilding is safe
 * only because an expired transaction can no longer land, which `landTransaction` has just established with a last look
 * at its signature; a transaction that landed is never rebuilt.
 */
export async function landWithRetries(rpc: FailoverRpc, build: (microLamports: bigint) => Promise<Built>, opts: RetryOptions): Promise<RetryResult> {
  const maxBuilds = opts.maxBuilds ?? 3;
  const escalation = opts.escalation ?? 2;
  let fee = opts.microLamports;
  const attempts: RetryResult['attempts'] = [];
  let last: LandResult | null = null;
  for (let i = 0; i < maxBuilds; i++) {
    const built = await build(fee);
    last = await landTransaction(rpc, built.wire, built.lastValidBlockHeight, opts);
    attempts.push({ signature: last.signature, microLamports: fee, status: last.status });
    if (last.status !== 'expired') break;
    const next = BigInt(Math.ceil(Number(fee === 0n ? 1_000n : fee) * escalation));
    fee = next > opts.maxMicroLamports ? opts.maxMicroLamports : next;
    opts.onEvent?.(`expired; rebuilding at ${fee} micro-lamports per unit`);
  }
  return { ...(last as LandResult), attempts };
}
