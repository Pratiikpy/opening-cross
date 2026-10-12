import { useEffect, useState } from 'react';
import type { ActionError, RouteIntent, RouteQuote } from '@opening-cross/client';
import { useOpeningCross } from '../context.js';

export type BestExecution =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; report: Record<string, unknown> }
  /** The deployment has no router (the API answered 404 or 501). Not an error: show nothing, or say best execution is not offered here. */
  | { status: 'unavailable'; reason: string }
  | { status: 'error'; error: ActionError };

/**
 * The best-execution comparison of joining a cross with the best DEX route for the same order, when the deployment offers the router.
 * Pass null to not ask. Requests are debounced, and an answer for an old intent is dropped.
 */
export function useBestExecution(intent: RouteIntent | null, options: { debounceMs?: number } = {}): BestExecution {
  const { api } = useOpeningCross();
  const [state, setState] = useState<BestExecution>({ status: 'idle' });
  const key = intent ? JSON.stringify(intent) : null;
  useEffect(() => {
    if (key === null) {
      setState({ status: 'idle' });
      return undefined;
    }
    const ac = new AbortController();
    setState({ status: 'loading' });
    const t = setTimeout(() => {
      api.routeQuote(JSON.parse(key) as RouteIntent, ac.signal).then(
        (answer: RouteQuote) => {
          if (!ac.signal.aborted) setState(answer);
        },
        (error: ActionError) => {
          if (!ac.signal.aborted) setState({ status: 'error', error });
        },
      );
    }, options.debounceMs ?? 400);
    return () => {
      clearTimeout(t);
      ac.abort();
    };
  }, [api, key, options.debounceMs]);
  return state;
}
