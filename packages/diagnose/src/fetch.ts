import { type Diagnosis, diagnose } from './diagnose.js';

export interface RpcLike {
  call<T = unknown>(method: string, params?: unknown[]): Promise<T>;
}

export type DiagnoseResult = { status: 'failed'; diagnosis: Diagnosis; slot: number | null; fee: number | null } | { status: 'succeeded'; slot: number | null } | { status: 'not-found' };

interface RawTx {
  slot: number;
  meta: { err: unknown; logMessages?: string[] | null; fee?: number } | null;
  transaction: { message: { accountKeys: (string | { pubkey: string })[]; instructions: { programIdIndex: number }[] } };
}

/** Looks a transaction up by signature and explains it if it failed. Works with any client that has `call(method, params)`, such as FailoverRpc. */
export async function diagnoseSignature(rpc: RpcLike, signature: string): Promise<DiagnoseResult> {
  const tx = await rpc.call<RawTx | null>('getTransaction', [signature, { encoding: 'json', maxSupportedTransactionVersion: 1, commitment: 'confirmed' }]);
  if (!tx) return { status: 'not-found' };
  if (!tx.meta?.err) return { status: 'succeeded', slot: tx.slot };
  const keys = tx.transaction.message.accountKeys.map((k) => (typeof k === 'string' ? k : k.pubkey));
  const instructionPrograms = tx.transaction.message.instructions.map((i) => keys[i.programIdIndex] ?? '');
  return { status: 'failed', diagnosis: diagnose({ err: tx.meta.err, logs: tx.meta.logMessages ?? [], instructionPrograms }), slot: tx.slot, fee: tx.meta.fee ?? null };
}

/**
 * Pulls what @solana/kit puts in a thrown error: a failed preflight carries the logs in `context.logs` and the instruction
 * error in `cause`. Returns null if the value holds neither.
 */
export function fromKitError(e: unknown): { err: unknown; logs: string[] } | null {
  const ctx = (e as { context?: { logs?: string[]; index?: number; code?: number; err?: unknown } } | null)?.context;
  const cause = (e as { cause?: { context?: { index?: number; code?: number } } } | null)?.cause;
  const logs = ctx?.logs;
  const index = cause?.context?.index ?? ctx?.index;
  const code = cause?.context?.code ?? ctx?.code;
  if (ctx?.err !== undefined) return { err: ctx.err, logs: logs ?? [] };
  if (typeof index === 'number' && typeof code === 'number') return { err: { InstructionError: [index, { Custom: code }] }, logs: logs ?? [] };
  return logs ? { err: null, logs } : null;
}
