// RPC client with backoff. Public and metered nodes answer bursts with HTTP 429 and occasionally
// drop connections; an indexer must ride through both rather than crash mid-backfill.
import { createDefaultRpcTransport, createSolanaRpcFromTransport } from '@solana/kit';

const RETRYABLE = /\b(429|502|503|504)\b|ECONNRESET|ETIMEDOUT|fetch failed/;

export function createIndexerRpc(url: string, maxAttempts = 10) {
  const base = createDefaultRpcTransport({ url });
  const transport = (async (...args: Parameters<typeof base>) => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await base(...args);
      } catch (e) {
        const msg = `${String(e)} ${JSON.stringify((e as { context?: unknown }).context ?? {})}`;
        if (attempt >= maxAttempts || !RETRYABLE.test(msg)) throw e;
        await new Promise((r) => setTimeout(r, Math.min(30_000, 250 * 2 ** attempt)));
      }
    }
  }) as typeof base;
  return createSolanaRpcFromTransport(transport);
}

export type IndexerRpc = ReturnType<typeof createIndexerRpc>;
