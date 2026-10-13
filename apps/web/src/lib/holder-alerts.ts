// Alerts as the browser sees them (M7, Z6, T2; ADR-0400): what the server can deliver, this browser's saved subscriptions and the
// things it follows, and the push subscription itself. Pure helpers are separated from the calls that touch the page, so the rules
// are unit-tested. A channel the server does not have keys for is reported as unavailable; nothing here pretends otherwise.
import { HOLDER_API_URL } from './holder-api';

export type Topic = 'claimable' | 'closing' | 'opening';
export const TOPICS: readonly Topic[] = ['claimable', 'closing', 'opening'];
export const TOPIC_LABEL: Record<Topic, { title: string; detail: string }> = {
  claimable: { title: 'An order of mine can be claimed', detail: 'A cross you ordered in has cleared, or did not print and your escrow can be refunded.' },
  closing: { title: 'A cross I ordered in or follow is closing', detail: 'Ten minutes before the order window ends, while you can still cancel.' },
  opening: { title: 'A cross or market I follow is opening', detail: 'Ten minutes before orders open or a market session starts.' },
};

export type Channel = 'push' | 'email' | 'telegram';

export type AlertConfig = {
  push: { enabled: false } | { enabled: true; publicKey: string };
  email: { enabled: boolean };
  telegram: { enabled: false } | { enabled: true; bot: string };
  leadSeconds: number;
  topics: Topic[];
};

export type FeedItem = { key: string; kind: Topic; at: number; title: string; body: string; href: string };
export type Feed = { asOf: number; horizonSeconds: number; items: FeedItem[] };

export type ManagedSub = { id: string; token: string };
export type Saved = { push: ManagedSub | null; telegram: ManagedSub | null; topics: Topic[] };

export const SAVED_KEY = 'opening-bell.alerts.v1';
export const WATCH_KEY = 'opening-bell.watch.v1';
export const DEFAULT_TOPICS: Topic[] = ['claimable', 'closing'];

const isSub = (v: unknown): v is ManagedSub => typeof v === 'object' && v !== null && typeof (v as ManagedSub).id === 'string' && typeof (v as ManagedSub).token === 'string';

/** What this browser saved. Anything unreadable is treated as nothing saved, never trusted. */
export function parseSaved(raw: string | null | undefined): Saved {
  const empty: Saved = { push: null, telegram: null, topics: [...DEFAULT_TOPICS] };
  if (!raw) return empty;
  try {
    const v = JSON.parse(raw) as Partial<Saved>;
    const topics = Array.isArray(v.topics) ? v.topics.filter((t): t is Topic => (TOPICS as readonly unknown[]).includes(t)) : [];
    return { push: isSub(v.push) ? v.push : null, telegram: isSub(v.telegram) ? v.telegram : null, topics: topics.length ? topics : [...DEFAULT_TOPICS] };
  } catch {
    return empty;
  }
}

// ---------------------------------------------------------------- followed crosses and markets

export type Watch = { crosses: string[]; markets: string[] };
export const MAX_WATCH = 50;
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function parseWatch(raw: string | null | undefined): Watch {
  if (!raw) return { crosses: [], markets: [] };
  try {
    const v = JSON.parse(raw) as Partial<Watch>;
    const clean = (a: unknown) => (Array.isArray(a) ? [...new Set(a.filter((x): x is string => typeof x === 'string' && B58.test(x)))].slice(0, MAX_WATCH) : []);
    return { crosses: clean(v.crosses), markets: clean(v.markets) };
  } catch {
    return { crosses: [], markets: [] };
  }
}

export type WatchKind = 'crosses' | 'markets';
export const isWatching = (w: Watch, kind: WatchKind, address: string): boolean => w[kind].includes(address);

/** Adds or removes one address. Refuses (returns the same list) past MAX_WATCH in total, so the server's limit is never exceeded. */
export function toggleWatch(w: Watch, kind: WatchKind, address: string): Watch {
  if (!B58.test(address)) return w;
  if (isWatching(w, kind, address)) return { ...w, [kind]: w[kind].filter((a) => a !== address) };
  if (w.crosses.length + w.markets.length >= MAX_WATCH) return w;
  return { ...w, [kind]: [...w[kind], address] };
}

/** Everything followed, in the one list the server takes. */
export const allWatched = (w: Watch): string[] => [...w.crosses, ...w.markets];

// ---------------------------------------------------------------- push

/** The VAPID public key as the bytes `pushManager.subscribe` wants. */
export function urlBase64ToBytes(b64url: string): Uint8Array<ArrayBuffer> {
  const padded = (b64url + '='.repeat((4 - (b64url.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(padded);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export type PushSupport = { ok: true } | { ok: false; reason: string };

export function pushSupport(env: { serviceWorker?: unknown; PushManager?: unknown; Notification?: unknown; secure?: boolean }): PushSupport {
  if (!env.secure) return { ok: false, reason: 'Browser notifications need a secure (https) page.' };
  if (!env.serviceWorker || !env.PushManager || !env.Notification) return { ok: false, reason: 'This browser does not support web push. On iPhone it works once the site is added to the Home Screen (iOS 16.4 or later).' };
  return { ok: true };
}

// ---------------------------------------------------------------- the server

type Answer<T> = { ok: true; data: T } | { ok: false; status: number; error: string; how?: string };

async function call<T>(path: string, init?: RequestInit): Promise<Answer<T>> {
  try {
    const r = await fetch(`${HOLDER_API_URL}${path}`, { cache: 'no-store', ...init, ...(init?.body ? { headers: { 'content-type': 'application/json' } } : {}) });
    const j = (await r.json().catch(() => ({}))) as T & { error?: string; how?: string };
    return r.ok ? { ok: true, data: j } : { ok: false, status: r.status, error: j.error ?? `HTTP ${r.status}`, ...(j.how ? { how: j.how } : {}) };
  } catch {
    return { ok: false, status: 0, error: 'The Opening Cross API could not be reached.' };
  }
}
const post = <T>(path: string, body: unknown) => call<T>(path, { method: 'POST', body: JSON.stringify(body) });

export const getAlertConfig = () => call<AlertConfig>('/v1/alerts/config');
export const getFeed = (wallet: string | null, watch: readonly string[]) => {
  const q = new URLSearchParams();
  if (wallet) q.set('wallet', wallet);
  if (watch.length) q.set('watch', watch.join(','));
  return call<Feed>(`/v1/alerts/feed?${q.toString()}`);
};
export const subscribePush = (subscription: unknown, wallet: string | null, topics: Topic[], watch: string[]) => post<ManagedSub & { topics: Topic[] }>('/v1/alerts/push/subscribe', { subscription, wallet, topics, watch });
export const subscribeEmail = (email: string, wallet: string | null, topics: Topic[], watch: string[]) => post<{ status: string; message: string }>('/v1/alerts/email/subscribe', { email, wallet, topics, watch });
export const startTelegram = (wallet: string | null, topics: Topic[], watch: string[]) => post<ManagedSub & { code: string; link: string; expiresIn: number }>('/v1/alerts/telegram/start', { wallet, topics, watch });
export const confirmEmail = (id: string, token: string) => post<{ confirmed: boolean }>('/v1/alerts/email/confirm', { id, token });
export const unsubscribe = (id: string, token: string) => post<{ removed: boolean }>('/v1/alerts/unsubscribe', { id, token });
export const subscriptionStatus = (id: string, token: string) => post<{ id: string; channel: Channel; confirmed: boolean; wallet: string | null; topics: Topic[]; watch: string[] }>('/v1/alerts/status', { id, token });
export const updateSubscription = (id: string, token: string, patch: { wallet?: string | null; topics?: Topic[]; watch?: string[] }) => post<unknown>('/v1/alerts/update', { id, token, ...patch });

// ---------------------------------------------------------------- the page

function store(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function loadSaved(): Saved {
  return parseSaved(store()?.getItem(SAVED_KEY));
}
export function writeSaved(s: Saved): boolean {
  try {
    store()?.setItem(SAVED_KEY, JSON.stringify(s));
    return store() !== null;
  } catch {
    return false;
  }
}
export function loadWatch(): Watch {
  return parseWatch(store()?.getItem(WATCH_KEY));
}
export function writeWatch(w: Watch): boolean {
  try {
    store()?.setItem(WATCH_KEY, JSON.stringify(w));
    return store() !== null;
  } catch {
    return false;
  }
}

/** Registers the service worker and asks the browser for a push subscription. Must be called from a click: browsers refuse the permission prompt otherwise. */
export async function createPushSubscription(publicKey: string): Promise<{ ok: true; subscription: PushSubscriptionJSON } | { ok: false; reason: string }> {
  const support = pushSupport({ serviceWorker: 'serviceWorker' in navigator ? navigator.serviceWorker : undefined, PushManager: typeof PushManager === 'undefined' ? undefined : PushManager, Notification: typeof Notification === 'undefined' ? undefined : Notification, secure: window.isSecureContext });
  if (!support.ok) return support;
  const permission = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
  if (permission !== 'granted') return { ok: false, reason: permission === 'denied' ? 'Notifications are blocked for this site. Allow them in the browser’s site settings, then try again.' : 'You did not allow notifications.' };
  try {
    const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    await navigator.serviceWorker.ready;
    const existing = await reg.pushManager.getSubscription();
    const sub = existing ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToBytes(publicKey) }));
    return { ok: true, subscription: sub.toJSON() };
  } catch (e) {
    return { ok: false, reason: `The browser could not create a push subscription: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** Removes this browser's push subscription (the browser side of unsubscribing). */
export async function dropPushSubscription(): Promise<void> {
  try {
    const reg = await navigator.serviceWorker.getRegistration('/');
    await (await reg?.pushManager.getSubscription())?.unsubscribe();
  } catch {
    // Nothing to remove.
  }
}

/** `in 9 min`, `in 2 h`, `now`, from unix seconds. */
export function relativeTime(at: number, now: number): string {
  if (at === 0) return 'now';
  const d = at - now;
  if (d <= 0) return 'now';
  if (d < 90) return 'in under a minute';
  if (d < 3600) return `in ${Math.round(d / 60)} min`;
  if (d < 86_400) return `in ${Math.round(d / 3600)} h`;
  return `in ${Math.round(d / 86_400)} days`;
}
