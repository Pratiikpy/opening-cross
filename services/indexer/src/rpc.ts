// RPC client with backoff. Public and metered nodes answer bursts with HTTP 429 and occasionally
// drop connections; an indexer must ride through both rather than crash mid-backfill.
import { createDefaultRpcTransport, createSolanaRpcFromTransport } from '@solana/kit';

const RETRYABLE = /\b(429|502|503|504)\b|ECONNRESET|ETIMEDOUT|fetch failed/;

/**
 * `url` may list several endpoints separated by commas. The first is used until it answers with a retryable error (a rate limit, a
 * gateway error or a dropped connection); the call then moves on to the next endpoint at once, and only after every endpoint has
 * failed does it wait and start the list again. Only errors move a call between endpoints: an empty answer (an account not found
 * yet) is never retried elsewhere, so a lagging endpoint cannot turn a missing account into a different answer.
 */
export function createIndexerRpc(url: string, maxAttempts = 10) {
  const urls = url.split(',').map((u) => u.trim()).filter(Boolean);
  const bases = urls.map((u) => createDefaultRpcTransport({ url: u }));
  let current = 0;
  const transport = (async (...args: Parameters<(typeof bases)[number]>) => {
    let failedInARow = 0;
    for (let attempt = 1; ; attempt++) {
      const index = current;
      try {
        return await bases[index]!(...args);
      } catch (e) {
        const msg = `${String(e)} ${JSON.stringify((e as { context?: unknown }).context ?? {})}`;
        if (attempt >= maxAttempts || !RETRYABLE.test(msg)) throw e;
        failedInARow++;
        if (bases.length > 1) {
          // Another call may already have moved on while this one was in flight.
          if (current === index) current = (index + 1) % bases.length;
          if (failedInARow % bases.length !== 0) continue;
        }
        await new Promise((r) => setTimeout(r, Math.min(30_000, 250 * 2 ** Math.ceil(attempt / bases.length))));
      }
    }
  }) as (typeof bases)[number];
  return createSolanaRpcFromTransport(transport);
}

export type IndexerRpc = ReturnType<typeof createIndexerRpc>;
