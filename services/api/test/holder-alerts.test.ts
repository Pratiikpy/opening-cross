// Alerts (M7, Z6, T2): the rules, the validation, and the routes and delivery loop against a real Postgres (PGlite) with the
// indexer's own tables. Senders are replaced by recorders, so what would have been delivered can be read; the real senders
// are exercised separately against real services (docs/evidence/W2C-Z6.md).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import type { PGlite } from '@electric-sql/pglite';
import { type AlertConfig, alertMail, confirmationMail, loadAlertConfig, mailSender, pushSender, telegramClient } from '../src/routes/holder-alerts-channels.js';
import { type AlertItem, type Facts, itemsFor, mailToken, parseEmail, parsePushSubscription, parseTopics, parseWatch, pushEndpointAllowed, tokenMatches, hashToken } from '../src/routes/holder-alerts-core.js';
import { registerHolderAlerts } from '../src/routes/holder-alerts.js';
import { RequestError } from '../src/tx.js';
import { addCross, addOrder, holderDb } from './helpers/holder-pg.js';

const NOW = 1_800_000_000;
const A = 'AaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaA'.slice(0, 44);
const WALLET = '7MjUeRtbGsXYXQWj8CeW1iKQSMki5xQvNZR8TnJixU1A';
const OTHER = 'Ao9ZJvc133Ui22aKTfSvoP5WdEVJxF25ns25uL1ipaFc';
const CROSS = 'ELVKGevyF2qarSYiZHAkRdAkfKruKSgKL7aS9XTrVBK8';
const CROSS2 = '3S7Vs2gbfXggcpTqWYBJo6AhcuzqgWmiQsdZcwDGFLkM';
const CAL = 'CxtZKYwS4AoqzLhRfjvBTf6NQgDzb2GQhS3u5iB9XLCN';

const facts = (over: Partial<Facts> = {}): Facts => ({ crosses: new Map(), orders: [], calendars: [], ...over });
const cross = (address: string, state: string, openTs: number, closeTs: number) => [address, { address, state, openTs, closeTs }] as const;

describe('itemsFor', () => {
  it('reminds a wallet with an order that its cross closes within the lead, once the cross is open', () => {
    const f = facts({ crosses: new Map([cross(CROSS, 'Live', NOW - 3000, NOW + 540)]), orders: [{ owner: WALLET, cross: CROSS, status: 'committed' }] });
    const [i, ...rest] = itemsFor({ wallet: WALLET, topics: ['closing'], watch: [] }, f, NOW);
    expect(rest).toEqual([]);
    expect(i).toMatchObject({ key: `closing:${CROSS}`, kind: 'closing', at: NOW + 540, href: `/crosses/${CROSS}` });
    expect(i!.title).toContain('closes in 9 min');
    expect(i!.body).toContain('Your order is in');
  });

  it('says nothing about a cross that closes later than the lead, has closed, or has not opened', () => {
    const interest = { wallet: WALLET, topics: ['closing' as const], watch: [] };
    const orders = [{ owner: WALLET, cross: CROSS, status: 'committed' }];
    expect(itemsFor(interest, facts({ crosses: new Map([cross(CROSS, 'Live', NOW - 3000, NOW + 601)]), orders }), NOW)).toEqual([]);
    expect(itemsFor(interest, facts({ crosses: new Map([cross(CROSS, 'Live', NOW - 3000, NOW)]), orders }), NOW)).toEqual([]);
    expect(itemsFor(interest, facts({ crosses: new Map([cross(CROSS, 'Live', NOW + 60, NOW + 300)]), orders }), NOW)).toEqual([]);
  });

  it('ignores another wallet’s orders and topics the subscriber did not ask for', () => {
    const f = facts({ crosses: new Map([cross(CROSS, 'Live', NOW - 3000, NOW + 300)]), orders: [{ owner: OTHER, cross: CROSS, status: 'committed' }] });
    expect(itemsFor({ wallet: WALLET, topics: ['closing'], watch: [] }, f, NOW)).toEqual([]);
    const mine = facts({ crosses: new Map([cross(CROSS, 'Live', NOW - 3000, NOW + 300)]), orders: [{ owner: WALLET, cross: CROSS, status: 'committed' }] });
    expect(itemsFor({ wallet: WALLET, topics: ['opening'], watch: [] }, mine, NOW)).toEqual([]);
  });

  it('follows a cross without an order: opening before it starts, closing while it runs', () => {
    const upcoming = facts({ crosses: new Map([cross(CROSS, 'Live', NOW + 120, NOW + 700)]) });
    expect(itemsFor({ wallet: null, topics: ['opening', 'closing'], watch: [CROSS] }, upcoming, NOW).map((i) => i.key)).toEqual([`opening:${CROSS}`]);
    const running = facts({ crosses: new Map([cross(CROSS, 'Live', NOW - 100, NOW + 400)]) });
    const [c] = itemsFor({ wallet: null, topics: ['opening', 'closing'], watch: [CROSS] }, running, NOW);
    expect(c).toMatchObject({ key: `closing:${CROSS}` });
    expect(c!.body).not.toContain('Your order');
  });

  it('tells a wallet with an unpaid order that a cleared cross can be claimed, and that a no-print cross refunds', () => {
    const f = facts({ crosses: new Map([cross(CROSS, 'Cleared', NOW - 900, NOW - 300), cross(CROSS2, 'NoPrint', NOW - 900, NOW - 300)]), orders: [{ owner: WALLET, cross: CROSS, status: 'revealed' }, { owner: WALLET, cross: CROSS2, status: 'committed' }] });
    const items = itemsFor({ wallet: WALLET, topics: ['claimable'], watch: [] }, f, NOW);
    expect(items.map((i) => i.key).sort()).toEqual([`claimable:${CROSS}`, `claimable:${CROSS2}`].sort());
    expect(items.find((i) => i.key === `claimable:${CROSS}`)!.title).toContain('ready to claim');
    expect(items.find((i) => i.key === `claimable:${CROSS2}`)!.title).toContain('did not print');
    expect(items.every((i) => i.href === '/orders')).toBe(true);
  });

  it('gives one claimable item per cross however many orders the wallet has in it', () => {
    const f = facts({ crosses: new Map([cross(CROSS, 'Cleared', 0, 1)]), orders: [{ owner: WALLET, cross: CROSS, status: 'revealed' }, { owner: WALLET, cross: CROSS, status: 'committed' }] });
    expect(itemsFor({ wallet: WALLET, topics: ['claimable'], watch: [] }, f, NOW)).toHaveLength(1);
  });

  it('announces a followed market session inside the lead and no other', () => {
    const f = facts({ calendars: [{ address: CAL, sessions: [{ startTs: NOW - 5000, endTs: NOW - 100 }, { startTs: NOW + 480, endTs: NOW + 9000 }, { startTs: NOW + 90_000, endTs: NOW + 99_000 }] }] });
    const items = itemsFor({ wallet: null, topics: ['opening'], watch: [CAL] }, f, NOW);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ key: `session:${CAL}:${NOW + 480}`, href: '/live' });
    expect(itemsFor({ wallet: null, topics: ['opening'], watch: [] }, f, NOW)).toEqual([]);
  });

  it('looks further ahead for the in-app feed', () => {
    const f = facts({ crosses: new Map([cross(CROSS, 'Live', NOW + 7200, NOW + 9000)]) });
    expect(itemsFor({ wallet: null, topics: ['opening'], watch: [CROSS] }, f, NOW)).toEqual([]);
    expect(itemsFor({ wallet: null, topics: ['opening'], watch: [CROSS] }, f, NOW, 86_400)).toHaveLength(1);
  });
});

describe('validation', () => {
  it('accepts only the browser push services', () => {
    for (const ok of ['https://fcm.googleapis.com/fcm/send/abc', 'https://updates.push.services.mozilla.com/wpush/v2/xyz', 'https://web.push.apple.com/Q123', 'https://wns2-par02p.notify.windows.com/w/?token=abc']) expect(pushEndpointAllowed(ok), ok).toBe(true);
    for (const bad of [
      'http://fcm.googleapis.com/fcm/send/abc',
      'https://169.254.169.254/latest/meta-data',
      'https://localhost/x',
      'https://127.0.0.1:8080/x',
      'https://fcm.googleapis.com.evil.example/x',
      'https://evil.example/fcm.googleapis.com',
      'https://user:pw@fcm.googleapis.com/x',
      'https://fcm.googleapis.com:8443/x',
      'https://notify.windows.com.evil.example/x',
      'ftp://fcm.googleapis.com/x',
      'not a url',
      '',
      42,
      null,
    ])
      expect(pushEndpointAllowed(bad), String(bad)).toBe(false);
  });

  it('reads a browser subscription and refuses a malformed one', () => {
    const keys = { p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM', auth: 'tBHItJI5svbpez7KI4CCXg' };
    expect(parsePushSubscription({ endpoint: 'https://fcm.googleapis.com/fcm/send/x', keys })).toMatchObject({ endpoint: 'https://fcm.googleapis.com/fcm/send/x', auth: keys.auth });
    expect(() => parsePushSubscription({ endpoint: 'https://fcm.googleapis.com/fcm/send/x' })).toThrow(/keys/);
    expect(() => parsePushSubscription({ endpoint: 'https://evil.example/x', keys })).toThrow(/known browser push service/);
    expect(() => parsePushSubscription(null)).toThrow();
  });

  it('normalises and bounds emails, topics and followed addresses', () => {
    expect(parseEmail('  Me@Example.COM ')).toBe('me@example.com');
    for (const bad of ['', 'nope', 'a@b', 'a b@c.de', 'a@@c.de', `${'x'.repeat(65)}@example.com`, 'a@c.de\nBcc: x@y.z', 5]) expect(() => parseEmail(bad), String(bad)).toThrow();
    expect(parseTopics(undefined)).toEqual(['claimable', 'closing']);
    expect(parseTopics(['opening', 'opening'])).toEqual(['opening']);
    expect(() => parseTopics([])).toThrow();
    expect(() => parseTopics(['spam'])).toThrow(/unknown topic/);
    expect(parseWatch([CROSS, CROSS])).toEqual([CROSS]);
    expect(() => parseWatch(['not an address'])).toThrow();
    expect(() => parseWatch(Array.from({ length: 51 }, () => CROSS))).toThrow(/at most 50/);
  });

  it('matches a management token only against its own hash', () => {
    const t = mailToken('secret', 'abc');
    expect(tokenMatches(t, hashToken(t))).toBe(true);
    expect(tokenMatches(t + 'x', hashToken(t))).toBe(false);
    expect(tokenMatches('short', hashToken('short'))).toBe(false);
    expect(tokenMatches(undefined, hashToken(t))).toBe(false);
    expect(mailToken('secret', 'abc')).toBe(t);
    expect(mailToken('other', 'abc')).not.toBe(t);
  });
});

describe('channel configuration', () => {
  it('turns a channel on only when all of its settings are present', () => {
    const none = loadAlertConfig({});
    expect(none.push).toBeNull();
    expect(none.email).toBeNull();
    expect(none.telegram).toBeNull();
    expect(loadAlertConfig({ VAPID_PUBLIC_KEY: 'p' }).push).toBeNull();
    expect(loadAlertConfig({ VAPID_PUBLIC_KEY: 'p', VAPID_PRIVATE_KEY: 'k', VAPID_SUBJECT: 'mailto:ops@example.com' }).push).toMatchObject({ subject: 'mailto:ops@example.com' });
    expect(loadAlertConfig({ SMTP_URL: 'smtp://x', MAIL_FROM: 'a@b.c' }).email).toMatchObject({ from: 'a@b.c' });
    expect(loadAlertConfig({ TELEGRAM_BOT_TOKEN: 't', TELEGRAM_BOT_USERNAME: '@OpeningBellBot' }).telegram).toMatchObject({ username: 'OpeningBellBot' });
    expect(loadAlertConfig({ WEB_URL: 'https://x.example/' }).webUrl).toBe('https://x.example');
  });

  it('classifies what a push service and a mail server answer', async () => {
    const cfg = { publicKey: 'p', privateKey: 'k', subject: 'mailto:a@b.c' };
    const item: AlertItem = { key: 'k', kind: 'closing', at: 1, title: 't', body: 'b', href: '/x' };
    const sub = { endpoint: 'https://fcm.googleapis.com/x', keys: { p256dh: 'a', auth: 'b' } };
    const reply = (code?: number) => async () => {
      if (code) throw Object.assign(new Error('x'), { statusCode: code });
      return { statusCode: 201 };
    };
    expect(await pushSender(cfg, reply())(sub, item)).toBe('ok');
    expect(await pushSender(cfg, reply(410))(sub, item)).toBe('gone');
    expect(await pushSender(cfg, reply(404))(sub, item)).toBe('gone');
    expect(await pushSender(cfg, reply(503))(sub, item)).toBe('retry');
    const mail = (e?: object) => ({ sendMail: async () => { if (e) throw Object.assign(new Error('m'), e); } });
    const m = { to: 'a@b.cd', subject: 's', text: 't' };
    expect(await mailSender({ url: 'x', from: 'f' }, mail())(m)).toBe('ok');
    expect(await mailSender({ url: 'x', from: 'f' }, mail({ responseCode: 550 }))(m)).toBe('gone');
    expect(await mailSender({ url: 'x', from: 'f' }, mail({ code: 'ECONNECTION' }))(m)).toBe('retry');
  });

  it('writes mails that carry the way out and escape what they quote', () => {
    const c = confirmationMail('a@b.cd', 'https://w.example/alerts/confirm?id=1&token=t', 'https://w.example/alerts/unsubscribe?id=1&token=t');
    expect(c.text).toContain('nothing is sent until you confirm');
    expect(c.headers?.['List-Unsubscribe']).toBe('<https://w.example/alerts/unsubscribe?id=1&token=t>');
    expect(c.html).toContain('&amp;token=t');
    const a = alertMail('a@b.cd', { key: 'k', kind: 'closing', at: 1, title: '<b>t</b>', body: 'b & c', href: '/crosses/x' }, 'https://w.example', 'https://w.example/u');
    expect(a.subject).toBe('<b>t</b>');
    expect(a.html).toContain('&lt;b&gt;t&lt;/b&gt;');
    expect(a.text).toContain('https://w.example/crosses/x');
  });

  it('classifies Telegram answers and parses its updates', async () => {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const answer = (r: unknown) => (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify(r), { status: 200 });
    }) as unknown as typeof fetch;
    const cfg = { token: 'T0KEN', username: 'Bot' };
    expect(await telegramClient(cfg, answer({ ok: true, result: {} })).send('5', 'hi')).toBe('ok');
    expect(calls[0]!.url).toBe('https://api.telegram.org/botT0KEN/sendMessage');
    expect(await telegramClient(cfg, answer({ ok: false, error_code: 403 })).send('5', 'hi')).toBe('gone');
    expect(await telegramClient(cfg, answer({ ok: false, error_code: 429 })).send('5', 'hi')).toBe('retry');
    expect(await telegramClient(cfg, answer({ ok: true, result: [{ update_id: 9 }] })).updates(0)).toEqual([{ update_id: 9 }]);
  });
});

describe('alert routes and delivery', () => {
  let db: PGlite;
  let now = NOW;
  const pushes: { to: string; item: AlertItem }[] = [];
  const mails: { to: string; subject: string; text: string }[] = [];
  const chats: { to: string; text: string }[] = [];
  let pushResult: 'ok' | 'gone' | 'retry' = 'ok';
  let updates: { update_id: number; message?: { chat: { id: number; type: string }; text?: string } }[] = [];

  const cfg: AlertConfig = {
    push: { publicKey: 'BPublicKeyForTests', privateKey: 'k', subject: 'mailto:ops@example.com' },
    email: { url: 'smtp://unused', from: 'Opening Bell <alerts@example.com>' },
    telegram: { token: 't', username: 'OpeningBellBot' },
    webUrl: 'https://app.example',
    secret: 'test-secret',
  };
  const senders = {
    push: async (s: { endpoint: string }, item: AlertItem) => {
      if (pushResult === 'ok') pushes.push({ to: s.endpoint, item });
      return pushResult;
    },
    mail: async (m: { to: string; subject: string; text: string }) => {
      mails.push(m);
      return 'ok' as const;
    },
    telegram: {
      username: 'OpeningBellBot',
      send: async (chat: string, text: string) => {
        chats.push({ to: chat, text });
        return 'ok' as const;
      },
      updates: async (offset: number) => updates.filter((u) => u.update_id >= offset),
    },
  };

  async function build(over: Partial<Parameters<typeof registerHolderAlerts>[1]> = {}) {
    const app = Fastify();
    app.setErrorHandler((err, _req, reply) => {
      if (err instanceof RequestError) return reply.code(err.status).send({ error: err.message });
      return reply.code(500).send({ error: String(err) });
    });
    const alerts = registerHolderAlerts(app, { db, clock: () => now, config: cfg, senders, run: false, ...over });
    await app.ready();
    return { app, alerts };
  }

  const PUSH_KEYS = { p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM', auth: 'tBHItJI5svbpez7KI4CCXg' };
  const sub = (n = 1) => ({ endpoint: `https://fcm.googleapis.com/fcm/send/device-${n}`, keys: PUSH_KEYS });

  beforeEach(async () => {
    db = await holderDb();
    now = NOW;
    pushes.length = mails.length = chats.length = 0;
    pushResult = 'ok';
    updates = [];
    await addCross(db, { address: CROSS, state: 'Live', open: NOW - 3000, close: NOW + 500 });
    await addOrder(db, { cross: CROSS, idx: 0, address: 'OrderAddr0000000000000000000000000000000001', owner: WALLET, status: 'committed' });
  });
  afterEach(async () => {
    await db.close();
  });

  it('reports exactly the channels that are configured', async () => {
    const { app } = await build();
    const on = (await app.inject('/v1/alerts/config')).json();
    expect(on).toMatchObject({ push: { enabled: true, publicKey: 'BPublicKeyForTests' }, email: { enabled: true }, telegram: { enabled: true, bot: 'OpeningBellBot' }, leadSeconds: 600 });
    const off = await build({ config: { push: null, email: null, telegram: null, webUrl: null, secret: 's' }, senders: {} });
    expect((await off.app.inject('/v1/alerts/config')).json()).toMatchObject({ push: { enabled: false }, email: { enabled: false }, telegram: { enabled: false } });
    for (const [url, payload] of [['/v1/alerts/push/subscribe', { subscription: sub() }], ['/v1/alerts/email/subscribe', { email: 'a@example.com' }], ['/v1/alerts/telegram/start', {}]] as const) {
      const r = await off.app.inject({ method: 'POST', url, payload });
      expect(r.statusCode, url).toBe(503);
      expect(r.json().error).toContain('not configured');
      expect(r.json().how).toContain('docs/CONFIGURATION.md');
    }
  });

  it('subscribes a browser, refuses a foreign endpoint, and delivers a closing reminder exactly once', async () => {
    const { app, alerts } = await build();
    const bad = await app.inject({ method: 'POST', url: '/v1/alerts/push/subscribe', payload: { subscription: { endpoint: 'https://169.254.169.254/x', keys: PUSH_KEYS } } });
    expect(bad.statusCode).toBe(400);
    const ok = await app.inject({ method: 'POST', url: '/v1/alerts/push/subscribe', payload: { subscription: sub(), wallet: WALLET, topics: ['closing'] } });
    expect(ok.statusCode).toBe(200);
    const { id, token } = ok.json();
    expect(id).toMatch(/^[0-9a-f]{24}$/);

    expect(await alerts.tick(now)).toEqual({ sent: 1, failed: 0 });
    expect(pushes).toHaveLength(1);
    expect(pushes[0]!.item.title).toContain('closes in');
    // The same event is never sent again, on this pass or the next ones.
    expect(await alerts.tick(now + 30)).toEqual({ sent: 0, failed: 0 });
    expect(await alerts.tick(now + 60)).toEqual({ sent: 0, failed: 0 });
    expect(pushes).toHaveLength(1);

    // Managing it needs the token.
    expect((await app.inject({ method: 'POST', url: '/v1/alerts/status', payload: { id, token: 'wrong-token-wrong-token' } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/v1/alerts/status', payload: { id } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/v1/alerts/status', payload: { id, token } })).json()).toMatchObject({ channel: 'push', confirmed: true, wallet: WALLET, topics: ['closing'] });
    const upd = await app.inject({ method: 'POST', url: '/v1/alerts/update', payload: { id, token, topics: ['closing', 'claimable'], watch: [CROSS2] } });
    expect(upd.json()).toMatchObject({ topics: ['closing', 'claimable'], watch: [CROSS2] });
    expect((await app.inject({ method: 'POST', url: '/v1/alerts/unsubscribe', payload: { id, token } })).json()).toEqual({ removed: true });
    expect((await app.inject({ method: 'POST', url: '/v1/alerts/status', payload: { id, token } })).statusCode).toBe(404);
    expect((await db.query('SELECT count(*)::int AS n FROM alert_deliveries')).rows[0]).toEqual({ n: 0 });
  });

  it('re-subscribing the same browser keeps one subscription and rotates its token', async () => {
    const { app } = await build();
    const a = (await app.inject({ method: 'POST', url: '/v1/alerts/push/subscribe', payload: { subscription: sub(), wallet: WALLET } })).json();
    const b = (await app.inject({ method: 'POST', url: '/v1/alerts/push/subscribe', payload: { subscription: sub(), wallet: WALLET } })).json();
    expect(b.id).toBe(a.id);
    expect(b.token).not.toBe(a.token);
    expect((await app.inject({ method: 'POST', url: '/v1/alerts/status', payload: { id: a.id, token: a.token } })).statusCode).toBe(404);
    expect((await db.query('SELECT count(*)::int AS n FROM alert_subscriptions')).rows[0]).toEqual({ n: 1 });
  });

  it('caps the subscriptions one wallet can hold', async () => {
    const { app } = await build();
    for (let i = 1; i <= 10; i++) expect((await app.inject({ method: 'POST', url: '/v1/alerts/push/subscribe', payload: { subscription: sub(i), wallet: WALLET } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/v1/alerts/push/subscribe', payload: { subscription: sub(11), wallet: WALLET } })).statusCode).toBe(409);
  });

  it('drops a subscription the push service says is gone, and retries one that merely failed', async () => {
    const { app, alerts } = await build();
    await app.inject({ method: 'POST', url: '/v1/alerts/push/subscribe', payload: { subscription: sub(), wallet: WALLET, topics: ['closing'] } });
    pushResult = 'retry';
    expect(await alerts.tick(now)).toEqual({ sent: 0, failed: 1 });
    // Backed off for a while, then tried again and delivered.
    expect(await alerts.tick(now + 5)).toEqual({ sent: 0, failed: 0 });
    pushResult = 'ok';
    expect(await alerts.tick(now + 120)).toEqual({ sent: 1, failed: 0 });
    // A new event for a browser that has gone away removes the subscription.
    await addCross(db, { address: CROSS2, state: 'Live', open: NOW - 3000, close: NOW + 500 });
    await addOrder(db, { cross: CROSS2, idx: 0, address: 'OrderAddr0000000000000000000000000000000002', owner: WALLET, status: 'committed' });
    pushResult = 'gone';
    expect(await alerts.tick(now + 130)).toEqual({ sent: 0, failed: 1 });
    expect((await db.query('SELECT count(*)::int AS n FROM alert_subscriptions')).rows[0]).toEqual({ n: 0 });
  });

  it('tells a wallet when its cross has cleared and when it did not print', async () => {
    const { app, alerts } = await build();
    await app.inject({ method: 'POST', url: '/v1/alerts/push/subscribe', payload: { subscription: sub(), wallet: WALLET, topics: ['claimable'] } });
    expect(await alerts.tick(now)).toEqual({ sent: 0, failed: 0 });
    await db.query(`UPDATE crosses SET state = 'Cleared' WHERE address = $1`, [CROSS]);
    expect(await alerts.tick(now + 30)).toEqual({ sent: 1, failed: 0 });
    expect(pushes.at(-1)!.item.title).toContain('ready to claim');
    await db.query(`UPDATE orders SET status = 'claimed' WHERE cross_address = $1`, [CROSS]);
    await db.query(`UPDATE crosses SET state = 'NoPrint' WHERE address = $1`, [CROSS]);
    expect(await alerts.tick(now + 60)).toEqual({ sent: 0, failed: 0 });
  });

  it('follows a market calendar and a cross with no wallet at all', async () => {
    const { app, alerts } = await build();
    await db.query(`INSERT INTO calendars (address, admin, calendar_id, timelock_secs, sessions, feeds, first_slot, read_slot) VALUES ($1, 'admin', 1, 604800, $2::jsonb, '[]'::jsonb, 1, 1)`, [CAL, JSON.stringify([{ startTs: String(NOW + 300), endTs: String(NOW + 9000) }])]);
    await app.inject({ method: 'POST', url: '/v1/alerts/push/subscribe', payload: { subscription: sub(), topics: ['opening', 'closing'], watch: [CAL, CROSS] } });
    expect(await alerts.tick(now)).toEqual({ sent: 2, failed: 0 });
    expect(pushes.map((p) => p.item.key).sort()).toEqual([`closing:${CROSS}`, `session:${CAL}:${NOW + 300}`].sort());
  });

  it('double opt-in for email: nothing is sent before the link, the answer is the same for a known address, and every mail can unsubscribe', async () => {
    const { app, alerts } = await build();
    const first = await app.inject({ method: 'POST', url: '/v1/alerts/email/subscribe', payload: { email: 'Holder@Example.com', wallet: WALLET, topics: ['closing'] } });
    expect(first.statusCode).toBe(202);
    expect(first.json()).not.toHaveProperty('id');
    expect(mails).toHaveLength(1);
    expect(mails[0]!.to).toBe('holder@example.com');
    const link = /https:\/\/app\.example\/alerts\/confirm\?id=([0-9a-f]{24})&token=([A-Za-z0-9_-]+)/.exec(mails[0]!.text)!;
    expect(link).not.toBeNull();

    // Unconfirmed: no alert goes out, and asking again inside the gap sends no second mail but answers the same.
    expect(await alerts.tick(now)).toEqual({ sent: 0, failed: 0 });
    const again = await app.inject({ method: 'POST', url: '/v1/alerts/email/subscribe', payload: { email: 'holder@example.com' } });
    expect(again.json()).toEqual(first.json());
    expect(mails).toHaveLength(1);

    expect((await app.inject({ method: 'POST', url: '/v1/alerts/email/confirm', payload: { id: link[1], token: 'x'.repeat(30) } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/v1/alerts/email/confirm', payload: { id: link[1], token: link[2] } })).json()).toMatchObject({ confirmed: true });

    // A confirmed address gets the same answer again and no new mail: the route cannot be used to learn who is subscribed.
    expect((await app.inject({ method: 'POST', url: '/v1/alerts/email/subscribe', payload: { email: 'holder@example.com' } })).json()).toEqual(first.json());
    expect(mails).toHaveLength(1);

    expect(await alerts.tick(now)).toEqual({ sent: 1, failed: 0 });
    const alert = mails[1]!;
    expect(alert.subject).toContain('closes in');
    const out = /alerts\/unsubscribe\?id=([0-9a-f]{24})&token=([A-Za-z0-9_-]+)/.exec(alert.text)!;
    expect(out[2]).toBe(link[2]);
    expect((await app.inject({ method: 'POST', url: '/v1/alerts/unsubscribe', payload: { id: out[1], token: out[2] } })).json()).toEqual({ removed: true });
    expect((await db.query('SELECT count(*)::int AS n FROM alert_subscriptions')).rows[0]).toEqual({ n: 0 });
  });

  it('rejects a junk address and forgets one nobody confirmed', async () => {
    const { app, alerts } = await build();
    expect((await app.inject({ method: 'POST', url: '/v1/alerts/email/subscribe', payload: { email: 'nope' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/v1/alerts/email/subscribe', payload: [] })).statusCode).toBe(400);
    await app.inject({ method: 'POST', url: '/v1/alerts/email/subscribe', payload: { email: 'late@example.com' } });
    expect((await db.query('SELECT count(*)::int AS n FROM alert_subscriptions')).rows[0]).toEqual({ n: 1 });
    await alerts.tick(now + 86_401);
    expect((await db.query('SELECT count(*)::int AS n FROM alert_subscriptions')).rows[0]).toEqual({ n: 0 });
  });

  it('links a Telegram chat only through the one-time code, and /stop removes it', async () => {
    const { app, alerts } = await build();
    const start = (await app.inject({ method: 'POST', url: '/v1/alerts/telegram/start', payload: { wallet: WALLET, topics: ['closing'] } })).json();
    expect(start.link).toBe(`https://t.me/OpeningBellBot?start=${start.code}`);
    expect(await alerts.tick(now)).toEqual({ sent: 0, failed: 0 });

    updates = [{ update_id: 1, message: { chat: { id: 555, type: 'private' }, text: '/start obdeadbeef00' } }];
    expect(await alerts.pollTelegram()).toBe(0);
    expect(chats.at(-1)!.text).toContain('expired');
    updates = [{ update_id: 2, message: { chat: { id: 555, type: 'private' }, text: `/start ${start.code}` } }, { update_id: 3, message: { chat: { id: -9, type: 'group' }, text: `/start ${start.code}` } }];
    expect(await alerts.pollTelegram()).toBe(1);
    // The same code cannot be used twice, and the cursor moved past what was read.
    expect(await alerts.pollTelegram()).toBe(0);
    expect(await alerts.tick(now)).toEqual({ sent: 1, failed: 0 });
    expect(chats.at(-1)).toMatchObject({ to: '555' });
    expect(chats.at(-1)!.text).toContain('closes in');
    updates = [{ update_id: 4, message: { chat: { id: 555, type: 'private' }, text: '/stop' } }];
    await alerts.pollTelegram();
    expect((await db.query('SELECT count(*)::int AS n FROM alert_subscriptions')).rows[0]).toEqual({ n: 0 });
  });

  it('serves the in-app feed for a wallet and followed crosses without any subscription', async () => {
    const { app } = await build();
    expect((await app.inject('/v1/alerts/feed')).statusCode).toBe(400);
    expect((await app.inject('/v1/alerts/feed?wallet=nope')).statusCode).toBe(400);
    const r = (await app.inject(`/v1/alerts/feed?wallet=${WALLET}`)).json();
    expect(r.items.map((i: AlertItem) => i.kind)).toEqual(['closing']);
    await db.query(`UPDATE crosses SET state = 'Cleared' WHERE address = $1`, [CROSS]);
    expect((await app.inject(`/v1/alerts/feed?wallet=${WALLET}`)).json().items[0]).toMatchObject({ kind: 'claimable', href: '/orders' });
    await addCross(db, { address: CROSS2, state: 'Live', open: NOW + 3600, close: NOW + 4200 });
    const f = (await app.inject(`/v1/alerts/feed?watch=${CROSS2}`)).json();
    expect(f.items[0]).toMatchObject({ kind: 'opening' });
    expect(f.horizonSeconds).toBe(86_400);
  });
});
