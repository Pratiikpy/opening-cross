import { type ActionError, type OrderView, loadOwnerOrders } from '@opening-cross/client';
import { useOpeningCross } from '../context.js';
import { useResource } from './use-resource.js';

export type UseOrders = { status: 'idle' | 'loading' | 'ready' | 'error'; orders: OrderView[] | null; error: ActionError | null; refresh: () => Promise<void> };

/**
 * A wallet's orders in one cross: open orders read from chain, closed ones from the index, plus orders this browser placed a moment
 * ago. Pass `version` (any number that changes when something happened) to re-read at once.
 */
export function useOrders(cross: string | null, owner: string | null, options: { pollMs?: number; version?: number } = {}): UseOrders {
  const { api, store } = useOpeningCross();
  const r = useResource<OrderView[]>(cross && owner ? `${cross}:${owner}:${options.version ?? 0}` : null, (signal) => loadOwnerOrders(api, store, cross!, owner!, signal), { pollMs: options.pollMs ?? 15_000 });
  return { status: r.status, orders: r.data, error: r.error, refresh: r.refresh };
}
