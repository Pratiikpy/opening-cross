import { useCallback, useEffect, useRef, useState } from 'react';
import { ActionError } from '@opening-cross/client';

export type ResourceStatus = 'idle' | 'loading' | 'ready' | 'error';

export type Resource<T> = {
  status: ResourceStatus;
  /** The last successful result. It is kept while a refresh runs or after a refresh fails, so a screen never blanks on a hiccup. */
  data: T | null;
  /** The error of the last attempt, cleared by the next success. */
  error: ActionError | null;
  /** True while `data` is older than the last attempt (a refresh is running or failed). */
  stale: boolean;
  /** Milliseconds since the epoch of the last success. */
  updatedAt: number | null;
  refresh: () => Promise<void>;
};

export type ResourceOptions = {
  /** Re-read this often (milliseconds). 0 or omitted: never. */
  pollMs?: number | undefined;
  /** Called once when the resource starts; the returned function undoes it. Call `refresh` from it to re-read on an event. */
  subscribe?: ((refresh: () => void) => () => void) | undefined;
};

const asError = (e: unknown): ActionError => (e instanceof ActionError ? e : new ActionError(e instanceof Error ? e.message : String(e), 'API_REFUSED'));

/**
 * Loads something once and then keeps it fresh. `key` identifies what is loaded (null: nothing yet); a new key starts over. The loader
 * receives an AbortSignal that fires when the key changes or the component unmounts, and a late answer for an old key is dropped.
 */
export function useResource<T>(key: string | null, load: (signal: AbortSignal) => Promise<T>, options: ResourceOptions = {}): Resource<T> {
  const [state, setState] = useState<{ key: string | null; status: ResourceStatus; data: T | null; error: ActionError | null; updatedAt: number | null }>({ key, status: key === null ? 'idle' : 'loading', data: null, error: null, updatedAt: null });
  const loadRef = useRef(load);
  loadRef.current = load;
  const generation = useRef(0);
  const controller = useRef<AbortController | null>(null);

  const run = useCallback(async () => {
    if (key === null) return;
    const mine = ++generation.current;
    controller.current?.abort();
    const ac = new AbortController();
    controller.current = ac;
    try {
      const data = await loadRef.current(ac.signal);
      if (mine === generation.current) setState({ key, status: 'ready', data, error: null, updatedAt: Date.now() });
    } catch (e) {
      if (mine === generation.current && !ac.signal.aborted) setState((s) => ({ key, status: 'error', data: s.key === key ? s.data : null, error: asError(e), updatedAt: s.key === key ? s.updatedAt : null }));
    }
  }, [key]);

  useEffect(() => {
    setState((s) => (s.key === key ? s : { key, status: key === null ? 'idle' : 'loading', data: null, error: null, updatedAt: null }));
    if (key === null) return undefined;
    void run();
    const poll = options.pollMs ? setInterval(() => void run(), options.pollMs) : null;
    const unsubscribe = options.subscribe?.(() => void run());
    return () => {
      generation.current += 1;
      controller.current?.abort();
      if (poll) clearInterval(poll);
      unsubscribe?.();
    };
    // `options.subscribe` is deliberately not a dependency: it is read once per key, like an effect's setup.
  }, [key, run, options.pollMs]);

  const current = state.key === key;
  return {
    status: current ? state.status : key === null ? 'idle' : 'loading',
    data: current ? state.data : null,
    error: current ? state.error : null,
    stale: current && state.status !== 'ready' && state.data !== null,
    updatedAt: current ? state.updatedAt : null,
    refresh: run,
  };
}
