// Whether a mint stops this keeper's transfers right now, from the token-safety package's own severities:
// `halt` (paused, a multiplier change inside the halt window) and `block` (an active transfer hook, a fee, non-transferable)
// both mean a claim or a finalize on a cross that holds this mint will be refused. Disclosures never do.
import type { Address, GetAccountInfoApi, Rpc } from '@solana/kit';
import { fetchMintSafety } from '@opening-cross/token-safety';
import type { MintHalt } from './keeper.js';

export type HaltOptions = {
  /** Seconds since epoch as the cluster sees it. */
  now: () => Promise<bigint>;
  /** How long a verdict is reused, in milliseconds (default 20 000: roughly two passes). */
  ttlMs?: number;
  /** Milliseconds since epoch for the cache (injected by tests). */
  clock?: () => number;
};

export function mintHaltCheck(rpc: Rpc<GetAccountInfoApi>, o: HaltOptions): (mint: Address) => Promise<MintHalt | null> {
  const ttl = o.ttlMs ?? 20_000;
  const clock = o.clock ?? Date.now;
  const cache = new Map<string, { at: number; halt: MintHalt | null }>();
  return async (mint) => {
    const hit = cache.get(mint);
    if (hit && clock() - hit.at < ttl) return hit.halt;
    const report = await fetchMintSafety(rpc, mint, await o.now());
    const worst = report.risks.find((r) => r.severity !== 'disclose');
    const halt = worst ? { code: worst.code, message: worst.message } : null;
    cache.set(mint, { at: clock(), halt });
    return halt;
  };
}
