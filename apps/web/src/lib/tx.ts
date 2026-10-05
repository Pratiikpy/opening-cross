'use client';

// The one path every action takes: the API builds an unsigned transaction, the user's wallet signs
// it, the app sends it to the cluster and waits for confirmation. Errors come back in the program's
// own words, never as a stack trace.
import { API_URL } from './api';

export const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL ?? 'https://api.devnet.solana.com';

export type Signer = (input: { transaction: Uint8Array }) => Promise<{ signedTransaction: Uint8Array }>;
export type Unsigned = { transaction: string; signers: string[] };

export class ActionError extends Error {}

const b64ToBytes = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const bytesToB64 = (b: Uint8Array) => btoa(Array.from(b, (x) => String.fromCharCode(x)).join(''));

/** POSTs to an API transaction builder; returns the unsigned transactions in order. */
export async function build(path: string, body: unknown): Promise<{ txs: Unsigned[]; extra: Record<string, unknown> }> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  } catch {
    throw new ActionError('The Opening Cross API could not be reached. Nothing was signed.');
  }
  const json = (await res.json()) as Record<string, unknown> & { error?: string; transactions?: Unsigned[]; transaction?: string; signers?: string[] };
  if (!res.ok) throw new ActionError(json.error ?? `The API refused the request (HTTP ${res.status}).`);
  const txs = json.transactions ?? (json.transaction ? [{ transaction: json.transaction, signers: json.signers ?? [] }] : []);
  return { txs, extra: json };
}

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const res = await fetch(RPC_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const json = (await res.json()) as { result?: T; error?: { message: string; data?: { logs?: string[] } } };
  if (json.error) {
    const reason = json.error.data?.logs?.find((l) => l.includes('Error Message:'))?.split('Error Message:')[1]?.trim();
    throw new ActionError(reason ? `The program refused this: ${reason}` : json.error.message);
  }
  return json.result as T;
}

/** Signs each transaction with the wallet, sends it and waits until it is confirmed. */
export async function signSendConfirm(txs: Unsigned[], sign: Signer, onStatus?: (s: string) => void): Promise<string[]> {
  const sigs: string[] = [];
  for (const [i, t] of txs.entries()) {
    const label = txs.length > 1 ? ` (${i + 1} of ${txs.length})` : '';
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
      if (s && (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized')) break;
      if (Date.now() > deadline) throw new ActionError(`Not confirmed after 90 s. Check ${sig} in an explorer before retrying.`);
      await new Promise((r) => setTimeout(r, 800));
    }
    sigs.push(sig);
  }
  return sigs;
}
