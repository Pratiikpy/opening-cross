// Reachable human support (ROADMAP N2; ADR-0411): a request goes to a person, with a reference to check it by.
//
//   GET  /v1/support/config         whether requests reach a person on this deployment and what response time, if any, is committed
//   POST /v1/support                { topic, message, contact?, wallet? } stores the request, mails the operator inbox, returns { id, token }
//   POST /v1/support/status         { id, token } the request's status and the reply, once there is one
//   POST /v1/support/:id/answer     operator only (Authorization: Bearer SUPPORT_TOKEN): records the reply
//
// No response time is promised unless the operator sets one (SUPPORT_RESPONSE_HOURS): a commitment nobody staffs is not a commitment.
// The service says plainly when it is not set up, rather than accepting requests that no one will read.
import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { RequestError } from '../tx.js';
import { type Mail, type Sent } from './holder-alerts-channels.js';
import { hashToken, isAddressLike, tokenMatches } from './holder-alerts-core.js';
import type { Db } from './holder-alerts-store.js';

export const TOPICS = ['order', 'claim', 'identity', 'alerts', 'other'] as const;
export type SupportTopic = (typeof TOPICS)[number];
const MAX_MESSAGE = 2000;
const PER_DAY = 5;

export type HolderSupportDeps = {
  db: Db;
  clock?: () => number;
  /** Where requests are mailed (SUPPORT_INBOX). With none, requests are still stored but the page says no one is notified. */
  inbox?: string | null;
  /** Committed response time in hours (SUPPORT_RESPONSE_HOURS); null commits to none. */
  responseHours?: number | null;
  /** Bearer token for answering (SUPPORT_TOKEN). */
  operatorToken?: string | null;
  mail?: ((m: Mail) => Promise<Sent>) | null;
};

const json = (v: unknown) => JSON.stringify(v);
const send = (reply: FastifyReply, v: unknown, status = 200) => reply.code(status).type('application/json').send(json(v));

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS support_requests (
     id          text PRIMARY KEY,
     topic       text NOT NULL,
     message     text NOT NULL,
     contact     text,
     wallet      text,
     token_hash  text NOT NULL,
     created_at  bigint NOT NULL,
     answered_at bigint,
     answer      text
   )`,
];

export function registerHolderSupport(app: FastifyInstance, deps: HolderSupportDeps) {
  const clock = deps.clock ?? (() => Math.floor(Date.now() / 1000));
  const env = process.env;
  const inbox = deps.inbox === undefined ? env.SUPPORT_INBOX?.trim() || null : deps.inbox;
  const hours = deps.responseHours === undefined ? (env.SUPPORT_RESPONSE_HOURS ? Number(env.SUPPORT_RESPONSE_HOURS) : null) : deps.responseHours;
  const operator = deps.operatorToken === undefined ? env.SUPPORT_TOKEN?.trim() || null : deps.operatorToken;
  const responseHours = hours !== null && Number.isFinite(hours) && hours > 0 ? hours : null;
  let ready: Promise<unknown> | null = null;
  const q = async (text: string, params: unknown[] = []) => {
    ready ??= (async () => {
      for (const s of SCHEMA) await deps.db.query(s);
    })().catch((e) => {
      ready = null;
      throw e;
    });
    await ready;
    return (await deps.db.query(text, params)).rows;
  };

  app.get('/v1/support/config', async (_req, reply) =>
    send(reply, {
      reachesAPerson: Boolean(inbox && deps.mail),
      responseHours,
      commitment: responseHours ? `A person answers within ${responseHours} hours.` : 'No response time is committed yet. Requests are stored and read by the team, and a reply appears here when there is one.',
      topics: TOPICS,
    }),
  );

  app.post('/v1/support', async (req, reply) => {
    const b = req.body as { topic?: unknown; message?: unknown; contact?: unknown; wallet?: unknown } | null;
    if (!b || typeof b !== 'object') throw new RequestError(400, 'request body must be a JSON object');
    if (typeof b.topic !== 'string' || !(TOPICS as readonly string[]).includes(b.topic)) throw new RequestError(400, `topic must be one of ${TOPICS.join(', ')}`);
    const message = typeof b.message === 'string' ? b.message.trim() : '';
    if (message.length < 10) throw new RequestError(400, 'say a little more: a request needs at least 10 characters');
    if (message.length > MAX_MESSAGE) throw new RequestError(400, `a request is at most ${MAX_MESSAGE} characters`);
    const contact = typeof b.contact === 'string' && b.contact.trim() ? b.contact.trim() : null;
    if (contact && (contact.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact))) throw new RequestError(400, 'contact must be an email address, or left empty');
    const wallet = typeof b.wallet === 'string' && b.wallet ? b.wallet : null;
    if (wallet && !isAddressLike(wallet)) throw new RequestError(400, 'wallet must be a base58 Solana address');
    const now = clock();
    const key = contact ?? wallet;
    if (key) {
      const n = (await q('SELECT count(*)::int AS n FROM support_requests WHERE created_at > $1 AND (contact = $2 OR wallet = $2)', [now - 86_400, key]))[0]?.n;
      if (Number(n) >= PER_DAY) throw new RequestError(409, `at most ${PER_DAY} requests a day from one contact`);
    }
    const id = createHash('sha256').update(randomBytes(16)).digest('hex').slice(0, 12);
    const token = randomBytes(18).toString('base64url');
    await q('INSERT INTO support_requests (id, topic, message, contact, wallet, token_hash, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)', [id, b.topic, message, contact, wallet, hashToken(token), now]);
    let notified = false;
    if (inbox && deps.mail) {
      notified = (await deps.mail({ to: inbox, subject: `Support request ${id}: ${b.topic}`, text: `${message}\n\ncontact: ${contact ?? 'none given'}\nwallet: ${wallet ?? 'none given'}\nreference: ${id}\n` })) === 'ok';
    }
    return send(reply, { id, token, notified, commitment: responseHours ? `A person answers within ${responseHours} hours.` : 'No response time is committed yet.' }, 201);
  });

  app.post('/v1/support/status', async (req, reply) => {
    const b = req.body as { id?: unknown; token?: unknown } | null;
    const rows = typeof b?.id === 'string' ? await q('SELECT id, topic, created_at, answered_at, answer, token_hash FROM support_requests WHERE id = $1', [b.id]) : [];
    const r = rows[0];
    if (!r || !tokenMatches(b?.token, String(r.token_hash))) throw new RequestError(404, 'no such request, or the token does not match');
    return send(reply, { id: r.id, topic: r.topic, createdAt: Number(r.created_at), status: r.answered_at ? 'answered' : 'open', answeredAt: r.answered_at ? Number(r.answered_at) : null, answer: r.answer ?? null });
  });

  app.post('/v1/support/:id/answer', async (req, reply) => {
    if (!operator || String(req.headers.authorization ?? '') !== `Bearer ${operator}`) return send(reply, { error: 'not available to this caller' }, 403);
    const text = (req.body as { answer?: unknown } | null)?.answer;
    if (typeof text !== 'string' || text.trim().length < 2 || text.length > MAX_MESSAGE) throw new RequestError(400, 'answer must be 2 to 2000 characters');
    const rows = await q('UPDATE support_requests SET answer = $2, answered_at = $3 WHERE id = $1 RETURNING id', [(req.params as { id: string }).id, text.trim(), clock()]);
    if (rows.length === 0) throw new RequestError(404, 'no such request');
    return send(reply, { answered: true });
  });
}
