// A local API for the holder-side browser runs: the holder routes (alerts, actions, sponsored orders, comments, retention) running
// on a real Postgres (PGlite) seeded from the live index, in front of the live API, which answers every other path. It exists because
// the live deployment does not yet carry the holder routes; everything the holder routes read about crosses and orders is the
// live index's own data, and chain reads and transactions go to devnet.
//
//   pnpm --filter @opening-cross/api exec tsx test/holder-harness.ts
//
// Environment: LIVE_API (default the public deployment), RPC_URL, WEB_URL (default http://localhost:3411), PORT (8081),
// WALLETS (comma-separated wallets whose orders to seed), SPONSOR_KEYPAIR (a keypair file; sponsorship is off without it),
// SMTP_URL / MAIL_FROM (an Ethereal test account is created when unset), HARNESS_VAPID=1 to generate VAPID keys for this run.
import { readFileSync } from 'node:fs';
import cors from '@fastify/cors';
import { PGlite } from '@electric-sql/pglite';
import Fastify from 'fastify';
import nodemailer from 'nodemailer';
import webpush from 'web-push';
import { type Address, getBase64Encoder } from '@solana/kit';
import { registerHolderActions } from '../src/routes/holder-actions.js';
import { registerHolderSupport } from '../src/routes/holder-support.js';
import { registerHolderTerms } from '../src/routes/holder-terms.js';
import { registerHolderBalances } from '../src/routes/holder-balances.js';
import { registerHolderAlerts } from '../src/routes/holder-alerts.js';
import { loadAlertConfig, mailSender } from '../src/routes/holder-alerts-channels.js';
import { registerHolderRetention } from '../src/routes/holder-retention.js';
import { registerHolderSocial } from '../src/routes/holder-social.js';
import { loadSponsor, registerHolderSponsor } from '../src/routes/holder-sponsor.js';
import { RequestError } from '../src/tx.js';

const LIVE = process.env.LIVE_API ?? 'https://98-87-59-136.sslip.io';
const RPC = (process.env.RPC_URL ?? 'https://api.devnet.solana.com').split(',')[0]!;
process.env.RPC_URL = process.env.RPC_URL ?? RPC;
const PORT = Number(process.env.PORT ?? 8081);
const WEB = process.env.WEB_URL ?? 'http://localhost:3411';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function live<T>(path: string): Promise<T | null> {
  for (let i = 0; i < 5; i++) {
    const r = await fetch(`${LIVE}${path}`).catch(() => null);
    if (r?.status === 429) {
      await sleep(2500);
      continue;
    }
    return r?.ok ? ((await r.json()) as T) : null;
  }
  return null;
}

const migration = (name: string) => readFileSync(new URL(`../../indexer/migrations/${name}`, import.meta.url), 'utf8');
const db = new PGlite();
await db.exec(migration('001_init.sql'));
await db.exec(migration('006_calendar.sql'));

// ---- seed from the live index
type Summary = { address: string; state: string; creator: string; base_mint: string; quote_mint: string; open_ts: string; close_ts: string; reveal_end_ts: string; clearing_price: string | null; matched: string | null; orders_committed: number; created_slot: string };
const list = await live<{ crosses: Summary[] }>('/v1/crosses?limit=200');
for (const c of list?.crosses ?? []) {
  await db.query(
    `INSERT INTO crosses (address, creator, kind, supply_mode, disclosure, base_mint, quote_mint, open_ts, close_ts, reveal_end_ts, protocol_fee_bps, integrator_fee_bps, state, clearing_price, matched, orders_committed, created_slot, updated_slot)
     VALUES ($1, $2, 0, 0, 1, $3, $4, $5, $6, $7, 0, 0, $8, $9, $10, $11, $12, $12) ON CONFLICT DO NOTHING`,
    [c.address, c.creator, c.base_mint, c.quote_mint, c.open_ts, c.close_ts, c.reveal_end_ts, c.state, c.clearing_price, c.matched, c.orders_committed, c.created_slot ?? '0'],
  );
}
type OwnerOrder = { cross_address: string; idx: number; address: string; side: string; escrow: string; sealed: boolean; price: string | null; quantity: string | null; status: string; fill: string | null; quote_out: string | null; base_out: string | null; fee: string | null };
async function seedWallet(wallet: string) {
  const r = await live<{ orders: OwnerOrder[] }>(`/v1/owners/${wallet}/orders`);
  for (const o of r?.orders ?? []) {
    await db.query(
      `INSERT INTO orders (cross_address, idx, address, owner, side, escrow, sealed, price, quantity, status, fill, quote_out, base_out, fee, created_slot, updated_slot)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 0, 0) ON CONFLICT DO NOTHING`,
      [o.cross_address, o.idx, o.address, wallet, o.side === 'buy' ? 0 : 1, o.escrow, o.sealed, o.price, o.quantity, o.status, o.fill, o.quote_out, o.base_out, o.fee],
    ).catch(() => undefined);
  }
  return r?.orders.length ?? 0;
}
for (const w of (process.env.WALLETS ?? '').split(',').filter(Boolean)) console.log(`seeded ${await seedWallet(w)} orders of ${w.slice(0, 6)}…`);
console.log(`seeded ${list?.crosses.length ?? 0} crosses from ${LIVE}`);

// ---- chain access
async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  for (let i = 0; i < 6; i++) {
    const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    if (r.status === 429) {
      await sleep(1000 * (i + 1));
      continue;
    }
    const j = (await r.json()) as { result?: T; error?: { message: string } };
    if (j.error) throw new Error(j.error.message);
    return j.result as T;
  }
  throw new Error('rpc kept answering 429');
}
const account = async (a: Address) => {
  const r = await rpc<{ value: { data: [string, string]; owner: string } | null }>('getAccountInfo', [a, { encoding: 'base64', commitment: 'confirmed' }]);
  return r.value ? { data: Uint8Array.from(getBase64Encoder().encode(r.value.data[0])), owner: r.value.owner as Address } : null;
};
const lifetime = async () => {
  const r = await rpc<{ value: { blockhash: string; lastValidBlockHeight: number } }>('getLatestBlockhash', [{ commitment: 'confirmed' }]);
  return { blockhash: r.value.blockhash as never, lastValidBlockHeight: BigInt(r.value.lastValidBlockHeight) };
};

// ---- channels: VAPID keys for this run, and a real SMTP sandbox (Ethereal) unless SMTP_URL is given
const env = { ...process.env } as NodeJS.ProcessEnv;
if (!env.VAPID_PUBLIC_KEY && process.env.HARNESS_VAPID !== '0') {
  const k = webpush.generateVAPIDKeys();
  env.VAPID_PUBLIC_KEY = k.publicKey;
  env.VAPID_PRIVATE_KEY = k.privateKey;
  env.VAPID_SUBJECT = env.VAPID_SUBJECT ?? 'mailto:alerts@opening-bell.invalid';
}
if (!env.SMTP_URL) {
  let t: Awaited<ReturnType<typeof nodemailer.createTestAccount>> | null = null;
  for (let i = 0; i < 5 && !t; i++) t = await nodemailer.createTestAccount().catch(async () => (await sleep(3000), null));
  if (!t) throw new Error('the Ethereal SMTP sandbox (api.nodemailer.com) could not be reached; set SMTP_URL and MAIL_FROM to use another SMTP server');
  env.SMTP_URL = `smtp://${encodeURIComponent(t.user)}:${encodeURIComponent(t.pass)}@${t.smtp.host}:${t.smtp.port}`;
  env.MAIL_FROM = `Opening Bell <${t.user}>`;
  console.log(`SMTP sandbox (Ethereal): inbox at https://ethereal.email/messages, login ${t.user}`);
}
env.WEB_URL = WEB;
const sponsor = await loadSponsor(env);

// ---- the server
const app = Fastify({ bodyLimit: 64 * 1024 });
await app.register(cors, { origin: '*', methods: ['GET', 'POST'] });
app.setErrorHandler((err, _req, reply) => {
  if (err instanceof RequestError) return reply.code(err.status).type('application/json').send({ error: err.message, ...err.detail });
  console.error(err);
  return reply.code(500).type('application/json').send({ error: 'internal error' });
});

const clock = () => Math.floor(Date.now() / 1000);
const alertConfig = loadAlertConfig(env);
// The real SMTP sender delivers to the Ethereal sandbox; the harness also keeps each accepted mail so a run can read what was sent.
const sent: { to: string; subject: string; text: string }[] = [];
const realMail = alertConfig.email ? mailSender(alertConfig.email) : null;
const alerts = registerHolderAlerts(app, {
  db,
  clock,
  config: alertConfig,
  run: true,
  intervalMs: Number(process.env.ALERT_INTERVAL_MS ?? 5_000),
  ...(realMail ? { senders: { mail: async (m) => { const r = await realMail(m); if (r === 'ok') sent.push({ to: m.to, subject: m.subject, text: m.text }); return r; } } } : {}),
});
app.get('/__harness/mails', async () => sent);
registerHolderActions(app, { account, lifetime, clock, webUrl: WEB });
registerHolderSponsor(app, { db, account, lifetime, clock, sponsor });
registerHolderSocial(app, { db, account, clock, moderatorToken: process.env.MODERATOR_TOKEN ?? null });
registerHolderRetention(app, { db, clock });
registerHolderBalances(app, { account });
registerHolderTerms(app, { account });
registerHolderSupport(app, { db, clock, inbox: 'support@opening-bell.invalid', responseHours: null, operatorToken: process.env.SUPPORT_TOKEN ?? 'harness-operator', mail: realMail });
void alerts;

// A way to see what the harness holds, for the runs that follow rows from the index into an alert.
app.post('/__harness/seed-wallet', async (req) => ({ seeded: await seedWallet((req.body as { wallet: string }).wallet) }));
app.post('/__harness/sql', async (req) => (await db.query((req.body as { sql: string }).sql)).rows);

app.post('/__harness/exit', async (_req, reply) => {
  setTimeout(() => process.exit(0), 50);
  return reply.send({ exiting: true });
});

// Everything else is the live API.
app.setNotFoundHandler(async (req, reply) => {
  const r = await fetch(`${LIVE}${req.url}`, {
    method: req.method,
    ...(req.method !== 'GET' && req.method !== 'HEAD' ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(req.body ?? {}) } : {}),
  }).catch(() => null);
  if (!r) return reply.code(502).send({ error: 'the live API could not be reached' });
  reply.code(r.status).type(r.headers.get('content-type') ?? 'application/json');
  const retry = r.headers.get('retry-after');
  if (retry) reply.header('retry-after', retry);
  return reply.send(Buffer.from(await r.arrayBuffer()));
});

await app.listen({ port: PORT, host: '127.0.0.1' });
console.log(`holder API harness on http://127.0.0.1:${PORT} (web ${WEB}, live ${LIVE}, sponsor ${sponsor ? sponsor.address : 'off'}, push ${env.VAPID_PUBLIC_KEY ? 'on' : 'off'})`);
