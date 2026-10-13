// Alerts for holders (ROADMAP: M7, Z6, T2; ADR-0400). The rules, free of I/O: which events a subscription is owed, what each one
// says, and how a subscription is validated. Nothing here sends anything or reads a database, so every rule is unit-tested.
//
// An event is derived from what the indexer already records, never stored on its own:
//   closing    a cross the wallet has an order in (or follows) closes in at most LEAD_SECONDS
//   opening    a followed cross opens in at most LEAD_SECONDS, or a followed market session starts in at most LEAD_SECONDS
//   claimable  a cross the wallet has an unpaid order in has cleared (pay out) or did not print (refund)
// The key of an event is stable, so a delivery is recorded once and never repeated, whatever the number of polls.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const TOPICS = ['claimable', 'closing', 'opening'] as const;
export type Topic = (typeof TOPICS)[number];
export const CHANNELS = ['push', 'email', 'telegram'] as const;
export type Channel = (typeof CHANNELS)[number];

/** A reminder is sent this long before a window opens or closes; the same lead the in-browser reminders use. */
export const LEAD_SECONDS = 600;
/** The in-app feed looks this far ahead. */
export const FEED_HORIZON_SECONDS = 86_400;
export const MAX_WATCH = 50;

export type CrossFact = { address: string; state: string; openTs: number; closeTs: number };
export type OrderFact = { owner: string; cross: string; status: string };
export type CalendarFact = { address: string; sessions: { startTs: number; endTs: number }[] };

export type Facts = {
  /** Every cross the subscription is about: those the wallet has orders in and those it follows. */
  crosses: ReadonlyMap<string, CrossFact>;
  /** The wallet's orders that are not cancelled and not paid out. */
  orders: readonly OrderFact[];
  calendars: readonly CalendarFact[];
};

export type Interest = { wallet: string | null; topics: readonly Topic[]; watch: readonly string[] };

export type AlertItem = {
  /** Stable per event; a delivery is recorded under it once. */
  key: string;
  kind: Topic;
  /** Unix seconds the event is about: the window that opens or closes, or 0 for a payout that is due now. */
  at: number;
  title: string;
  body: string;
  /** Site-relative link. */
  href: string;
};

export const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;

const utcClock = (ts: number) => new Date(ts * 1000).toISOString().slice(11, 16);
const minutes = (seconds: number) => Math.max(1, Math.ceil(seconds / 60));

/** The events a subscription is owed at `now`, within `horizon` seconds ahead (LEAD_SECONDS for pushes, longer for the in-app feed). */
export function itemsFor(interest: Interest, facts: Facts, now: number, horizon: number = LEAD_SECONDS): AlertItem[] {
  const out: AlertItem[] = [];
  const has = (t: Topic) => interest.topics.includes(t);
  const watched = new Set(interest.watch);
  const mine = new Set(facts.orders.filter((o) => interest.wallet !== null && o.owner === interest.wallet).map((o) => o.cross));

  for (const c of facts.crosses.values()) {
    const follows = watched.has(c.address);
    const inIt = mine.has(c.address);
    if (c.state === 'Live') {
      if (has('closing') && (inIt || follows) && c.closeTs > now && c.closeTs - now <= horizon && now >= c.openTs) {
        out.push({
          key: `closing:${c.address}`,
          kind: 'closing',
          at: c.closeTs,
          title: `Cross ${short(c.address)} closes in ${minutes(c.closeTs - now)} min`,
          body: inIt ? `Your order is in. Orders stop at ${utcClock(c.closeTs)} UTC; you can cancel until then.` : `Orders stop at ${utcClock(c.closeTs)} UTC.`,
          href: `/crosses/${c.address}`,
        });
      }
      if (has('opening') && follows && c.openTs > now && c.openTs - now <= horizon) {
        out.push({
          key: `opening:${c.address}`,
          kind: 'opening',
          at: c.openTs,
          title: `Cross ${short(c.address)} opens in ${minutes(c.openTs - now)} min`,
          body: `It takes orders from ${utcClock(c.openTs)} to ${utcClock(c.closeTs)} UTC.`,
          href: `/crosses/${c.address}`,
        });
      }
    }
  }

  if (has('claimable')) {
    for (const o of facts.orders) {
      if (interest.wallet === null || o.owner !== interest.wallet) continue;
      const c = facts.crosses.get(o.cross);
      if (!c || (c.state !== 'Cleared' && c.state !== 'NoPrint')) continue;
      if (out.some((i) => i.key === `claimable:${c.address}`)) continue;
      out.push({
        key: `claimable:${c.address}`,
        kind: 'claimable',
        at: 0,
        title: c.state === 'NoPrint' ? `Cross ${short(c.address)} did not print: your escrow is ready to refund` : `Cross ${short(c.address)} has cleared: your order is ready to claim`,
        body: c.state === 'NoPrint' ? 'Nothing traded, so the full escrow comes back. Claiming costs only the network fee.' : 'Claiming pays out your fill and returns what the clearing price left over.',
        href: '/orders',
      });
    }
  }

  if (has('opening')) {
    for (const cal of facts.calendars) {
      if (!watched.has(cal.address)) continue;
      for (const s of cal.sessions) {
        if (s.startTs > now && s.startTs - now <= horizon) {
          out.push({
            key: `session:${cal.address}:${s.startTs}`,
            kind: 'opening',
            at: s.startTs,
            title: `Market ${short(cal.address)} opens in ${minutes(s.startTs - now)} min`,
            body: `The session runs ${utcClock(s.startTs)} to ${utcClock(s.endTs)} UTC.`,
            href: '/live',
          });
        }
      }
    }
  }
  return out.sort((a, b) => (a.at === 0 ? -1 : b.at === 0 ? 1 : a.at - b.at) || (a.key < b.key ? -1 : 1));
}

// ------------------------------------------------------------------------------------------------ validation

export class AlertInputError extends Error {}

const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export const isAddressLike = (v: unknown): v is string => typeof v === 'string' && B58.test(v);

export function parseTopics(v: unknown): Topic[] {
  if (v === undefined) return ['claimable', 'closing'];
  if (!Array.isArray(v) || v.length === 0 || v.length > TOPICS.length) throw new AlertInputError(`topics must list one or more of ${TOPICS.join(', ')}`);
  const out: Topic[] = [];
  for (const t of v) {
    if (!(TOPICS as readonly unknown[]).includes(t)) throw new AlertInputError(`unknown topic ${JSON.stringify(t)}; use ${TOPICS.join(', ')}`);
    if (!out.includes(t as Topic)) out.push(t as Topic);
  }
  return out;
}

export function parseWatch(v: unknown): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > MAX_WATCH) throw new AlertInputError(`watch must be a list of at most ${MAX_WATCH} cross or market addresses`);
  const out: string[] = [];
  for (const a of v) {
    if (!isAddressLike(a)) throw new AlertInputError('watch must contain only base58 Solana addresses');
    if (!out.includes(a)) out.push(a);
  }
  return out;
}

export function parseWallet(v: unknown): string | null {
  if (v === undefined || v === null || v === '') return null;
  if (!isAddressLike(v)) throw new AlertInputError('wallet must be a base58 Solana address');
  return v;
}

/** Push services whose endpoints we are willing to POST to. The endpoint comes from the visitor, so an arbitrary one would make this server fetch any URL. */
const PUSH_HOSTS: readonly (string | RegExp)[] = [
  'fcm.googleapis.com',
  'updates.push.services.mozilla.com',
  /^updates-autopush(\.stage)?\.(prod|dev)\.mozaws\.net$/,
  /\.push\.services\.mozilla\.com$/,
  /(^|\.)push\.apple\.com$/,
  /\.notify\.windows\.com$/,
];

export function pushEndpointAllowed(endpoint: unknown): endpoint is string {
  if (typeof endpoint !== 'string' || endpoint.length > 1024) return false;
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443')) return false;
  return PUSH_HOSTS.some((h) => (typeof h === 'string' ? u.hostname === h : h.test(u.hostname)));
}

const B64URL = /^[A-Za-z0-9_-]{16,256}$/;
export function parsePushSubscription(v: unknown): { endpoint: string; p256dh: string; auth: string } {
  const o = v as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } } | null;
  if (!o || typeof o !== 'object') throw new AlertInputError('subscription must be the object a browser returns from pushManager.subscribe()');
  if (!pushEndpointAllowed(o.endpoint)) throw new AlertInputError('subscription.endpoint is not a known browser push service');
  const p256dh = o.keys?.p256dh;
  const auth = o.keys?.auth;
  if (typeof p256dh !== 'string' || !B64URL.test(p256dh) || typeof auth !== 'string' || !B64URL.test(auth)) throw new AlertInputError('subscription.keys must carry p256dh and auth');
  return { endpoint: o.endpoint, p256dh, auth };
}

const EMAIL = /^[^\s@<>()[\]\\,;:"]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
export function parseEmail(v: unknown): string {
  if (typeof v !== 'string') throw new AlertInputError('email must be a string');
  const e = v.trim().toLowerCase();
  if (e.length > 254 || !EMAIL.test(e) || e.split('@')[0]!.length > 64) throw new AlertInputError('email does not look like an address');
  return e;
}

// ------------------------------------------------------------------------------------------------ tokens

export const newId = () => randomBytes(12).toString('hex');
export const newToken = () => randomBytes(24).toString('base64url');
/** The token an email carries for a subscription: derived from the id with a server secret, so every mail can repeat it without the server keeping it. */
export const mailToken = (secret: string, id: string) => createHmac('sha256', secret).update(`alert-mail:${id}`).digest('base64url');
export const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');
export function tokenMatches(token: unknown, hash: string): boolean {
  if (typeof token !== 'string' || token.length < 16 || token.length > 128) return false;
  const a = Buffer.from(hashToken(token), 'hex');
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}
