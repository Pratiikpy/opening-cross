// Aggregator adapter (PRODUCT_FEATURES W9, Z1): what a wallet or a router does to include Opening Cross among its venues. It asks
// for a ranked quote of the venues that can fill an order, then asks for the unsigned transaction of the winner, and hands that to
// the user's wallet. It holds no key: the user signs.
import type { Json } from './live.js';

export type AggregatorOrder = { base: string; quote: string; side: 'buy' | 'sell'; amount: string; owner: string };

export type Routed = {
  /** The venues in rank order with the reason for any left out, exactly as the router answered. */
  quote: Json;
  /** The winner's unsigned transaction, or null with the reason none was built. */
  built: { venue: string; cross: string | null; transaction: string; signers: string[]; limit: Json | null; message: string } | { none: string };
};

async function post(fetchImpl: typeof fetch, url: string, body: unknown): Promise<{ status: number; body: Json }> {
  const res = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Json };
}

export async function routeOrder(api: string, o: AggregatorOrder, fetchImpl: typeof fetch = fetch): Promise<Routed> {
  const q = new URLSearchParams({ base: o.base, quote: o.quote, side: o.side, amount: o.amount });
  const quoteRes = await fetchImpl(`${api}/v1/router/quote?${q}`, { headers: { accept: 'application/json' } });
  const quote = (await quoteRes.json()) as Json;
  if (!quoteRes.ok) return { quote, built: { none: String(quote.error ?? `the router answered HTTP ${quoteRes.status}`) } };
  const exec = await post(fetchImpl, `${api}/v1/route/execute`, o);
  if (exec.status !== 200) return { quote, built: { none: String(exec.body.error ?? `HTTP ${exec.status}`) } };
  const b = exec.body;
  return { quote, built: { venue: String(b.venue), cross: (b.cross as string | undefined) ?? null, transaction: String(b.transaction), signers: b.signers as string[], limit: (b.limit as Json | undefined) ?? null, message: String(b.message) } };
}
