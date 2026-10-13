// The wallet's claim center on the phone (Z6, M5; ADR-0412): which of its orders can be paid out or refunded now, found the way the web
// claim center finds them. An order is claimable when the index still lists it as open, its cross has settled (cleared or did not
// print), and the chain still holds the order account (that read also gives the nonce the claim needs). A claim that cannot be
// checked against the chain is not offered: the list says so instead of guessing.
import { API_URL } from './config';
import type { CrossDetail, OwnerOrder } from './types';

export type Claimable = { order: OwnerOrder; cross: CrossDetail; nonce: string; kind: 'cleared' | 'no-print' };

type Fetch = typeof fetch;
type ChainRow = { address: string; found: boolean; open?: boolean; nonce?: string | number };

async function json<T>(f: Fetch, url: string): Promise<T | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await f(url);
      if (r.status === 429) {
        await new Promise((res) => setTimeout(res, 1500));
        continue;
      }
      return r.ok ? ((await r.json()) as T) : null;
    } catch {
      return null;
    }
  }
  return null;
}

/** Pure: the orders of `rows` that are still open in the index and sit in a settled cross, paired with that cross. */
export function candidates(rows: readonly OwnerOrder[], crosses: ReadonlyMap<string, CrossDetail>): { order: OwnerOrder; cross: CrossDetail }[] {
  return rows
    .filter((o) => o.status === 'committed' || o.status === 'revealed')
    .flatMap((o) => {
      const c = crosses.get(o.cross_address);
      return c && (c.state === 'Cleared' || c.state === 'NoPrint') ? [{ order: o, cross: c }] : [];
    });
}

export type ClaimScan = { claimable: Claimable[]; checked: boolean; failed: boolean };

/** Every order of `owner` that can be claimed now. `checked` is false when the chain could not be read for some of them. */
export async function scanClaims(owner: string, f: Fetch = fetch, base: string = API_URL): Promise<ClaimScan> {
  const res = await json<{ orders: OwnerOrder[] }>(f, `${base}/v1/owners/${owner}/orders`);
  if (!res) return { claimable: [], checked: false, failed: true };
  const open = res.orders.filter((o) => o.status === 'committed' || o.status === 'revealed');
  const crosses = new Map<string, CrossDetail>();
  for (const a of [...new Set(open.map((o) => o.cross_address))].slice(0, 60)) {
    const c = await json<CrossDetail>(f, `${base}/v1/crosses/${a}`);
    if (c) crosses.set(a, c);
  }
  const cands = candidates(open, crosses);
  const claimable: Claimable[] = [];
  let checked = open.every((o) => crosses.has(o.cross_address));
  for (let i = 0; i < cands.length; i += 20) {
    const chunk = cands.slice(i, i + 20);
    const r = await json<{ orders: ChainRow[] }>(f, `${base}/v1/orders?addresses=${chunk.map((c) => c.order.address).join(',')}`);
    if (!r) {
      checked = false;
      continue;
    }
    for (const row of r.orders) {
      const c = chunk.find((x) => x.order.address === row.address);
      if (c && row.found && row.open && row.nonce !== undefined) claimable.push({ ...c, nonce: String(row.nonce), kind: c.cross.state === 'NoPrint' ? 'no-print' : 'cleared' });
    }
  }
  return { claimable, checked, failed: false };
}

/** The body of POST /v1/tx/claim for one claimable order, the wallet paying its own fee. */
export const claimBody = (c: Claimable, owner: string) => ({ cross: c.cross.address, owner, nonce: c.nonce, payer: owner });
