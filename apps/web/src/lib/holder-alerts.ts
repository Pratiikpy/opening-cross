// Alerts as the browser sees them (M7, Z6, T2; ADR-0400): what the server can deliver, this browser's saved subscriptions and the
// things it follows, and the push subscription itself. Pure helpers are separated from the calls that touch the page, so the rules
// are unit-tested. A channel the server does not have keys for is reported as unavailable; nothing here pretends otherwise.
import { HOLDER_API_URL } from './holder-api';

/** What a person is reminded of about orders and the crosses and markets they follow. */
export type ReminderTopic = 'claimable' | 'closing' | 'opening';
/** What happened to something they follow: an insider moved a token out, a treasury paid out (row F5, ADR-0940). */
export type MovementTopic = 'insider' | 'team' | 'treasury';
export type Topic = ReminderTopic | MovementTopic;
/** The reminder topics, in the order the page shows them. */
export const TOPICS: readonly ReminderTopic[] = ['claimable', 'closing', 'opening'];
export const MOVEMENT_TOPICS: readonly MovementTopic[] = ['insider', 'team', 'treasury'];
export const ALL_TOPICS: readonly Topic[] = [...TOPICS, ...MOVEMENT_TOPICS];
export const isMovementTopic = (t: string): t is MovementTopic => (MOVEMENT_TOPICS as readonly string[]).includes(t);
/** Item kinds the feed can show that are about something that already happened. */
export const isMovementKind = isMovementTopic;
export const TOPIC_LABEL: Record<Topic, { title: string; detail: string }> = {
  claimable: { title: 'An order of mine can be claimed', detail: 'A cross you ordered in has cleared, or did not print and your escrow can be refunded.' },
  closing: { title: 'A cross I ordered in or follow is closing', detail: 'Ten minutes before the order window ends, while you can still cancel.' },
  opening: { title: 'A cross or market I follow is opening', detail: 'Ten minutes before orders open or a market session starts.' },
  insider: {
    title: 'An insider of a token I follow moves it out',
    detail: 'A wallet the chain ties to the issuer (the mint authority, a cross creator, an insider a cross or treasury declared) or the issuer listed as team holds less of the token than before.',
  },
  team: {
    title: 'A declared team wallet moves its tokens out',
    detail: 'Only wallets the issuer listed as team in a signed declaration. Already included in the insider alert.',
  },
  treasury: {
    title: 'A treasury I follow pays out',
    detail: 'Value leaves an ownership-coin treasury: a spend, an executed proposal, a revenue tranche, a grant release or a sweep. Holders redeeming their own coins are not alerts.',
  },
};
/** Why a movement topic is unavailable on a deployment, when the server says so. */
export const MOVEMENT_WHY_OFF: Record<MovementTopic, string> = {
  insider: 'This deployment has no Solana RPC to read wallet balances with.',
  team: 'This deployment has no Solana RPC to read wallet balances with.',
  treasury: 'This deployment has not recorded treasury movements yet.',
};

export type Channel = 'push' | 'email' | 'telegram';

export type AlertConfig = {
  push: { enabled: false } | { enabled: true; publicKey: string };
  email: { enabled: boolean };
  telegram: { enabled: false } | { enabled: true; bot: string };
  leadSeconds: number;
  topics: Topic[];
  /** Per topic, whether this deployment can deliver it. Absent on a server that predates the movement topics. */
  available?: Record<string, boolean>;
  /** Share of a token's supply an insider has to move out before an alert, in percent. */
  movementThresholdPercent?: number;
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
    // Kept in the order the page shows them, once each, whatever order or repeats the storage holds.
    const topics = Array.isArray(v.topics) ? ALL_TOPICS.filter((t) => (v.topics as unknown[]).includes(t)) : [];
    return { push: isSub(v.push) ? v.push : null, telegram: isSub(v.telegram) ? v.telegram : null, topics: topics.length ? topics : [...DEFAULT_TOPICS] };
  } catch {
    return empty;
  }
}

// ---------------------------------------------------------------- followed crosses, markets, tokens and treasuries

export type Watch = { crosses: string[]; markets: string[]; tokens: string[]; treasuries: string[] };
export const MAX_WATCH = 50;
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export const isAddress = (a: string): boolean => B58.test(a);
const emptyWatch = (): Watch => ({ crosses: [], markets: [], tokens: [], treasuries: [] });

export function parseWatch(raw: string | null | undefined): Watch {
  if (!raw) return emptyWatch();
  try {
    const v = JSON.parse(raw) as Partial<Watch>;
    const clean = (a: unknown) => (Array.isArray(a) ? [...new Set(a.filter((x): x is string => typeof x === 'string' && B58.test(x)))].slice(0, MAX_WATCH) : []);
    return { crosses: clean(v.crosses), markets: clean(v.markets), tokens: clean(v.tokens), treasuries: clean(v.treasuries) };
  } catch {
    return emptyWatch();
  }
}

export type WatchKind = keyof Watch;
export const isWatching = (w: Watch, kind: WatchKind, address: string): boolean => w[kind].includes(address);
const watchedCount = (w: Watch): number => w.crosses.length + w.markets.length + w.tokens.length + w.treasuries.length;

/** Adds or removes one address. Refuses (returns the same list) past MAX_WATCH in total, so the server's limit is never exceeded. Unfollowing is always allowed. */
export function toggleWatch(w: Watch, kind: WatchKind, address: string): Watch {
  if (!B58.test(address)) return w;
  if (isWatching(w, kind, address)) return { ...w, [kind]: w[kind].filter((a) => a !== address) };
  if (watchedCount(w) >= MAX_WATCH) return w;
  return { ...w, [kind]: [...w[kind], address] };
}

/** Everything followed, in the one list the server takes (an address followed twice is sent once). */
export const allWatched = (w: Watch): string[] => [...new Set([...w.crosses, ...w.markets, ...w.tokens, ...w.treasuries])];

/** Flips one topic, keeping the order the page shows. The last topic cannot be turned off: a subscription with none would fall back to the defaults. */
export function toggleTopic(topics: readonly Topic[], topic: Topic): Topic[] {
  const on = topics.includes(topic);
  if (on && topics.length === 1) return [...topics];
  return on ? topics.filter((t) => t !== topic) : ALL_TOPICS.filter((t) => t === topic || topics.includes(t));
}

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

// What an address is to alerts: a token, a treasury, a cross, a market, or nothing (row F5).
export type SubjectKind = 'cross' | 'treasury' | 'market' | 'token' | 'unknown' | 'none';
export type SubjectToken = { mint: string; isToken: boolean | null; insiders: { wallet: string; topic: 'insider' | 'team'; basis: string }[] | null; note?: string };
export type Subject = {
  address: string;
  kind: SubjectKind;
  tokens: SubjectToken[];
  treasuries: string[];
  available: Record<string, boolean>;
  movementThresholdPercent: number;
  note: string;
};
/** What an address is to alerts and which wallets following it would cover. */
export const getSubject = (address: string) => call<Subject>(`/v1/alerts/subject?address=${encodeURIComponent(address)}`);

const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;
/** What following an address would mean, in words, from the server's answer, and which list a follow goes in. */
export function subjectSummary(s: Subject): { follow: 'tokens' | 'treasuries' | null; text: string } {
  const token = s.tokens.find((t) => t.isToken === true) ?? null;
  if (s.kind === 'market') return { follow: null, text: 'This is a market calendar. Follow it from the live board to be reminded before a session opens.' };
  if (s.kind === 'treasury') return { follow: 'treasuries', text: `This is a treasury${token ? ` of token ${short(token.mint)}` : ''}. Following it covers its payouts${token ? ' and the insiders of that token' : ''}.` };
  if (s.kind === 'cross') return token ? { follow: 'tokens', text: `This is a cross selling token ${short(token.mint)}. Following the token covers its insiders${s.treasuries.length > 0 ? ' and its treasury' : ''}.` } : { follow: null, text: 'This is a cross, but its token could not be read just now.' };
  if (s.kind === 'token') return { follow: 'tokens', text: `This is a token mint${s.treasuries.length > 0 ? ' with a treasury' : ''}.` };
  if (s.kind === 'unknown') return { follow: null, text: 'This deployment cannot read the chain for insider wallets, so nothing about this address can be checked.' };
  return { follow: null, text: 'Nothing is known about this address: it is not a cross, a treasury, a market or a token mint on this cluster.' };
}

/** `5 min ago`, `3 h ago`, from unix seconds: how long ago something that already happened was seen. */
export function ageText(at: number, now: number): string {
  const d = Math.max(0, now - at);
  if (d < 90) return 'just now';
  if (d < 3600) return `${Math.round(d / 60)} min ago`;
  if (d < 86_400) return `${Math.round(d / 3600)} h ago`;
  return `${Math.round(d / 86_400)} days ago`;
}
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
