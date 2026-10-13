// A BillingChain over JSON-RPC, trying the endpoints in order when one rate limits or is down.
import type { BillingChain, ParsedTransaction } from './chain.js';

export function jsonRpcChain(urls: readonly string[], fetchImpl: typeof fetch = fetch): BillingChain {
  async function call<T>(method: string, params: unknown[]): Promise<T> {
    let last = 'no endpoint answered';
    for (let round = 0; round < 3; round++) {
      for (const url of urls) {
        try {
          const res = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(20_000) });
          if (res.status === 429 || res.status >= 500) {
            last = `HTTP ${res.status} from ${new URL(url).host}`;
            continue;
          }
          const j = (await res.json()) as { result?: T; error?: { code: number; message: string } };
          if (j.error) {
            last = j.error.message;
            if (j.error.code === 429 || j.error.code === -32005 || /unauthori[sz]ed|api key/i.test(j.error.message)) continue;
            throw new Error(j.error.message);
          }
          return j.result as T;
        } catch (e) {
          last = e instanceof Error ? e.message : String(e);
          if (!/fetch failed|timeout|abort/i.test(last)) throw e;
        }
      }
      await new Promise((r) => setTimeout(r, 800 * (round + 1)));
    }
    throw new Error(`${method}: ${last}`);
  }
  return {
    async mint(mint) {
      const r = await call<{ value: { owner: string; data: { parsed?: { type?: string; info?: { decimals: number } } } } | null }>('getAccountInfo', [mint, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
      const v = r.value;
      if (!v || v.data.parsed?.type !== 'mint' || !v.data.parsed.info) return null;
      return { tokenProgram: v.owner, decimals: v.data.parsed.info.decimals };
    },
    async latestBlockhash() {
      const r = await call<{ value: { blockhash: string; lastValidBlockHeight: number } }>('getLatestBlockhash', [{ commitment: 'confirmed' }]);
      return { blockhash: r.value.blockhash, lastValidBlockHeight: BigInt(r.value.lastValidBlockHeight) };
    },
    async transaction(signature) {
      return call<ParsedTransaction | null>('getTransaction', [signature, { encoding: 'jsonParsed', commitment: 'confirmed', maxSupportedTransactionVersion: 1 }]);
    },
  };
}
