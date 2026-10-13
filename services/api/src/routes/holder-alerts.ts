// Alerts (ROADMAP M7, Z6, T2; ADR-0400): browser push, email and Telegram reminders, and an in-app feed.
//
//   GET  /v1/alerts/config             which channels this deployment can really deliver on (a channel is absent, not faked, when its keys are not set)
//   GET  /v1/alerts/feed               what needs attention now for a wallet and the crosses and markets it follows (no subscription needed)
//   POST /v1/alerts/push/subscribe     a browser's push subscription; answers { id, token } for managing it
//   POST /v1/alerts/email/subscribe    an address; a confirmation mail is sent and nothing else until it is confirmed (double opt-in)
//   POST /v1/alerts/email/confirm      { id, token } from the link in that mail
//   POST /v1/alerts/telegram/start     a link to the bot and a one-time code; the bot confirms when the code is sent to it
//   POST /v1/alerts/status             { id, token } the subscription as stored
//   POST /v1/alerts/update             { id, token, wallet, topics, watch }
//   POST /v1/alerts/unsubscribe        { id, token } deletes the subscription and its delivery record
//
// A subscription watches a public wallet address (optional) and a list of crosses and market calendars. The delivery loop runs in
// this process every 30 seconds, derives due events from the indexer's tables, records each under a stable key before sending, and
// so sends each at most once. It is off unless a channel is configured.
import type { FastifyInstance, FastifyReply } from 'fastify';
import { type AlertConfig, type Mail, type Sent, alertMail, confirmationMail, loadAlertConfig, mailSender, pushSender, telegramClient, telegramText } from './holder-alerts-channels.js';
import {
  AlertInputError,
  type AlertItem,
  FEED_HORIZON_SECONDS,
  type Facts,
  LEAD_SECONDS,
  TOPICS,
  hashToken,
  isAddressLike,
  itemsFor,
  mailToken,
  newId,
  newToken,
  parsePushSubscription,
  parseEmail,
  parseTopics,
  parseWallet,
  parseWatch,
  tokenMatches,
} from './holder-alerts-core.js';
import { type AlertStore, type Db, type Subscription, alertStore } from './holder-alerts-store.js';
import { RequestError } from '../tx.js';

const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));
const send = (reply: FastifyReply, v: unknown, status = 200) => reply.code(status).type('application/json').send(json(v));

export type HolderAlertDeps = {
  db: Db;
  /** Unix seconds; defaults to the wall clock. Tests inject one. */
  clock?: () => number;
  /** Channel settings; default to the environment. */
  config?: AlertConfig;
  /** Senders, replaceable so a test can observe what would be delivered. They default to the real ones built from `config`. */
  senders?: {
    push?: (sub: { endpoint: string; keys: { p256dh: string; auth: string } }, item: AlertItem) => Promise<Sent>;
    mail?: (m: Mail) => Promise<Sent>;
    telegram?: Pick<ReturnType<typeof telegramClient>, 'send' | 'updates' | 'username'>;
  };
  /** Start the delivery loop (default true when any channel is configured). Tests call `tick` themselves. */
  run?: boolean;
  /** How often the loop wakes, in ms. */
  intervalMs?: number;
};

export type HolderAlerts = { store: AlertStore; tick: (now?: number) => Promise<{ sent: number; failed: number }>; pollTelegram: () => Promise<number>; stop: () => void };

const MAX_PER_WALLET = 10;
const CONFIRM_MAIL_GAP = 600;
const UNCONFIRMED_TTL = 86_400;
const TELEGRAM_CODE_TTL = 900;

export function registerHolderAlerts(app: FastifyInstance, deps: HolderAlertDeps): HolderAlerts {
  const clock = deps.clock ?? (() => Math.floor(Date.now() / 1000));
  const cfg = deps.config ?? loadAlertConfig();
  const store = alertStore(deps.db);
  const sendPush = deps.senders?.push ?? (cfg.push ? pushSender(cfg.push) : null);
  const sendMail = deps.senders?.mail ?? (cfg.email && cfg.webUrl ? mailSender(cfg.email) : null);
  const telegram = deps.senders?.telegram ?? (cfg.telegram ? telegramClient(cfg.telegram) : null);
  const web = cfg.webUrl;
  const manageUrl = (kind: 'confirm' | 'unsubscribe', id: string, token: string) => `${web}/alerts/${kind}?id=${id}&token=${token}`;

  const body = (v: unknown): Record<string, unknown> => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new RequestError(400, 'request body must be a JSON object');
    return v as Record<string, unknown>;
  };
  const wrap = <T>(f: () => T): T => {
    try {
      return f();
    } catch (e) {
      if (e instanceof AlertInputError) throw new RequestError(400, e.message);
      throw e;
    }
  };
  const unavailable = (reply: FastifyReply, what: string, how: string) => send(reply, { error: `${what} are not configured on this deployment`, how }, 503);

  /** The subscription an id and management token name, or a 404 that does not say which of the two was wrong. */
  async function owned(b: Record<string, unknown>): Promise<Subscription> {
    const sub = typeof b.id === 'string' && /^[0-9a-f]{24}$/.test(b.id) ? await store.get(b.id) : null;
    if (!sub || !tokenMatches(b.token, sub.tokenHash)) throw new RequestError(404, 'no such subscription, or the token does not match');
    return sub;
  }

  // -------------------------------------------------------------- reads

  app.get('/v1/alerts/config', async (_req, reply) =>
    send(reply, {
      push: cfg.push && sendPush ? { enabled: true, publicKey: cfg.push.publicKey } : { enabled: false },
      email: sendMail ? { enabled: true } : { enabled: false },
      telegram: telegram ? { enabled: true, bot: telegram.username } : { enabled: false },
      leadSeconds: LEAD_SECONDS,
      topics: TOPICS,
      note: 'A channel that is not enabled has no keys on this deployment; nothing is sent through it.',
    }),
  );

  async function factsFor(wallets: readonly string[], watch: readonly string[]): Promise<Facts> {
    const orders = await store.openOrders(wallets);
    const addrs = [...new Set([...orders.map((o) => o.cross), ...watch])];
    const [crosses, calendars] = await Promise.all([store.crosses(addrs), store.calendars(watch)]);
    return { crosses: new Map(crosses.map((c) => [c.address, c])), orders, calendars };
  }

  app.get('/v1/alerts/feed', async (req, reply) => {
    const q = req.query as { wallet?: string; watch?: string };
    const wallet = wrap(() => parseWallet(q.wallet));
    const watch = wrap(() => parseWatch(q.watch ? q.watch.split(',').filter(Boolean) : []));
    if (!wallet && watch.length === 0) throw new RequestError(400, 'give a wallet, a list of watched crosses or markets (watch=a,b), or both');
    const now = clock();
    const facts = await factsFor(wallet ? [wallet] : [], watch);
    const items = itemsFor({ wallet, topics: TOPICS, watch }, facts, now, FEED_HORIZON_SECONDS);
    return send(reply, { asOf: now, horizonSeconds: FEED_HORIZON_SECONDS, items });
  });

  // -------------------------------------------------------------- subscribe

  app.post('/v1/alerts/push/subscribe', async (req, reply) => {
    if (!cfg.push || !sendPush) return unavailable(reply, 'Browser push alerts', 'The operator sets VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT (docs/CONFIGURATION.md).');
    const b = body(req.body);
    const s = wrap(() => parsePushSubscription(b.subscription));
    const wallet = wrap(() => parseWallet(b.wallet));
    const topics = wrap(() => parseTopics(b.topics));
    const watch = wrap(() => parseWatch(b.watch));
    const existing = await store.byDestination('push', s.endpoint);
    if (wallet && (await store.countForWallet(wallet)) >= MAX_PER_WALLET && existing?.wallet !== wallet) throw new RequestError(409, `a wallet can have at most ${MAX_PER_WALLET} subscriptions`);
    const token = newToken();
    const next = { id: existing?.id ?? newId(), channel: 'push' as const, destination: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth }, wallet, topics, watch, confirmed: true, tokenHash: hashToken(token) };
    if (existing) await store.replace(existing, next);
    else await store.create(next, clock());
    return send(reply, { id: next.id, token, channel: 'push', topics, watch, wallet });
  });

  app.post('/v1/alerts/email/subscribe', async (req, reply) => {
    if (!sendMail || !web) return unavailable(reply, 'Email alerts', 'The operator sets SMTP_URL, MAIL_FROM and WEB_URL (docs/CONFIGURATION.md).');
    const b = body(req.body);
    const email = wrap(() => parseEmail(b.email));
    const wallet = wrap(() => parseWallet(b.wallet));
    const topics = wrap(() => parseTopics(b.topics));
    const watch = wrap(() => parseWatch(b.watch));
    const now = clock();
    const existing = await store.byDestination('email', email);
    // The answer never says whether the address was already known, so this route cannot be used to find out who has subscribed.
    const answer = { status: 'check-your-email', message: 'If this address can receive mail, a confirmation link is on its way. Nothing is sent to it until the link is opened.' };
    if (existing?.confirmed) return send(reply, answer, 202);
    if (existing && existing.lastConfirmMailAt !== null && now - existing.lastConfirmMailAt < CONFIRM_MAIL_GAP) return send(reply, answer, 202);
    if (wallet && !existing && (await store.countForWallet(wallet)) >= MAX_PER_WALLET) throw new RequestError(409, `a wallet can have at most ${MAX_PER_WALLET} subscriptions`);
    const id = existing?.id ?? newId();
    const token = mailToken(cfg.secret, id);
    const next = { id, channel: 'email' as const, destination: email, keys: null, wallet, topics, watch, confirmed: false, tokenHash: hashToken(token), lastConfirmMailAt: now };
    if (existing) await store.replace(existing, next);
    else await store.create(next, now);
    const out = await sendMail(confirmationMail(email, manageUrl('confirm', next.id, token), manageUrl('unsubscribe', next.id, token)));
    if (out !== 'ok') {
      await store.remove(next.id);
      return send(reply, { error: 'the confirmation mail could not be sent; try again in a few minutes' }, 503);
    }
    return send(reply, answer, 202);
  });

  app.post('/v1/alerts/email/confirm', async (req, reply) => {
    const sub = await owned(body(req.body));
    if (sub.channel !== 'email') throw new RequestError(404, 'no such subscription, or the token does not match');
    await store.confirm(sub.id);
    return send(reply, { confirmed: true, channel: 'email', topics: sub.topics, watch: sub.watch, wallet: sub.wallet });
  });

  app.post('/v1/alerts/telegram/start', async (req, reply) => {
    if (!telegram) return unavailable(reply, 'Telegram alerts', 'The operator creates a bot with @BotFather and sets TELEGRAM_BOT_TOKEN and TELEGRAM_BOT_USERNAME (docs/CONFIGURATION.md).');
    const b = body(req.body);
    const wallet = wrap(() => parseWallet(b.wallet));
    const topics = wrap(() => parseTopics(b.topics));
    const watch = wrap(() => parseWatch(b.watch));
    const now = clock();
    const token = newToken();
    const id = newId();
    const code = `ob${newId().slice(0, 10)}`;
    await store.create({ id, channel: 'telegram', destination: `pending:${id}`, keys: null, wallet, topics, watch, confirmed: false, tokenHash: hashToken(token) }, now);
    await store.newTelegramCode(id, code, now + TELEGRAM_CODE_TTL);
    return send(reply, { id, token, code, link: `https://t.me/${telegram.username}?start=${code}`, expiresIn: TELEGRAM_CODE_TTL });
  });

  // -------------------------------------------------------------- manage

  app.post('/v1/alerts/status', async (req, reply) => {
    const s = await owned(body(req.body));
    return send(reply, { id: s.id, channel: s.channel, confirmed: s.confirmed, wallet: s.wallet, topics: s.topics, watch: s.watch });
  });

  app.post('/v1/alerts/update', async (req, reply) => {
    const b = body(req.body);
    const s = await owned(b);
    const wallet = b.wallet === undefined ? s.wallet : wrap(() => parseWallet(b.wallet));
    const topics = b.topics === undefined ? s.topics : wrap(() => parseTopics(b.topics));
    const watch = b.watch === undefined ? s.watch : wrap(() => parseWatch(b.watch));
    await store.setInterest(s.id, wallet, topics, watch);
    return send(reply, { id: s.id, channel: s.channel, confirmed: s.confirmed, wallet, topics, watch });
  });

  app.post('/v1/alerts/unsubscribe', async (req, reply) => {
    const s = await owned(body(req.body));
    await store.remove(s.id);
    return send(reply, { removed: true });
  });

  // -------------------------------------------------------------- delivery

  const strikes = new Map<string, { n: number; until: number }>();

  async function deliver(sub: Subscription, item: AlertItem): Promise<Sent> {
    if (sub.channel === 'push') return sendPush && sub.keys ? sendPush({ endpoint: sub.destination, keys: sub.keys }, item) : 'retry';
    if (sub.channel === 'email') return sendMail && web ? sendMail(alertMail(sub.destination, item, web, manageUrl('unsubscribe', sub.id, mailToken(cfg.secret, sub.id)))) : 'retry';
    return telegram ? telegram.send(sub.destination, telegramText(item, web)) : 'retry';
  }

  async function tick(now = clock()): Promise<{ sent: number; failed: number }> {
    await store.pruneUnconfirmed(now - UNCONFIRMED_TTL);
    await store.pruneDeliveries(now - 2 * 86_400);
    const subs = await store.listConfirmed();
    let sent = 0;
    let failed = 0;
    if (subs.length === 0) return { sent, failed };
    const facts = await factsFor([...new Set(subs.map((s) => s.wallet).filter((w): w is string => w !== null))], [...new Set(subs.flatMap((s) => s.watch))]);
    for (const sub of subs) {
      const hold = strikes.get(sub.id);
      if (hold && hold.until > now) continue;
      const mine: Facts = { ...facts, orders: facts.orders.filter((o) => o.owner === sub.wallet) };
      for (const item of itemsFor({ wallet: sub.wallet, topics: sub.topics, watch: sub.watch }, mine, now)) {
        if (!(await store.claimDelivery(sub.id, item.key, now))) continue;
        const out = await deliver(sub, item);
        if (out === 'ok') {
          await store.finishDelivery(sub.id, item.key, 'sent');
          strikes.delete(sub.id);
          sent += 1;
        } else if (out === 'gone') {
          await store.remove(sub.id);
          failed += 1;
          break;
        } else {
          // Not delivered and worth another try: forget the claim so the next pass sends it, and back off a failing destination.
          await store.finishDelivery(sub.id, item.key, 'failed');
          const n = (strikes.get(sub.id)?.n ?? 0) + 1;
          strikes.set(sub.id, { n, until: now + Math.min(600, 30 * 2 ** n) });
          failed += 1;
          break;
        }
      }
    }
    return { sent, failed };
  }

  /** Reads what people sent to the bot: `/start <code>` links a chat to its pending subscription, `/stop` removes it. */
  async function pollTelegram(): Promise<number> {
    if (!telegram) return 0;
    const now = clock();
    let next = await store.telegramCursor();
    const updates = await telegram.updates(next);
    let linked = 0;
    for (const u of updates) {
      next = Math.max(next, u.update_id + 1);
      const m = u.message;
      if (!m || m.chat.type !== 'private' || typeof m.text !== 'string') continue;
      const chat = String(m.chat.id);
      const start = /^\/start\s+(ob[0-9a-f]{10})\s*$/.exec(m.text);
      if (start) {
        const id = await store.takeTelegramCode(start[1]!, now);
        if (!id) {
          await telegram.send(chat, 'That link has expired or was already used. Start again from the Alerts page.');
          continue;
        }
        await store.removeByDestination('telegram', chat);
        await store.setDestination(id, chat);
        await telegram.send(chat, 'Linked. You will get Opening Bell alerts here. Send /stop to remove this chat.');
        linked += 1;
      } else if (/^\/stop\b/.test(m.text)) {
        await store.removeByDestination('telegram', chat);
        await telegram.send(chat, 'Removed. No more alerts will be sent to this chat.');
      }
    }
    if (next !== (await store.telegramCursor()) && updates.length > 0) await store.setTelegramCursor(next);
    return linked;
  }

  let timers: ReturnType<typeof setInterval>[] = [];
  const channelsOn = Boolean(sendPush || sendMail || telegram);
  if ((deps.run ?? channelsOn) && channelsOn) {
    const guard = (f: () => Promise<unknown>) => () => void f().catch((e: unknown) => console.error(JSON.stringify({ at: new Date().toISOString(), alerts: 'loop failed', error: String(e) })));
    timers.push(setInterval(guard(() => tick()), deps.intervalMs ?? 30_000).unref());
    if (telegram) timers.push(setInterval(guard(pollTelegram), 10_000).unref());
  }
  const stop = () => {
    for (const t of timers) clearInterval(t);
    timers = [];
  };
  app.addHook('onClose', async () => stop());

  return { store, tick, pollTelegram, stop };
}

export { isAddressLike };
