// Hyperliquid HIP-3 builder-deployed perpetuals on the `xyz` DEX: a free, permissionless, 24/7 price for US equities,
// used here as an independent reference. The response carries no update time of its own, so a value is stamped with
// the time it was read.
import type { Reference } from '../types.js';

export const HYPERLIQUID_INFO_URL = 'https://api.hyperliquid.xyz/info';
export const HIP3_DEX = 'xyz';

type Ctx = { oraclePx?: string; markPx?: string };
export type Hip3Response = [{ universe: { name: string }[] }, Ctx[]];

/** Decimal string to micro-USD, refusing more than six decimals. */
export function toE6(text: string): bigint {
  const m = /^(\d+)(?:\.(\d{0,6})0*)?$/.exec(text.trim());
  if (!m) throw new Error(`price "${text}" is not a decimal with at most six significant decimals`);
  return BigInt(m[1] as string) * 1_000_000n + BigInt((m[2] ?? '').padEnd(6, '0'));
}

export function parseHip3(resp: Hip3Response, readAt: number): Reference[] {
  const [meta, ctxs] = resp;
  const out: Reference[] = [];
  meta.universe.forEach((u, i) => {
    const ticker = u.name.startsWith(`${HIP3_DEX}:`) ? u.name.slice(HIP3_DEX.length + 1).toUpperCase() : null;
    const ctx = ctxs[i];
    if (!ticker || !ctx) return;
    for (const [kind, px] of [['hip3_oracle', ctx.oraclePx], ['hip3_mark', ctx.markPx]] as const) {
      if (!px) continue;
      const priceE6 = toE6(px);
      if (priceE6 > 0n) out.push({ kind, ticker, priceE6, readAt });
    }
  });
  return out;
}

export async function fetchHip3(now: () => number = () => Math.floor(Date.now() / 1000), timeoutMs = 15_000): Promise<Reference[]> {
  const res = await fetch(HYPERLIQUID_INFO_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'metaAndAssetCtxs', dex: HIP3_DEX }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`Hyperliquid HTTP ${res.status}`);
  return parseHip3((await res.json()) as Hip3Response, now());
}
