// The cluster's own simulation of an unsigned transaction, over JSON-RPC. Shared by the routes that tell a caller whether a
// transaction would succeed before it is signed.
import { RequestError } from '../tx.js';

export type Simulation = { err: unknown; logs: string[]; unitsConsumed: number | null };

export async function jsonRpcSimulate(url: string, wireBase64: string) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'simulateTransaction', params: [wireBase64, { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed' }] }),
    signal: AbortSignal.timeout(15_000),
  });
  const j = (await res.json()) as { result?: { value: { err: unknown; logs: string[] | null; unitsConsumed?: number } }; error?: { message: string } };
  // A busy endpoint is the API's upstream, not a fault in the request: the server maps this to a 503 the buyer retries, and the
  // work runs before payment settles, so nothing has been charged.
  if (!j.result && (res.status === 429 || res.status >= 500 || /rate limit/i.test(j.error?.message ?? ''))) throw new Error(`HTTP error (${res.status === 200 ? 429 : res.status}): ${j.error?.message ?? 'busy'}`);
  if (!j.result) throw new RequestError(422, `the cluster would not simulate the transaction: ${j.error?.message ?? `HTTP ${res.status}`}`);
  return { err: j.result.value.err, logs: j.result.value.logs ?? [], unitsConsumed: j.result.value.unitsConsumed ?? null };
}
