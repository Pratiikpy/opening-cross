'use client';

// Reads from the cluster the gate pages are pointed at (NEXT_PUBLIC_RPC_URL). The public endpoints answer a short burst and
// then 429, so a read moves to the next endpoint at once and backs off after a full round. Reads are safe to repeat.
import { RPC_ENDPOINTS } from '@/lib/config';
import type { AccountReader, ChainAccount } from './gate-client';

export class RpcError extends Error {}

let endpoint = 0;

type Body<T> = { result?: T; error?: { code?: number; message: string } };

export async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const at = endpoint;
    let body = null as Body<T> | null;
    let status = 0;
    try {
      const res = await fetch(RPC_ENDPOINTS[at]!, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
      status = res.status;
      body = (await res.json().catch(() => null)) as Body<T> | null;
    } catch {
      // A refused or dropped connection: try the next endpoint.
    }
    const limited = status === 429 || body?.error?.code === 429;
    if (body && !limited && !body.error) return body.result as T;
    if (body?.error && !limited) throw new RpcError(body.error.message);
    if (attempt >= 8) throw new RpcError(limited ? 'The cluster is rate-limiting this browser. Try again in a moment.' : 'The cluster could not be reached.');
    if (RPC_ENDPOINTS.length > 1 && endpoint === at) endpoint = (at + 1) % RPC_ENDPOINTS.length;
    if (attempt % RPC_ENDPOINTS.length === 0) await new Promise((r) => setTimeout(r, Math.min(8_000, 500 * 2 ** (attempt / RPC_ENDPOINTS.length - 1))));
    else await new Promise((r) => setTimeout(r, 250));
  }
}

const b64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

type Info = { data: [string, string]; owner: string } | null;

/** Reads accounts by address, in the order asked; `null` for one that does not exist. */
export const readAccounts: AccountReader = async (addresses) => {
  const out: (ChainAccount | null)[] = [];
  for (let i = 0; i < addresses.length; i += 100) {
    const { value } = await rpc<{ value: Info[] }>('getMultipleAccounts', [addresses.slice(i, i + 100), { encoding: 'base64', commitment: 'confirmed' }]);
    for (const a of value) out.push(a ? { data: b64(a.data[0]), owner: a.owner as ChainAccount['owner'] } : null);
  }
  return out;
};

/** The cluster's clock, in unix seconds, for rules that depend on time. */
export async function clusterNow(): Promise<bigint> {
  const slot = await rpc<number>('getSlot', [{ commitment: 'confirmed' }]);
  const t = await rpc<number | null>('getBlockTime', [slot]);
  return BigInt(t ?? Math.floor(Date.now() / 1000));
}
