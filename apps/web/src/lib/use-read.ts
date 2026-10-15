'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { readMintFull } from './issuer-chain';
import { type ApiFailure, readApi } from './new-programs';

export type ReadState<T> = { phase: 'idle' } | { phase: 'loading' } | { phase: 'ok'; data: T } | ({ phase: 'error' } & ApiFailure);

/**
 * A GET against the API, read again when `path` changes or `reload()` is called. A path of `null` reads nothing. The previous answer stays on screen
 * while a re-read is in flight, so a screen does not flicker after an action.
 */
export function useRead<T>(path: string | null): ReadState<T> & { reload: () => void } {
  const [state, setState] = useState<ReadState<T>>({ phase: path ? 'loading' : 'idle' });
  const [tick, setTick] = useState(0);
  const seen = useRef<string | null>(null);
  useEffect(() => {
    if (!path) {
      seen.current = null;
      setState({ phase: 'idle' });
      return;
    }
    let live = true;
    if (seen.current !== path) setState({ phase: 'loading' });
    seen.current = path;
    void readApi<T>(path).then((r) => {
      if (!live) return;
      setState(r.ok ? { phase: 'ok', data: r.data } : { phase: 'error', status: r.status, error: r.error, reason: r.reason, body: r.body });
    });
    return () => {
      live = false;
    };
  }, [path, tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { ...state, reload };
}

export type MintInfo = { decimals: number; program: string; symbol: string | null; supply: bigint | null; mintAuthority: string | null; freezeAuthority: string | null; extensions: string[] };
const cache = new Map<string, Promise<MintInfo | null>>();

/** A token's decimals and authorities from the cluster; `null` while loading or when it cannot be read. */
export function useMint(mint: string | null | undefined): { info: MintInfo | null; loading: boolean; failed: boolean } {
  const [state, setState] = useState<{ mint: string | null; info: MintInfo | null; done: boolean }>({ mint: null, info: null, done: false });
  useEffect(() => {
    if (!mint) return;
    let live = true;
    let asked = cache.get(mint);
    if (!asked) {
      asked = readMintFull(mint).then((r) =>
        r.ok ? { decimals: r.decimals, program: r.program, symbol: r.metadata?.symbol ?? null, supply: r.supply ?? null, mintAuthority: r.mintAuthority, freezeAuthority: r.freezeAuthority, extensions: r.extensions } : null,
      );
      cache.set(mint, asked);
      void asked.then((v) => v === null && cache.delete(mint));
    }
    void asked.then((info) => live && setState({ mint, info, done: true }));
    return () => {
      live = false;
    };
  }, [mint]);
  if (!mint) return { info: null, loading: false, failed: false };
  const current = state.mint === mint;
  return { info: current ? state.info : null, loading: !current || !state.done, failed: current && state.done && state.info === null };
}
