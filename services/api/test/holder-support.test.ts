import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import type { PGlite } from '@electric-sql/pglite';
import { RequestError } from '../src/tx.js';
import { registerHolderSupport } from '../src/routes/holder-support.js';
import { holderDb } from './helpers/holder-pg.js';

const WALLET = '7MjUeRtbGsXYXQWj8CeW1iKQSMki5xQvNZR8TnJixU1A';

describe('support', () => {
  let db: PGlite;
  const mails: { to: string; subject: string; text: string }[] = [];
  let now = 1_800_000_000;
  const build = async (over: Partial<Parameters<typeof registerHolderSupport>[1]> = {}) => {
    const app = Fastify();
    app.setErrorHandler((err, _req, reply) => (err instanceof RequestError ? reply.code(err.status).send({ error: err.message }) : reply.code(500).send({ error: String(err) })));
    registerHolderSupport(app, { db, clock: () => now, inbox: 'support@example.com', responseHours: 24, operatorToken: 'op', mail: async (m) => (mails.push(m), 'ok'), ...over });
    await app.ready();
    return app;
  };
  beforeAll(async () => {
    db = await holderDb();
  });
  afterAll(async () => {
    await db.close();
  });

  it('says what it commits to, and commits to nothing unless a response time is set', async () => {
    const on = await build();
    expect((await on.inject('/v1/support/config')).json()).toMatchObject({ reachesAPerson: true, responseHours: 24, commitment: 'A person answers within 24 hours.' });
    const off = await build({ inbox: null, responseHours: null, mail: null });
    const c = (await off.inject('/v1/support/config')).json();
    expect(c).toMatchObject({ reachesAPerson: false, responseHours: null });
    expect(c.commitment).toContain('No response time is committed');
  });

  it('stores a request, mails the inbox, and shows its status and the reply by token', async () => {
    const app = await build();
    const r = await app.inject({ method: 'POST', url: '/v1/support', payload: { topic: 'claim', message: 'My claim says it is waiting but the cross cleared an hour ago.', contact: 'me@example.com', wallet: WALLET } });
    expect(r.statusCode).toBe(201);
    const { id, token, notified } = r.json();
    expect(notified).toBe(true);
    expect(mails.at(-1)).toMatchObject({ to: 'support@example.com' });
    expect(mails.at(-1)!.subject).toContain(id);
    expect((await app.inject({ method: 'POST', url: '/v1/support/status', payload: { id, token } })).json()).toMatchObject({ status: 'open', answer: null });
    expect((await app.inject({ method: 'POST', url: '/v1/support/status', payload: { id, token: 'x'.repeat(24) } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: `/v1/support/${id}/answer`, payload: { answer: 'Claim it from the Orders page.' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: `/v1/support/${id}/answer`, headers: { authorization: 'Bearer op' }, payload: { answer: 'Claim it from the Orders page.' } })).json()).toEqual({ answered: true });
    expect((await app.inject({ method: 'POST', url: '/v1/support/status', payload: { id, token } })).json()).toMatchObject({ status: 'answered', answer: 'Claim it from the Orders page.' });
  });

  it('refuses junk and limits one contact to five a day', async () => {
    const app = await build();
    const post = (payload: unknown) => app.inject({ method: 'POST', url: '/v1/support', payload: payload as never });
    expect((await post({ topic: 'nope', message: 'a long enough message here' })).statusCode).toBe(400);
    expect((await post({ topic: 'order', message: 'short' })).statusCode).toBe(400);
    expect((await post({ topic: 'order', message: 'x'.repeat(2001) })).statusCode).toBe(400);
    expect((await post({ topic: 'order', message: 'a long enough message here', contact: 'not-an-email' })).statusCode).toBe(400);
    expect((await post({ topic: 'order', message: 'a long enough message here', wallet: 'nope' })).statusCode).toBe(400);
    for (let i = 0; i < 5; i++) expect((await post({ topic: 'order', message: `message number ${i} about my order`, contact: 'busy@example.com' })).statusCode).toBe(201);
    expect((await post({ topic: 'order', message: 'one more message about my order', contact: 'busy@example.com' })).statusCode).toBe(409);
    now += 86_401;
    expect((await post({ topic: 'order', message: 'tomorrow, one more message', contact: 'busy@example.com' })).statusCode).toBe(201);
  });

  it('is honest when no one is notified', async () => {
    const app = await build({ inbox: null, mail: null });
    const r = (await app.inject({ method: 'POST', url: '/v1/support', payload: { topic: 'other', message: 'Is anyone there? Asking for a check.' } })).json();
    expect(r.notified).toBe(false);
  });
});
