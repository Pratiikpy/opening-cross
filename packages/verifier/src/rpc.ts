// An RPC client for the command line. Public nodes answer bursts with HTTP 429 and sometimes drop a connection;
// a verifier run by a stranger against a public endpoint must ride through both instead of printing a stack trace.
import { createDefaultRpcTransport, createSolanaRpcFromTransport } from '@solana/kit';

const RETRYABLE = /\b(429|502|503|504)\b|ECONNRESET|ETIMEDOUT|fetch failed/;

export function createRetryingRpc(url: string, opts: { attempts?: number; baseMs?: number; maxMs?: number } = {}) {
  const attempts = opts.attempts ?? 12;
  const baseMs = opts.baseMs ?? 400;
  const maxMs = opts.maxMs ?? 8_000;
  const base = createDefaultRpcTransport({ url });
  const transport = (async (...args: Parameters<typeof base>) => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await base(...args);
      } catch (e) {
        const msg = `${String(e)} ${JSON.stringify((e as { context?: unknown }).context ?? {}, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))}`;
        if (attempt >= attempts || !RETRYABLE.test(msg)) throw e;
        await new Promise((r) => setTimeout(r, Math.min(maxMs, baseMs * 2 ** (attempt - 1))));
      }
    }
  }) as typeof base;
  return createSolanaRpcFromTransport(transport);
}
