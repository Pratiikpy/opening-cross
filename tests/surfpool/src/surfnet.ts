// Helpers for driving a Surfpool surfnet over its JSON-RPC: the real program binaries are written to their real addresses, accounts
// are funded, transactions are sent and confirmed over HTTP, an expected failure is read from the node's own simulation, and the
// clock is moved with Surfpool's `surfnet_timeTravel` so an order window of a minute does not cost a minute.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  type Address,
  type Instruction,
  type KeyPairSigner,
  appendTransactionMessageInstructions,
  createSolanaRpc,
  createTransactionMessage,
  fetchEncodedAccount,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  lamports,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from '@solana/kit';

export const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
export const SURFPOOL_URL = process.env.SURFPOOL_URL ?? 'http://127.0.0.1:18899';
export const rpc = createSolanaRpc(SURFPOOL_URL);

/** One JSON-RPC call, including Surfpool's own `surfnet_*` methods, which kit's typed client does not know. */
export async function raw<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
  const res = await fetch(SURFPOOL_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const body = (await res.json()) as { result?: T; error?: { message: string; data?: unknown } };
  if (body.error) throw new Error(`${method}: ${body.error.message}${body.error.data ? ` ${JSON.stringify(body.error.data)}` : ''}`);
  return body.result as T;
}

export const show = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));

/** True when a surfnet answers at the configured address and is Surfpool (not some other validator). */
export async function surfnetUp(): Promise<boolean> {
  try {
    const v = await raw<{ 'surfnet-version'?: string }>('getVersion');
    return typeof v['surfnet-version'] === 'string';
  } catch {
    return false;
  }
}

/**
 * Writes a program's compiled binary to `programId` through Surfpool's `surfnet_writeProgram`, in chunks, so the program runs from its
 * real address and its own `declare_id!` check passes. The binary is the one in `target/deploy` that the other suites test.
 */
export async function deployProgram(programId: Address, soName: string): Promise<{ bytes: number }> {
  const data = readFileSync(`${ROOT}target/deploy/${soName}.so`);
  const CHUNK = 400_000;
  for (let offset = 0; offset < data.length; offset += CHUNK) {
    await raw('surfnet_writeProgram', [programId, data.subarray(offset, offset + CHUNK).toString('hex'), offset]);
  }
  const acct = await fetchEncodedAccount(rpc, programId, { commitment: 'confirmed' });
  if (!acct.exists || !acct.executable) throw new Error(`${soName} was written but ${programId} is not an executable account`);
  return { bytes: data.length };
}

export async function airdrop(to: Address, sol: number): Promise<void> {
  await rpc.requestAirdrop(to, lamports(BigInt(Math.round(sol * 1e9))), { commitment: 'confirmed' }).send();
  for (let i = 0; i < 40; i++) {
    const { value } = await rpc.getBalance(to, { commitment: 'confirmed' }).send();
    if (value > 0n) return;
    await sleep(100);
  }
  throw new Error(`airdrop to ${to} never arrived`);
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function build(ixs: Instruction[], payer: KeyPairSigner, extra: KeyPairSigner[] = []) {
  const { value: blockhash } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send();
  // Signers other than the payer are carried by the instructions that name them (kit reads each account's signer).
  void extra;
  return signTransactionMessageWithSigners(
    pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(payer, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
      (m) => appendTransactionMessageInstructions(ixs, m),
    ),
  );
}

/** Sends and waits for confirmation. Throws with the program's logs when the transaction fails. */
export async function send(ixs: Instruction[], payer: KeyPairSigner): Promise<string> {
  const tx = await build(ixs, payer);
  const signature = getSignatureFromTransaction(tx);
  const wire = getBase64EncodedWireTransaction(tx);
  try {
    await rpc.sendTransaction(wire, { encoding: 'base64', preflightCommitment: 'confirmed' }).send();
  } catch (e) {
    throw new Error(`transaction was refused: ${describeError(e)}`);
  }
  for (let i = 0; i < 200; i++) {
    const { value } = await rpc.getSignatureStatuses([signature]).send();
    const st = value[0];
    if (st?.err) throw new Error(`transaction ${signature} failed: ${show(st.err)}`);
    if (st && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) return signature;
    await sleep(100);
  }
  throw new Error(`transaction ${signature} was not confirmed`);
}

export function describeError(e: unknown): string {
  const ctx = (e as { context?: unknown; cause?: unknown }) ?? {};
  const cause = ctx.cause as { context?: { logs?: string[]; err?: unknown }; message?: string } | undefined;
  const logs = cause?.context?.logs ?? (ctx.context as { logs?: string[] } | undefined)?.logs;
  return `${(e as Error).message ?? String(e)}${cause?.message ? ` / ${cause.message}` : ''}${logs ? `\n${logs.join('\n')}` : ''}`;
}

export interface Refusal {
  /** The program's custom error number (an Anchor error code), when the failure is one. */
  custom: number | null;
  err: unknown;
  logs: string[];
}

/** Runs the transaction through the node's own simulation and returns why it was refused. Throws if the simulation succeeds. */
export async function refusal(ixs: Instruction[], payer: KeyPairSigner): Promise<Refusal> {
  const tx = await build(ixs, payer);
  const { value } = await rpc.simulateTransaction(getBase64EncodedWireTransaction(tx), { encoding: 'base64', commitment: 'confirmed', sigVerify: false }).send();
  if (!value.err) throw new Error('expected the transaction to be refused, but it simulated successfully');
  // kit reports numbers in an error as bigints.
  const e = value.err as { InstructionError?: [number | bigint, { Custom?: number | bigint } | string] };
  const detail = e.InstructionError?.[1];
  const code = typeof detail === 'object' && detail ? detail.Custom : undefined;
  return { custom: code === undefined ? null : Number(code), err: value.err, logs: [...(value.logs ?? [])] };
}

export async function chainTime(): Promise<bigint> {
  const slot = await rpc.getSlot({ commitment: 'confirmed' }).send();
  return BigInt((await rpc.getBlockTime(slot).send()) ?? Math.floor(Date.now() / 1000));
}

/** Moves the surfnet's clock forward to `ts` (unix seconds). */
export async function travelTo(ts: bigint): Promise<void> {
  await raw('surfnet_timeTravel', [{ absoluteTimestamp: Number(ts) * 1000 }]);
  for (let i = 0; i < 50 && (await chainTime()) < ts; i++) await sleep(100);
  if ((await chainTime()) < ts) throw new Error(`the clock did not reach ${ts}`);
}
