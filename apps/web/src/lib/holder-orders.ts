'use client';

// A wallet's orders in one cross as the chain and the index report them: the chain says whether an order is still open (and its nonce and
// escrow), the index says what an open order's limit is. Shared by the "Your orders" panel and by the order ticket, which needs the
// wallet's live orders to check the cross's per-identity limits before asking the wallet to sign.
import { API_URL } from './api';
import { HOLDER_API_URL } from './holder-api';
import { rememberedOrders } from './sealed';
import type { OwnerOrder } from './types';
import { indexedTerms } from '@/components/cross/own-orders';

/** One order as the chain sees it now (open) or as the indexer recorded it (closed). */
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

export async function loadOwnOrders(cross: string, owner: string, sealed: boolean): Promise<OrderView[]> {
  const indexed = await fetch(`${API_URL}/v1/owners/${owner}/orders`, { cache: 'no-store' })
    .then((r) => (r.ok ? (r.json() as Promise<{ orders: OwnerOrder[] }>) : { orders: [] }))
    .catch(() => ({ orders: [] as OwnerOrder[] }));
  const addresses = new Set([...indexed.orders.filter((o) => o.cross_address === cross).map((o) => o.address), ...rememberedOrders(cross, owner)]);
  if (addresses.size === 0) return [];
  const res = await fetch(`${API_URL}/v1/orders?addresses=${[...addresses].join(',')}`, { cache: 'no-store' }).catch(() => null);
  if (!res?.ok) return [];
  const { orders } = (await res.json()) as { orders: (Record<string, unknown> & { address: string; found: boolean })[] };
  // The chain says an open order is open but not at what price (the price sits in the merged book, unattributed). The index records the
  // limit of an open (unsealed) order from its commit, and of a sealed one once revealed, so those are used when it has them; for any other
  // order they stay null and the page falls back to what this browser saved when it placed it.
  const terms = indexedTerms(indexed.orders);
  const views = orders.map((o) =>
    !o.found
      ? null
      : o.open
        ? ({ address: o.address, open: true, side: o.side, nonce: String(o.nonce), revealed: Boolean(o.revealed), escrow: String(o.escrow), price: terms.get(o.address)?.price ?? null, quantity: terms.get(o.address)?.quantity ?? null } as OrderView)
        : ({ ...(o as unknown as OwnerOrder), address: o.address, open: false, nonce: null, revealed: o.status !== 'committed' } as OrderView),
  );
  const found = views.filter((v): v is OrderView => v !== null);
  // An order placed in the last minute has no price in the index yet. Its price is an argument of the transaction that placed it, so it
  // is read from the chain (through the API) rather than left off the chart. A sealed order stays without one until it is revealed.
  await Promise.all(
    found
      .filter((o) => o.open && o.price === null && !(o.revealed === false && sealed))
      .slice(0, 8)
      .map(async (o) => {
        try {
          const r = await fetch(`${HOLDER_API_URL}/v1/orders/${o.address}/terms`, { cache: 'no-store' });
          const j = (await r.json()) as { terms?: { price: string; quantity: string } | null };
          if (r.ok && j.terms) Object.assign(o, { price: j.terms.price, quantity: j.terms.quantity });
        } catch {
          // The chart then says plainly that this order's price is not known.
        }
      }),
  );
  return found;
}

/** What the program's applicant record holds for the wallet: its live orders and the quote escrowed in its live buys. Open orders only; a claimed order still counts, but none can be claimed while the cross is live. */
export function usageOf(orders: readonly OrderView[]): { orders: number; escrow: bigint } {
  const live = orders.filter((o) => o.open);
  return { orders: live.length, escrow: live.filter((o) => o.side === 'buy').reduce((s, o) => s + BigInt(o.escrow), 0n) };
}
