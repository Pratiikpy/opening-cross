// A wallet's orders in one cross, as one list: open orders read from chain (always current), closed ones from the index.
// Orders this client placed a moment ago are included even before the indexer, which follows finalized blocks, has seen them.
import type { ApiClient } from './api.js';
import type { OrderLog } from './sealed.js';
import type { OrderStatus, OwnerOrder, Side } from './types.js';

/** One order as the chain sees it now (open) or as the indexer recorded it (closed). */
export type OrderView = {
  address: string;
  open: boolean;
  side: Side;
  /** Known for open orders (read from chain). */
  nonce: string | null;
  revealed: boolean;
  escrow: string;
  price: string | null;
  quantity: string | null;
  status?: OrderStatus;
  fill?: string | null;
  quote_out?: string | null;
  base_out?: string | null;
  fee?: string | null;
};

export async function loadOwnerOrders(api: ApiClient, log: OrderLog | null, cross: string, owner: string, signal?: AbortSignal): Promise<OrderView[]> {
  const indexed = await api.ownerOrders(owner, signal).catch((): OwnerOrder[] => []);
  const remembered = log ? await log.remembered(cross, owner) : [];
  const addresses = [...new Set([...indexed.filter((o) => o.cross_address === cross).map((o) => o.address), ...remembered])];
  if (addresses.length === 0) return [];
  const rows = await api.orders(addresses, signal);
  const views: OrderView[] = [];
  for (const o of rows) {
    if (!o.found) continue;
    if (o.open) {
      views.push({ address: o.address, open: true, side: o.side, nonce: String(o.nonce), revealed: Boolean(o.revealed), escrow: String(o.escrow), price: null, quantity: null });
    } else {
      const { found: _found, open: _open, cross_address: _c, ...rest } = o;
      views.push({ ...rest, address: o.address, open: false, nonce: null, revealed: o.status !== 'committed' });
    }
  }
  return views;
}
