// The Rpc interface over JSON-RPC. Reads only. Public endpoints answer bursts with 429, so a call is repeated with growing pauses.
import type { Rpc } from './types.js';

const b64 = (s: string) => Uint8Array.from(Buffer.from(s, 'base64'));
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function toBase58(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let out = '';
  while (n > 0n) {
    out = BASE58[Number(n % 58n)]! + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = '1' + out;
  }
  return out;
}

export function jsonRpc(url: string, o: { attempts?: number; sleep?: (ms: number) => Promise<void>; fetch?: typeof fetch } = {}): Rpc {
  const f = o.fetch ?? fetch;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const attempts = o.attempts ?? 6;
  async function call<T>(method: string, params: unknown[]): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      let res: Response | null = null;
      let body: { result?: T; error?: { code?: number; message: string } } = {};
      try {
        res = await f(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(20_000) });
        body = (await res.json().catch(() => ({}))) as typeof body;
      } catch (e) {
        if (attempt >= attempts) throw new Error(`${method}: the RPC endpoint could not be reached (${String(e).slice(0, 100)})`);
        await sleep(Math.min(8_000, 400 * 2 ** attempt));
        continue;
      }
      const busy = res.status === 429 || res.status >= 500 || body.error?.code === 429 || /rate limit/i.test(body.error?.message ?? '');
      if (busy && attempt < attempts) {
        await sleep(Math.min(8_000, 400 * 2 ** attempt));
        continue;
      }
      if (body.error) throw new Error(`${method}: ${body.error.message}`);
      if (busy) throw new Error(`${method}: the RPC endpoint is busy (HTTP ${res.status})`);
      return body.result as T;
    }
  }
  return {
    async getAccount(address) {
      const r = await call<{ value: { data: [string, string]; owner: string; lamports: number } | null }>('getAccountInfo', [address, { encoding: 'base64', commitment: 'confirmed' }]);
      return r.value ? { data: b64(r.value.data[0]), owner: r.value.owner, lamports: BigInt(r.value.lamports) } : null;
    },
    async getProgramAccounts(program, filters) {
      const f2 = filters.map((x) => (x.dataSize !== undefined ? { dataSize: x.dataSize } : { memcmp: { offset: x.memcmp!.offset, bytes: toBase58(x.memcmp!.bytes), encoding: 'base58' } }));
      const r = await call<{ pubkey: string; account: { data: [string, string] } }[]>('getProgramAccounts', [program, { encoding: 'base64', commitment: 'confirmed', filters: f2 }]);
      return r.map((a) => ({ address: a.pubkey, data: b64(a.account.data[0]) }));
    },
    async getTokenBalance(account) {
      try {
        const r = await call<{ value: { amount: string } }>('getTokenAccountBalance', [account, { commitment: 'confirmed' }]);
        return BigInt(r.value.amount);
      } catch (e) {
        if (/could not find account|Invalid param/i.test(String(e))) return null;
        throw e;
      }
    },
    async getSignatures(address, opts) {
      const r = await call<{ signature: string; slot: number; err: unknown; blockTime: number | null }[]>('getSignaturesForAddress', [address, { limit: opts.limit, commitment: 'confirmed', ...(opts.until ? { until: opts.until } : {}) }]);
      return r.map((s) => ({ signature: s.signature, slot: BigInt(s.slot), err: s.err, blockTime: s.blockTime }));
    },
    async getTokenChanges(signature) {
      const r = await call<{ meta?: { err: unknown; preTokenBalances?: Bal[]; postTokenBalances?: Bal[] } } | null>('getTransaction', [signature, { encoding: 'jsonParsed', commitment: 'confirmed', maxSupportedTransactionVersion: 0 }]);
      if (!r?.meta || r.meta.err) return null;
      const delta = new Map<string, { mint: string; owner: string; delta: bigint }>();
      const add = (b: Bal, sign: 1n | -1n) => {
        if (!b.owner) return;
        const k = `${b.owner}|${b.mint}`;
        const cur = delta.get(k) ?? { mint: b.mint, owner: b.owner, delta: 0n };
        cur.delta += sign * BigInt(b.uiTokenAmount.amount);
        delta.set(k, cur);
      };
      (r.meta.preTokenBalances ?? []).forEach((b) => add(b, -1n));
      (r.meta.postTokenBalances ?? []).forEach((b) => add(b, 1n));
      return [...delta.values()].filter((d) => d.delta !== 0n);
    },
    async unixTime() {
      const slot = await call<number>('getSlot', [{ commitment: 'confirmed' }]);
      const t = await call<number | null>('getBlockTime', [slot]).catch(() => null);
      return t ?? Math.floor(Date.now() / 1000);
    },
  };
}

type Bal = { mint: string; owner?: string; uiTokenAmount: { amount: string } };
