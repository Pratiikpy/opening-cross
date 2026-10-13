// The live facts an adapter plans from: a mint's token program and decimals, the last price a pair printed, a token's safety
// verdict. Each is one read of the chain or of the public API.
import type { RpcClient } from '@opening-cross/client';
import type { RiskView } from './halt-resume.js';

export type { RiskView };

const TOKEN_PROGRAMS = new Set(['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb']);

/** A mint's token program and decimals. Both programs keep decimals at byte 44. */
export async function readMint(rpc: RpcClient, mint: string): Promise<{ program: string; decimals: number }> {
  const a = await rpc.getAccount(mint);
  if (!a) throw new Error(`mint ${mint} was not found on the cluster`);
  if (!TOKEN_PROGRAMS.has(a.owner)) throw new Error(`${mint} is not a token mint (owned by ${a.owner})`);
  return { program: a.owner, decimals: a.data[44]! };
}

export type Json = Record<string, unknown>;

async function getJson(fetchImpl: typeof fetch, url: string): Promise<Json> {
  const res = await fetchImpl(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`${url} answered HTTP ${res.status}`);
  return (await res.json()) as Json;
}

/** The newest cleared price of the pair, in cross price units, or null. Only a cross whose price scale is 10^baseDecimals counts. */
export async function lastPrint(api: string, base: string, quote: string, baseDecimals: number, fetchImpl: typeof fetch = fetch): Promise<bigint | null> {
  const list = (await getJson(fetchImpl, `${api}/v1/crosses/summary?limit=1000`)).crosses as { address: string; baseMint: string; quoteMint: string; clearingPrice: string | null }[];
  for (const c of list) {
    if (c.baseMint !== base || c.quoteMint !== quote || c.clearingPrice === null) continue;
    const detail = await getJson(fetchImpl, `${api}/v1/crosses/${c.address}`);
    if (BigInt((detail.grid as { priceScale: string }).priceScale) === 10n ** BigInt(baseDecimals)) return BigInt(c.clearingPrice);
  }
  return null;
}

export async function safetyRisks(api: string, mint: string, fetchImpl: typeof fetch = fetch): Promise<RiskView[]> {
  const v = await getJson(fetchImpl, `${api}/v1/tokens/${mint}/safety`);
  return ((v.risks as { severity: string; code: string; message: string }[] | undefined) ?? []).map((r) => ({ severity: r.severity as RiskView['severity'], code: r.code, message: r.message }));
}
