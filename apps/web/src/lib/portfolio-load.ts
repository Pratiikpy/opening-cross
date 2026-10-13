// Fetches what a wallet's portfolio needs: its order records, the cross each one sits in, and the chain's view of every order that
// is not yet final in the index. A part that cannot be read is reported, never replaced with a zero.
import { API_URL } from './api';
import type { ChainOrder, CrossFacts } from './portfolio';
import type { CrossDetail, OwnerOrder } from './types';

export const MAX_CROSSES = 60;

export type Loaded = {
  orders: OwnerOrder[];
  crosses: Map<string, CrossFacts>;
  /** The full cross records, for pages that show more than the portfolio needs. */
  details: Map<string, CrossDetail>;
  chain: Map<string, ChainOrder>;
  /** Cross addresses that could not be loaded; their orders are left out of the figures and listed. */
  missing: string[];
  truncated: boolean;
  /** True when the chain check for open orders could not be completed, so claimable orders may be missing. */
  chainUnread: boolean;
  /** `pending` until the chain's view of open orders has been read. */
  chainState: 'pending' | 'done';
};

async function getJson<T>(path: string): Promise<T | null> {
  try {
    const r = await fetch(`${API_URL}${path}`, { cache: 'no-store' });
    return r.ok ? ((await r.json()) as T) : null;
  } catch {
    return null;
  }
}

type ChainRow = { address: string; found: boolean; open?: boolean; nonce?: string | number | bigint; revealed?: boolean } & Partial<OwnerOrder>;

/** The order records and their crosses: fast, and enough to show every figure that does not depend on the chain's live view. */
export async function loadPortfolio(owner: string, onProgress?: (done: number, total: number) => void): Promise<Loaded | null> {
  const res = await getJson<{ orders: OwnerOrder[] }>(`/v1/owners/${owner}/orders`);
  if (!res) return null;
  const addresses = [...new Set(res.orders.map((o) => o.cross_address))];
  const wanted = addresses.slice(0, MAX_CROSSES);
  const details = new Map<string, CrossDetail>();
  const missing: string[] = [];
  // Sixteen at a time, so a wallet with history in many crosses does not open sixty connections at once.
  let done = 0;
  onProgress?.(0, wanted.length);
  for (let i = 0; i < wanted.length; i += 16) {
    await Promise.all(
      wanted.slice(i, i + 16).map(async (a) => {
        const c = await getCross(a);
        if (c) details.set(a, c);
        else missing.push(a);
        onProgress?.(++done, wanted.length);
      }),
    );
  }
  const orders = res.orders.filter((o) => details.has(o.cross_address));
  const crosses = new Map<string, CrossFacts>();
  for (const [a, c] of details) crosses.set(a, c);
  return { orders, crosses, details, chain: new Map(), missing, truncated: addresses.length > MAX_CROSSES, chainUnread: false, chainState: 'pending' };
}

/** Finalized crosses never change, so they are read once per page session. */
const finalized = new Map<string, CrossDetail>();
async function getCross(a: string): Promise<CrossDetail | null> {
  const hit = finalized.get(a);
  if (hit) return hit;
  // A busy API answers 429 with a retry hint; wait it out rather than dropping the cross from the page.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(`${API_URL}/v1/crosses/${a}`, { cache: 'no-store' });
      if (r.status === 429) {
        await new Promise((res) => setTimeout(res, Math.min(10, Number(r.headers.get('retry-after') ?? 2)) * 1000));
        continue;
      }
      if (!r.ok) return null;
      const c = (await r.json()) as CrossDetail;
      if (c.state === 'Finalized') finalized.set(a, c);
      return c;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * The chain's view of every order the index does not yet show as final in a cross that has settled: whether it can still be claimed, and with
 * what nonce. Slow (the API reads each account), so it runs after the page is already on screen. Returns a new Loaded; the input is not changed.
 */
export async function loadChain(base: Loaded): Promise<Loaded> {
  const orders = base.orders.map((o) => ({ ...o }));
  const open = orders.filter((o) => (o.status === 'committed' || o.status === 'revealed') && base.details.get(o.cross_address)!.state !== 'Live').map((o) => o.address);
  const chain = new Map<string, ChainOrder>();
  let chainUnread = false;
  const chunks: string[][] = [];
  for (let i = 0; i < open.length; i += 20) chunks.push(open.slice(i, i + 20));
  const batches = await Promise.all(chunks.map((c) => getJson<{ orders: ChainRow[] }>(`/v1/orders?addresses=${c.join(',')}`)));
  for (const batch of batches) {
    if (!batch) {
      chainUnread = true;
      continue;
    }
    for (const r of batch.orders) {
      if (!r.found) continue;
      if (r.open) chain.set(r.address, { address: r.address, open: true, nonce: String(r.nonce), revealed: Boolean(r.revealed) });
      else {
        // Closed on chain: the index row says what happened. Fold it into the order so it is shown as settled.
        const o = orders.find((x) => x.address === r.address);
        if (o && r.status && r.status !== 'committed' && r.status !== 'revealed') Object.assign(o, { status: r.status, fill: r.fill ?? null, quote_out: r.quote_out ?? null, base_out: r.base_out ?? null, fee: r.fee ?? null });
        chain.set(r.address, { address: r.address, open: false, nonce: null, revealed: true });
      }
    }
  }
  return { ...base, orders, chain, chainUnread, chainState: 'done' };
}
