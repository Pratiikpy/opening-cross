// The in-app alert feed (M7; ADR-0400, ADR-0412): what needs attention now for the connected wallet, from GET /v1/alerts/feed. Push
// notifications to a phone need a build with a push credential (Firebase) and are the one step this app cannot take on its own: see
// docs/HUMAN_TASKS.md. Until then this feed is how the phone says what needs the person.
import { API_URL } from './config';

export type FeedItem = { key: string; kind: 'claimable' | 'closing' | 'opening'; at: number; title: string; body: string; href: string };

export async function loadFeed(wallet: string, f: typeof fetch = fetch, base: string = API_URL): Promise<FeedItem[] | null> {
  try {
    const r = await f(`${base}/v1/alerts/feed?wallet=${wallet}`);
    return r.ok ? ((await r.json()) as { items: FeedItem[] }).items : null;
  } catch {
    return null;
  }
}

/** Where a feed link leads in this app: a cross opens its screen, anything else opens the orders screen. */
export function targetOf(href: string): { screen: 'Cross'; address: string } | { screen: 'Orders' } {
  const m = /^\/crosses\/([1-9A-HJ-NP-Za-km-z]{32,44})$/.exec(href);
  return m ? { screen: 'Cross', address: m[1]! } : { screen: 'Orders' };
}

/** `in 9 min`, `now`: how far away the event is. */
export function when(at: number, now: number): string {
  if (at === 0 || at <= now) return 'now';
  const d = at - now;
  return d < 90 ? 'in under a minute' : d < 3600 ? `in ${Math.round(d / 60)} min` : d < 86_400 ? `in ${Math.round(d / 3600)} h` : `in ${Math.round(d / 86_400)} days`;
}
