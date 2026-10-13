// Server-side reads for the receipt page, its JSON and its image. The API reads the proof from a rate-limited public RPC, so a 429
// or 503 is waited out and retried a few times before the receipt reports that it could not be built.
import { API_URL } from './api';
import { type Receipt, type ReceiptInputs, NoReceiptError, buildReceipt } from './receipt';
import type { ReplayResponse } from './replay';

async function read<T>(path: string, revalidate: number): Promise<T> {
  let last = '';
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(`${API_URL}${path}`, { next: { revalidate } });
    if (res.status === 429 || res.status === 503) {
      last = `the API answered ${res.status}`;
      await new Promise((r) => setTimeout(r, 750 * 2 ** attempt));
      continue;
    }
    const body = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) throw new ReceiptLoadError(res.status, body.error ?? `the API answered ${res.status}`);
    return body;
  }
  throw new ReceiptLoadError(503, last || 'the API is busy');
}

export class ReceiptLoadError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export type LoadedReceipt = { receipt: Receipt; canonical: string; sha256: string };

/**
 * Builds the receipt of a cross (and, with `owner`, of that wallet's orders on it) from the live API.
 * Throws NoReceiptError for an unsettled cross and ReceiptLoadError when the API cannot answer.
 */
export async function loadReceipt(address: string, owner?: string): Promise<LoadedReceipt> {
  const [proof, cross, replay, orders, stats] = await Promise.all([
    read<ReceiptInputs['proof']>(`/v1/crosses/${address}/proof`, 60),
    read<{ grid: { priceScale: string }; decimals: { base: number; quote: number } }>(`/v1/crosses/${address}`, 60),
    read<ReplayResponse>(`/v1/replay/${address}`, 60),
    read<{ orders: NonNullable<ReceiptInputs['orders']> }>(`/v1/crosses/${address}/orders`, 60).catch(() => null),
    read<{ network: string }>('/v1/stats', 300),
  ]);
  if (proof.state === 'Live') throw new NoReceiptError('The cross has not settled yet, so there is no result to receipt.');
  return buildReceipt({
    network: stats.network,
    market: { priceScale: cross.grid.priceScale, decimals: cross.decimals },
    proof,
    orders: orders ? orders.orders : null,
    anchors: replay.events.map((e) => ({ event: e.event, kind: e.kind, slot: e.slot, time: e.time, signature: e.signature })),
    ...(owner ? { owner } : {}),
  });
}
