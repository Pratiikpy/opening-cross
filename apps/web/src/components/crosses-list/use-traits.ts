'use client';

import { useEffect, useState } from 'react';
import { API_URL } from '@/lib/api';
import type { CrossTraits, Disclosure, SupplyMode } from '@/lib/cross-list';

/** Per-cross detail is read from chain by the API, so it is fetched only when a filter needs it, a few at a time, and kept. */
const cache = new Map<string, CrossTraits>();
const failed = new Set<string>();
const CONCURRENCY = 4;

async function load(address: string): Promise<void> {
  // The API reads the cross from chain, so a busy RPC behind it can answer 429 or 503: try again a few times before giving up.
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(`${API_URL}/v1/crosses/${address}`);
      if (res.status === 429 || res.status === 503) {
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
        continue;
      }
      if (!res.ok) break;
      const d = (await res.json()) as { disclosure: Disclosure; supplyMode: SupplyMode };
      cache.set(address, { disclosure: d.disclosure, supplyMode: d.supplyMode });
      failed.delete(address);
      return;
    } catch {
      break;
    }
  }
  failed.add(address);
}

export type TraitsState = { traits: ReadonlyMap<string, CrossTraits>; /** Changes whenever `traits` gains an entry, so memoised results can depend on it. */ version: number; pending: number; failed: number };

/** Loads disclosure and supply mode for `addresses` while `enabled`, and reports progress as it goes. Any already in `provided` are not read again. */
export function useTraits(addresses: readonly string[], enabled: boolean, provided?: Readonly<Record<string, CrossTraits>>): TraitsState {
  // Traits served with the list are kept as they come: idempotent, so safe during render, and the first paint already has them.
  if (provided) for (const [a, t] of Object.entries(provided)) cache.set(a, t);
  const [version, bump] = useState(0);
  const key = addresses.join(',');
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const queue = addresses.filter((a) => !cache.has(a));
    failed.clear();
    const worker = async () => {
      for (let a = queue.shift(); a !== undefined && !cancelled; a = queue.shift()) {
        await load(a);
        if (!cancelled) bump((n) => n + 1);
      }
    };
    void Promise.all(Array.from({ length: CONCURRENCY }, worker)).then(() => {
      if (!cancelled) bump((n) => n + 1);
    });
    return () => {
      cancelled = true;
    };
    // `key` stands for the address list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled]);
  const known = addresses.filter((a) => cache.has(a)).length;
  const bad = addresses.filter((a) => failed.has(a)).length;
  return { traits: cache, version, pending: enabled ? addresses.length - known - bad : 0, failed: enabled ? bad : 0 };
}
