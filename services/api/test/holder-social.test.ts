// Holder-weighted comments (M8) with real Ed25519 signatures and a real Postgres, and the retention figures (R6).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import type { PGlite } from '@electric-sql/pglite';
import { type Address, generateKeyPairSigner, getBase58Decoder, signBytes, some } from '@solana/kit';
import { ata } from '@opening-cross/sdk';
import { RequestError } from '../src/tx.js';
import { MAX_BODY, bodyProblem, commentMessage, registerHolderSocial, weightBps } from '../src/routes/holder-social.js';
import { HORIZON_WEEKS, MIN_COHORT, WEEK, registerHolderRetention, retention } from '../src/routes/holder-retention.js';
import { addCross, addOrder, holderDb } from './helpers/holder-pg.js';
import { TOKEN_PROGRAM, type TestCross, makeCross, tokenAccount } from './helpers/holder-cross.js';

const NOW = 1_800_000_000;

describe('comment rules', () => {
  it('accepts plain text and refuses empty, long, linked or tampered text', () => {
    expect(bodyProblem('Cleared lower than I expected, but the refund came back in one claim.')).toBeNull();
    expect(bodyProblem('   ')).toContain('empty');
    expect(bodyProblem('x'.repeat(MAX_BODY + 1))).toContain(`${MAX_BODY}`);
    expect(bodyProblem('x'.repeat(MAX_BODY))).toBeNull();
    for (const bad of ['see https://evil.example now', 'go to www.evil.example', 'join evil.xyz today', 'x\u0000y', 'a‮b', 'a\u0007b']) expect(bodyProblem(bad), bad).not.toBeNull();
    expect(bodyProblem(42)).toContain('text');
    // Ordinary punctuation and numbers are fine, including a price like 1.25.
    expect(bodyProblem('Paid 1.25 per token. Fair!')).toBeNull();
  });

  it('weighs a holder by the share of the matched amount, capped, and says nothing when nothing printed', () => {
    expect(weightBps(250n, 1000n)).toBe(2500);
    expect(weightBps(5000n, 1000n)).toBe(10_000);
    expect(weightBps(0n, 1000n)).toBe(0);
    expect(weightBps(5n, null)).toBeNull();
    expect(weightBps(5n, 0n)).toBeNull();
  });
});

describe('comment routes', () => {
  let db: PGlite;
  const accounts = new Map<string, { data: Uint8Array; owner: Address }>();
  let cross: TestCross;
  let now = NOW;
  let app: ReturnType<typeof Fastify>;

  const sign = async (signer: Awaited<ReturnType<typeof generateKeyPairSigner>>, body: string, at = now, crossAddr = cross.address) => {
    const sig = await signBytes(signer.keyPair.privateKey, new TextEncoder().encode(commentMessage(crossAddr, at, body)));
    return { author: signer.address, signedAt: at, body, signature: getBase58Decoder().decode(sig) };
  };
  const post = (payload: unknown) => app.inject({ method: 'POST', url: `/v1/crosses/${cross.address}/comments`, payload: payload as never });

  beforeAll(async () => {
    db = await holderDb();
    cross = await makeCross({ state: 1, clearing: some({ price: 1_500_000n, matched: 1_000_000_000n, demand: 1_000_000_000n, supply: 1_000_000_000n, rationed: 0, marginalQuantity: 0n, marginalRemaining: 0n, marginalOrders: 0 }), baseBound: true });
    accounts.set(cross.address, cross.account);
    await addCross(db, { address: cross.address, state: 'Cleared', open: NOW - 3000, close: NOW - 1000 });
    app = Fastify();
    app.setErrorHandler((err, _req, reply) => {
      if (err instanceof RequestError) return reply.code(err.status).send({ error: err.message });
      return reply.code(500).send({ error: String(err) });
    });
    registerHolderSocial(app, { db, account: async (a) => accounts.get(a) ?? null, clock: () => now, moderatorToken: 'mod-secret' });
    await app.ready();
  });
  afterAll(async () => {
    await db.close();
  });

  it('lets a holder comment, weighted by the share of the matched amount they hold', async () => {
    const holder = await generateKeyPairSigner();
    accounts.set(await ata(holder.address, cross.baseMint, TOKEN_PROGRAM), tokenAccount(holder.address, cross.baseMint, 250_000_000n));
    const r = await post(await sign(holder, 'Held through the whole call; the refund arrived with the fill.'));
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json()).toMatchObject({ role: 'holder', weightBps: 2500 });
  });

  it('lets a bidder with no tokens comment, with no weight, and orders heavier voices first', async () => {
    const bidder = await generateKeyPairSigner();
    await addOrder(db, { cross: cross.address, idx: 0, address: 'Order00000000000000000000000000000000000000001', owner: bidder.address, status: 'claimed' });
    const r = await post(await sign(bidder, 'I bid and was not filled; limit was too low.'));
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ role: 'bidder', weightBps: 0 });
    const list = (await app.inject(`/v1/crosses/${cross.address}/comments`)).json();
    expect(list.comments.map((c: { role: string }) => c.role)).toEqual(['holder', 'bidder']);
    expect(list.comments[0].weightBps).toBe(2500);
    expect(list.comments[0]).toHaveProperty('signature');
  });

  it('refuses a stranger: no order, no tokens', async () => {
    const stranger = await generateKeyPairSigner();
    const r = await post(await sign(stranger, 'Nice project everyone'));
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toContain('only a wallet that placed an order');
  });

  it('refuses a forged, replayed-elsewhere, stale or malformed signature', async () => {
    const holder = await generateKeyPairSigner();
    accounts.set(await ata(holder.address, cross.baseMint, TOKEN_PROGRAM), tokenAccount(holder.address, cross.baseMint, 1n));
    const good = await sign(holder, 'First thoughts on the clearing price');
    // The text changed after signing.
    expect((await post({ ...good, body: 'Something else entirely' })).statusCode).toBe(400);
    // Signed for another cross.
    expect((await post(await sign(holder, 'First thoughts on the clearing price', now, 'ELVKGevyF2qarSYiZHAkRdAkfKruKSgKL7aS9XTrVBK8'))).statusCode).toBe(400);
    // Signed by someone else.
    const other = await generateKeyPairSigner();
    expect((await post({ ...good, author: other.address })).statusCode).toBe(400);
    // Too old, too far ahead.
    expect((await post(await sign(holder, 'First thoughts on the clearing price', now - 301))).statusCode).toBe(400);
    expect((await post(await sign(holder, 'First thoughts on the clearing price', now + 301))).statusCode).toBe(400);
    // Not a signature, not an address, no body.
    expect((await post({ ...good, signature: 'abc' })).statusCode).toBe(400);
    expect((await post({ ...good, author: 'nope' })).statusCode).toBe(400);
    expect((await post({})).statusCode).toBe(400);
    expect((await post(await sign(holder, 'look at https://x.example'))).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/v1/crosses/not-an-address/comments', payload: good })).statusCode).toBe(400);
    const missing = (await generateKeyPairSigner()).address;
    expect((await app.inject({ method: 'POST', url: `/v1/crosses/${missing}/comments`, payload: good })).statusCode).toBe(404);
    expect((await post(good)).statusCode).toBe(201);
    // The same signed comment cannot be posted twice.
    now += 61;
    expect((await post(await sign(holder, 'First thoughts on the clearing price', now - 61 + 0))).statusCode).toBe(409);
  });

  it('allows one comment a minute and twenty a day per wallet', async () => {
    const holder = await generateKeyPairSigner();
    accounts.set(await ata(holder.address, cross.baseMint, TOKEN_PROGRAM), tokenAccount(holder.address, cross.baseMint, 10n));
    expect((await post(await sign(holder, 'one'))).statusCode).toBe(201);
    const quick = await post(await sign(holder, 'two'));
    expect(quick.statusCode).toBe(409);
    expect(quick.json().error).toContain('one comment a minute');
    for (let i = 3; i <= 22; i++) {
      now += 61;
      const r = await post(await sign(holder, `comment number ${i}`));
      expect(r.statusCode, `comment ${i}`).toBe(i <= 21 ? 201 : 409);
    }
  });

  it('hides a comment only for the moderator, and a hidden comment leaves the list', async () => {
    const list = (await app.inject(`/v1/crosses/${cross.address}/comments?limit=100`)).json();
    const id = list.comments[0].id;
    expect((await app.inject({ method: 'POST', url: `/v1/comments/${id}/hide` })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: `/v1/comments/${id}/hide`, headers: { authorization: 'Bearer wrong' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: `/v1/comments/${id}/hide`, headers: { authorization: 'Bearer mod-secret' } })).json()).toEqual({ hidden: true, id });
    const after = (await app.inject(`/v1/crosses/${cross.address}/comments?limit=100`)).json();
    expect(after.comments.some((c: { id: string }) => c.id === id)).toBe(false);
    expect((await app.inject({ method: 'POST', url: '/v1/comments/nothing/hide', headers: { authorization: 'Bearer mod-secret' } })).statusCode).toBe(404);
  });
});

describe('retention', () => {
  const w = (n: number) => `Wallet${n}`;
  const week = (n: number) => n * WEEK + 100;

  it('counts a wallet in the week of its first cross and retained in a later week when it orders again', () => {
    const rows = [
      // Cohort 100: wallets 1-6, wallet 1 and 2 return in week 1, wallet 1 again in week 2.
      ...[1, 2, 3, 4, 5, 6].map((n) => ({ wallet: w(n), openTs: week(100) })),
      { wallet: w(1), openTs: week(101) },
      { wallet: w(2), openTs: week(101) },
      { wallet: w(1), openTs: week(102) },
      // Cohort 101: one wallet, below the minimum.
      { wallet: w(9), openTs: week(101) },
    ];
    const r = retention(rows, week(104));
    expect(r.wallets).toBe(7);
    const c100 = r.cohorts.find((c) => c.weekStart === 100 * WEEK)!;
    expect(c100.wallets).toBe(6);
    expect(c100.cells.slice(0, 3)).toEqual([
      { week: 1, retained: 2, rate: 2 / 6 },
      { week: 2, retained: 1, rate: 1 / 6 },
      { week: 3, retained: 0, rate: 0 },
    ]);
    const c101 = r.cohorts.find((c) => c.weekStart === 101 * WEEK)!;
    expect(c101.wallets).toBe(1);
    expect(c101.cells.every((c) => c.rate === null)).toBe(true);
    expect(r.returningShare).toBe(2 / 7);
    expect(r.minCohort).toBe(MIN_COHORT);
  });

  it('does not report a week that is still running, nor more than the horizon', () => {
    const rows = [{ wallet: w(1), openTs: week(100) }, { wallet: w(1), openTs: week(101) }];
    expect(retention(rows, week(100)).cohorts[0]!.cells).toEqual([]);
    expect(retention(rows, week(101)).cohorts[0]!.cells).toEqual([]);
    expect(retention(rows, week(102)).cohorts[0]!.cells).toHaveLength(1);
    expect(retention(rows, week(200)).cohorts[0]!.cells).toHaveLength(HORIZON_WEEKS);
  });

  it('reports no figures for no wallets, and two orders in one cross are not a return', () => {
    expect(retention([], week(100))).toMatchObject({ wallets: 0, cohorts: [], returningShare: null });
    const same = retention([{ wallet: w(1), openTs: week(100) }, { wallet: w(1), openTs: week(100) }], week(110));
    expect(same.returningShare).toBe(0);
  });

  it('is served from the indexer tables, leaving out cross creators and the operator wallets', async () => {
    const db = await holderDb();
    const A = (n: number) => `Cross${n}`.padEnd(44, 'x');
    for (let i = 0; i < 3; i++) await addCross(db, { address: A(i), state: 'Finalized', open: (100 + i) * WEEK + 5, close: (100 + i) * WEEK + 600 });
    await db.query(`UPDATE crosses SET creator = 'Creator' WHERE address = $1`, [A(0)]);
    let idx = 0;
    const order = (cross: string, owner: string) => addOrder(db, { cross, idx: idx++ % 1000, address: `Order${idx}`.padEnd(44, 'o'), owner, status: 'claimed' });
    for (const o of ['Alice', 'Bob', 'Carol', 'Dan', 'Erin', 'Frank']) await order(A(0), o);
    await order(A(1), 'Alice');
    await order(A(2), 'Alice');
    await order(A(1), 'Bob');
    await order(A(1), 'Creator');
    await order(A(1), 'Ours');
    const app = Fastify();
    registerHolderRetention(app, { db, clock: () => 110 * WEEK, ownWallets: new Set(['Ours']) });
    await app.ready();
    const body = (await app.inject('/v1/metrics/retention')).json();
    expect(body.wallets).toBe(6);
    const c = body.cohorts.find((x: { weekStart: number }) => x.weekStart === 100 * WEEK);
    expect(c.wallets).toBe(6);
    expect(c.cells[0]).toEqual({ week: 1, retained: 2, rate: 2 / 6 });
    expect(c.cells[1]).toEqual({ week: 2, retained: 1, rate: 1 / 6 });
    expect(body.method).toContain('devnet figures from test traffic');
    await db.close();
  });
});
