'use client';

// A wallet's balances as the API reads them from the cluster (GET /v1/balances/:owner). The API retries and fails over across
// endpoints, so a page does not fill the browser with rate-limited requests to the public cluster. A balance that could not be read is
// reported as null and is never turned into a zero.
import { HOLDER_API_URL } from './holder-api';

export type TokenBalance = { mint: string; amount: bigint; decimals: number };

type Row = { mint: string; status: 'ok'; amount: string; decimals: number } | { mint: string; status: 'not-a-mint' } | { mint: string; status: 'unavailable'; reason: string };
type Answer = { balances?: Row[]; sol?: { status: 'ok'; lamports: string } | { status: 'unavailable' } };

async function ask(owner: string, query: string): Promise<Answer | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(`${HOLDER_API_URL}/v1/balances/${owner}?${query}`, { cache: 'no-store' });
      if (r.status === 429) {
        await new Promise((res) => setTimeout(res, Math.min(8, Number(r.headers.get('retry-after') ?? 2)) * 1000));
        continue;
      }
      return r.ok ? ((await r.json()) as Answer) : null;
    } catch {
      return null;
    }
  }
  return null;
}

/** Balances of the given mints; a mint maps to null when it could not be read. The whole map is null when the API could not be reached. */
export async function readBalances(owner: string, mints: readonly string[]): Promise<Map<string, TokenBalance | null> | null> {
  const out = new Map<string, TokenBalance | null>();
  for (let i = 0; i < mints.length; i += 20) {
    const a = await ask(owner, `mints=${mints.slice(i, i + 20).join(',')}`);
    if (!a?.balances) return null;
    for (const b of a.balances) out.set(b.mint, b.status === 'ok' ? { mint: b.mint, amount: BigInt(b.amount), decimals: b.decimals } : null);
  }
  return out;
}

/** The SOL balance in lamports; null when it could not be read. */
export async function readLamports(owner: string): Promise<bigint | null> {
  const a = await ask(owner, 'sol=1');
  return a?.sol?.status === 'ok' ? BigInt(a.sol.lamports) : null;
}
