// Server-side reads for the attestation panel and its JSON route (row S2, ADR-0941): the API's attestation view, the anchor transaction from a Solana RPC, and the checks over both.
import { API_URL } from '@/lib/api';
import { RPC_ENDPOINTS } from '@/lib/config';
import { loadReceipt } from '@/lib/receipt-load';
import { type Check, type ChainMemo, type View, checkAttestation, readAnchorTransaction, summarise } from './verify';

export type Loaded =
  | { state: 'unavailable'; reason: string }
  | { state: 'none'; note: string }
  | { state: 'attested'; view: View & { attestation: NonNullable<View['attestation']> }; checks: Check[]; summary: ReturnType<typeof summarise> };

/** A confirmed transaction never changes, so what was read once is kept for the life of the process. */
const readOnce = new Map<string, ChainMemo>();

async function rpc(method: string, params: unknown[]): Promise<unknown> {
  let last: unknown = new Error('no RPC endpoint answered');
  for (const url of RPC_ENDPOINTS) {
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(6000), cache: 'no-store' });
      if (!res.ok) throw new Error(`RPC answered ${res.status}`);
      const j = (await res.json()) as { result?: unknown; error?: { message?: string } };
      if (j.error) throw new Error(j.error.message ?? 'RPC error');
      return j.result;
    } catch (e) {
      last = e;
    }
  }
  throw last;
}

async function chainFor(signature: string): Promise<ChainMemo | null> {
  const have = readOnce.get(signature);
  if (have) return have;
  try {
    const m = await readAnchorTransaction(rpc, signature);
    if (m.found && m.success) readOnce.set(signature, m);
    return m;
  } catch {
    return null;
  }
}

/** The attestation of a cross's receipt with every check repeated here, or the reason there is none. */
export async function loadAttestation(address: string, liveReceiptSha256?: string | null): Promise<Loaded> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}/v1/crosses/${address}/receipt-attestation?optional=1`, { next: { revalidate: 30 } });
  } catch {
    return { state: 'unavailable', reason: 'The Opening Cross API could not be reached.' };
  }
  if (res.status === 404) return { state: 'unavailable', reason: 'This API does not serve receipt attestations yet.' };
  if (!res.ok) return { state: 'unavailable', reason: `The API answered ${res.status}.` };
  const view = (await res.json().catch(() => null)) as View | null;
  if (!view) return { state: 'unavailable', reason: 'The API answered with something that is not an attestation.' };
  const attestation = view.attestation;
  if (!attestation) return { state: 'none', note: view.note ?? 'No attestation exists for this cross yet.' };
  const live = liveReceiptSha256 === undefined ? await loadReceipt(address).then((r) => r.sha256, () => null) : liveReceiptSha256;
  const chain = view.anchor ? await chainFor(view.anchor.signature) : undefined;
  const checks = checkAttestation({ view, liveReceiptSha256: live, ...(chain !== undefined && { chain }) });
  return { state: 'attested', view: { ...view, attestation }, checks, summary: summarise(checks) };
}
