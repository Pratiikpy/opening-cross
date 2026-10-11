// A wallet's orders in one cross: the ones the indexer knows, plus ones placed from this device a moment ago, each read
// from the chain while open and from the index once closed.
import { API_URL } from './config';
import type { KeyValue } from './sealed';
import { rememberedOrders } from './sealed';
import type { OwnerOrder } from './types';

export type OrderView = {
  address: string;
  open: boolean;
  side: 'buy' | 'sell';
  nonce: string | null;
  revealed: boolean;
  escrow: string;
  price: string | null;
  quantity: string | null;
  status?: OwnerOrder['status'];
  fill?: string | null;
  quote_out?: string | null;
  base_out?: string | null;
  fee?: string | null;
};

type Raw = Record<string, unknown> & { address: string; found: boolean };

export function toView(o: Raw): OrderView | null {
  if (!o.found) return null;
  if (o.open) return { address: o.address, open: true, side: o.side as 'buy' | 'sell', nonce: String(o.nonce), revealed: Boolean(o.revealed), escrow: String(o.escrow), price: null, quantity: null };
  const closed = o as unknown as OwnerOrder;
  return { ...closed, address: o.address, open: false, nonce: null, revealed: closed.status !== 'committed' };
}

export async function loadOrders(cross: string, owner: string, store: KeyValue, fetchImpl: typeof fetch = fetch, base: string = API_URL): Promise<OrderView[]> {
  const indexed = await fetchImpl(`${base}/v1/owners/${owner}/orders`)
    .then((r) => (r.ok ? (r.json() as Promise<{ orders: OwnerOrder[] }>) : { orders: [] as OwnerOrder[] }))
    .catch(() => ({ orders: [] as OwnerOrder[] }));
  const addresses = new Set([...indexed.orders.filter((o) => o.cross_address === cross).map((o) => o.address), ...(await rememberedOrders(store, cross, owner))]);
  if (addresses.size === 0) return [];
  const res = await fetchImpl(`${base}/v1/orders?addresses=${[...addresses].join(',')}`).catch(() => null);
  if (!res?.ok) return [];
  const { orders } = (await res.json()) as { orders: Raw[] };
  return orders.map(toView).filter((v): v is OrderView => v !== null);
}

/** Every order a wallet has across crosses, from the index. */
export async function loadAllOrders(owner: string, fetchImpl: typeof fetch = fetch, base: string = API_URL): Promise<OwnerOrder[] | null> {
  try {
    const r = await fetchImpl(`${base}/v1/owners/${owner}/orders`);
    return r.ok ? ((await r.json()) as { orders: OwnerOrder[] }).orders : null;
  } catch {
    return null;
  }
}
