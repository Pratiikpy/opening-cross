'use client';

// The one path every action takes: the API builds an unsigned transaction, the user's wallet signs
// it, the app sends it to the cluster and waits for confirmation. Errors come back in the program's
// own words, never as a stack trace.
import { API_URL } from './api';

import { RPC_ENDPOINTS, RPC_URL } from './config';

export { RPC_URL };

export type Signer = (input: { transaction: Uint8Array }) => Promise<{ signedTransaction: Uint8Array }>;
export type Unsigned = { transaction: string; signers: string[] };

export class ActionError extends Error {
  /** How many of a multi-transaction action had already landed when it failed. */
  completed = 0;
}

const b64ToBytes = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const bytesToB64 = (b: Uint8Array) => btoa(Array.from(b, (x) => String.fromCharCode(x)).join(''));

/** POSTs to an API transaction builder; returns the unsigned transactions in order. */
export async function build(path: string, body: unknown): Promise<{ txs: Unsigned[]; extra: Record<string, unknown> }> {
  let res: Response;
  try {
    res = await fetch(/^https?:\/\//.test(path) ? path : `${API_URL}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  } catch {
    throw new ActionError('The Opening Cross API could not be reached. Nothing was signed.');
  }
  const json = (await res.json()) as Record<string, unknown> & { error?: string; transactions?: Unsigned[]; transaction?: string; signers?: string[] };
  if (!res.ok) throw new ActionError(json.error ?? `The API refused the request (HTTP ${res.status}).`);
  const txs = json.transactions ?? (json.transaction ? [{ transaction: json.transaction, signers: json.signers ?? [] }] : []);
  return { txs, extra: json };
}

let endpoint = 0;

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  // Public endpoints answer bursts with 429. Sending and polling are safe to repeat (the same signed bytes, a read), so move to the
  // next endpoint at once, and after a full round back off, instead of reporting a failure for a transaction that may well have landed.
  let res: Response;
  let json: { result?: T; error?: { code?: number; message: string; data?: { logs?: string[] } } };
  for (let attempt = 1; ; attempt++) {
    const at = endpoint;
    try {
      res = await fetch(RPC_ENDPOINTS[at]!, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
      json = (await res.json().catch(() => ({ error: { message: `The RPC endpoint answered HTTP ${res.status}.` } }))) as typeof json;
    } catch (e) {
      // A refused or dropped connection (a limited endpoint's answer can arrive without CORS headers): try the next one.
      if (attempt >= 8) throw new ActionError(`The RPC endpoint could not be reached: ${e instanceof Error ? e.message : String(e)}`);
      if (RPC_ENDPOINTS.length > 1 && endpoint === at) endpoint = (at + 1) % RPC_ENDPOINTS.length;
      await new Promise((r) => setTimeout(r, 500));
      continue;
    }
    const limited = res.status === 429 || json.error?.code === 429;
    if (!limited || attempt >= 8) break;
    if (RPC_ENDPOINTS.length > 1 && endpoint === at) endpoint = (at + 1) % RPC_ENDPOINTS.length;
    if (attempt % RPC_ENDPOINTS.length === 0) await new Promise((r) => setTimeout(r, Math.min(8_000, 500 * 2 ** (attempt / RPC_ENDPOINTS.length - 1))));
  }
  if (json.error) {
    const reason = json.error.data?.logs?.find((l) => l.includes('Error Message:'))?.split('Error Message:')[1]?.trim();
    throw new ActionError(reason ? `The program refused this: ${reason}` : json.error.message);
  }
  return json.result as T;
}

/** Signs one transaction with the wallet, sends it and waits until it is confirmed. */
async function landOne(t: Unsigned, label: string, sign: Signer, onStatus?: (s: string) => void): Promise<string> {
  onStatus?.(`Waiting for your wallet${label}…`);
  let signed: Uint8Array;
  try {
    signed = (await sign({ transaction: b64ToBytes(t.transaction) })).signedTransaction;
  } catch (e) {
    throw new ActionError(e instanceof Error && /reject|cancel|denied/i.test(e.message) ? 'You declined in your wallet. Nothing was sent.' : `Your wallet could not sign: ${e instanceof Error ? e.message : String(e)}`);
  }
  onStatus?.(`Sending${label}…`);
  const sig = await rpc<string>('sendTransaction', [bytesToB64(signed), { encoding: 'base64', preflightCommitment: 'confirmed' }]);
  onStatus?.(`Confirming${label}…`);
  const deadline = Date.now() + 90_000;
  for (;;) {
    const st = await rpc<{ value: ({ err: unknown; confirmationStatus: string } | null)[] }>('getSignatureStatuses', [[sig]]);
    const s = st.value[0];
    if (s?.err) throw new ActionError(`The transaction failed on chain: ${JSON.stringify(s.err)}`);
    if (s && (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized')) return sig;
    if (Date.now() > deadline) throw new ActionError(`Not confirmed after 90 s. Check ${sig} in an explorer before retrying.`);
    await new Promise((r) => setTimeout(r, 1_500));
  }
}

/** Signs each transaction with the wallet, sends it and waits until it is confirmed. A failure carries how many had already landed. */
export async function signSendConfirm(txs: Unsigned[], sign: Signer, onStatus?: (s: string) => void): Promise<string[]> {
  const sigs: string[] = [];
  for (const [i, t] of txs.entries()) {
    try {
      sigs.push(await landOne(t, txs.length > 1 ? ` (${i + 1} of ${txs.length})` : '', sign, onStatus));
    } catch (e) {
      if (e instanceof ActionError) e.completed = sigs.length;
      throw e;
    }
  }
  return sigs;
}
