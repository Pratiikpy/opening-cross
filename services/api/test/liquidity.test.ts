// /v1/liquidity/*: registration, quotes re-checked against the chain, and maker measurement with the rebate. Needs DATABASE_URL
// (each run uses and then drops its own schema); the signed documents and the chain are real, only the cluster is in memory.
import Fastify, { type FastifyInstance } from 'fastify';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Address, generateKeyPair, getAddressFromPublicKey } from '@solana/kit';
import { CROSS_CORE_PROGRAM_ADDRESS, OrderSide, OrderState, getOrderEncoder, orderAddress } from '@opening-cross/sdk';
import { QUOTE_SCHEMA, REGISTRATION_SCHEMA, signQuote, signRegistration } from '@opening-cross/liquidity';
import { registerLiquidity } from '../src/routes/liquidity.js';
import { RequestError } from '../src/tx.js';
import { Chain, databaseUrl, insertCross, insertOrder, newAddress, openSchema } from './helpers/w2a.js';

const NOW = 1_800_000_000;
const NONCE = 'a1b2c3d4e5f60718';

async function party() {
  const kp = await generateKeyPair();
  return { kp, address: await getAddressFromPublicKey(kp.publicKey) };
}

const describeDb = databaseUrl ? describe : describe.skip;
if (!databaseUrl) console.warn('liquidity.test.ts: SKIPPED; set DATABASE_URL to a Postgres to run it');

describeDb('liquidity routes', () => {
  let db: pg.Pool;
  let close: () => Promise<void>;
  let app: FastifyInstance;
  const chain = new Chain();
  let own = new Set<string>();

  const post = async (url: string, payload: unknown) => {
    const res = await app.inject({ method: 'POST', url, payload: payload as object });
    return { status: res.statusCode, body: JSON.parse(res.body) };
  };
  const get = async (url: string) => {
    const res = await app.inject({ method: 'GET', url });
    return { status: res.statusCode, body: JSON.parse(res.body) };
  };
  const orderAccount = (maker: string, cross: string, o: { side: OrderSide; state: OrderState; price: bigint; quantity: bigint }) => ({
    owner: CROSS_CORE_PROGRAM_ADDRESS as Address,
    data: new Uint8Array(getOrderEncoder().encode({ cross: cross as Address, owner: maker as Address, nonce: 7n, index: 0, side: o.side, state: o.state, commitment: new Uint8Array(32), price: o.price, quantity: o.quantity, escrow: 1n, bump: 255 })),
  });

  beforeAll(async () => {
    ({ db, close } = await openSchema());
    app = Fastify();
    app.setErrorHandler((err, _req, reply) => {
      if (err instanceof RequestError) return reply.code(err.status).send({ error: err.message, ...err.detail });
      return reply.code(500).send({ error: String(err) });
    });
    registerLiquidity(app, { db, account: chain.read, clock: () => NOW, ownWallets: { has: (a: string) => own.has(a) } as ReadonlySet<string> });
    await app.ready();
  });
  afterAll(async () => {
    await app?.close();
    await close?.();
  });

  const registration = async (p: { kp: CryptoKeyPair; address: string }, over: Record<string, unknown> = {}) =>
    signRegistration({ schema: REGISTRATION_SCHEMA, maker: p.address, name: 'Alpha Quotes', minQuantity: '100', maxSpreadBps: 500, issuedAt: NOW, nonce: NONCE, ...over } as never, p.kp);

  it('registers a maker, lists it, and refuses a forged or stale registration', async () => {
    const m = await party();
    const other = await party();
    expect((await post('/v1/liquidity/makers', await registration(m))).status).toBe(201);
    const forged = await registration({ kp: other.kp, address: m.address });
    expect((await post('/v1/liquidity/makers', forged)).status).toBe(400);
    expect((await post('/v1/liquidity/makers', await registration(m, { name: 'Older', issuedAt: NOW - 10, nonce: 'b1b2c3d4e5f60718' }))).status).toBe(409);
    expect((await post('/v1/liquidity/makers', await registration(m, { name: 'Newer', issuedAt: NOW + 10, nonce: 'c1b2c3d4e5f60718' }))).status).toBe(201);
    const list = await get('/v1/liquidity/makers');
    expect(list.body.makers).toEqual([expect.objectContaining({ maker: m.address, name: 'Newer', operatedByUs: false, obligation: { minQuantity: '100', maxSpreadBps: 500 } })]);
    expect((await post('/v1/liquidity/makers', { nonsense: true })).status).toBe(400);
    expect((await post('/v1/liquidity/makers', [])).status).toBe(400);
  });

  it('stores a quote only while its order rests on chain as quoted, and withdraws it when the order goes', async () => {
    const m = await party();
    const cross = await newAddress();
    const at = await orderAddress(cross, m.address as Address, 7n);
    const body = { schema: QUOTE_SCHEMA as typeof QUOTE_SCHEMA, maker: m.address, cross, side: 'buy' as const, price: '1200000', quantity: '5000000', orderNonce: '7', expiresAt: NOW + 600, nonce: NONCE };
    const q = await signQuote(body, m.kp);

    expect((await post('/v1/liquidity/quotes', q)).status).toBe(422); // no order yet
    chain.set(at, orderAccount(m.address, cross, { side: OrderSide.Buy, state: OrderState.Revealed, price: 1_200_000n, quantity: 6_000_000n }));
    const stored = await post('/v1/liquidity/quotes', q);
    expect(stored).toMatchObject({ status: 201, body: { id: q.id, remaining: '6000000' } });

    const live = await get(`/v1/liquidity/quotes?cross=${cross}`);
    expect(live.body.quotes).toEqual([expect.objectContaining({ id: q.id, maker: m.address, side: 'buy', price: '1200000', backing: { backed: true, remaining: '6000000' } })]);
    expect(live.body.withdrawn).toBe(0);

    chain.delete(at); // the maker cancels
    const gone = await get(`/v1/liquidity/quotes?cross=${cross}`);
    expect(gone.body.quotes).toEqual([]);
    expect(gone.body.withdrawn).toBe(1);

    expect((await post('/v1/liquidity/quotes', { ...q, signature: '00'.repeat(64) })).status).toBe(400);
    const expired = await signQuote({ ...body, expiresAt: NOW - 1, nonce: 'd1b2c3d4e5f60718' }, m.kp);
    expect((await post('/v1/liquidity/quotes', expired)).status).toBe(400);
    expect((await get('/v1/liquidity/quotes')).status).toBe(400);
    expect((await get('/v1/liquidity/quotes?cross=nope')).status).toBe(400);
  });

  it('measures a maker from the orders on chain and splits the reopen rebate by two-sided weight, never to our own wallet', async () => {
    const a = await party();
    const b = await party();
    const ours = await party();
    for (const [p, name] of [[a, 'Alpha'], [b, 'Beta'], [ours, 'House']] as const) await post('/v1/liquidity/makers', await registration(p, { name }));
    own = new Set([ours.address]);

    const reopen = await chain.putCross({}, await newAddress());
    const launch = await chain.putCross({}, await newAddress());
    await insertCross(db, reopen, { kind: 1, state: 'Finalized', protocolFee: 10_000n, slot: 10 });
    await insertCross(db, launch, { kind: 0, state: 'Finalized', protocolFee: 10_000n, slot: 11 });
    // Alpha quotes 300 each side, Beta 100 each side (the minimum), the house 1000 each side; all within 500 bps.
    let idx = 0;
    for (const [owner, qty] of [[a.address, 300n], [b.address, 100n], [ours.address, 1000n]] as const) {
      await insertOrder(db, reopen, idx++, owner, 'buy', 1_000_000n, qty);
      await insertOrder(db, reopen, idx++, owner, 'sell', 1_040_000n, qty);
      await insertOrder(db, launch, idx++, owner, 'buy', 1_000_000n, qty);
      await insertOrder(db, launch, idx++, owner, 'sell', 1_040_000n, qty);
    }
    const alpha = await get(`/v1/liquidity/makers/${a.address}`);
    expect(alpha.status).toBe(200);
    expect(alpha.body.measured).toMatchObject({ crosses: 2, compliant: 2 });
    // Pool = 25% of 10_000 = 2_500 on the reopen only. Weights: alpha min(300, 312) = 300, beta min(100, 104) = 100; the house is out.
    expect(alpha.body.rebate).toMatchObject({ quoteAtoms: '1875', reopenCrossesCounted: 1 });
    const beta = await get(`/v1/liquidity/makers/${b.address}`);
    expect(beta.body.rebate.quoteAtoms).toBe('625');
    const house = await get(`/v1/liquidity/makers/${ours.address}`);
    expect(house.body.operatedByUs).toBe(true);
    expect(house.body.rebate.quoteAtoms).toBe('0');
    expect(house.body.rebate.note).toMatch(/own budget/);

    const stranger = await newAddress();
    expect((await get(`/v1/liquidity/makers/${stranger}`)).status).toBe(404);
    expect((await get('/v1/liquidity/makers/not-an-address')).status).toBe(400);
  });

  it('reports a maker that quotes too wide as not compliant, with the reason', async () => {
    const w = await party();
    await post('/v1/liquidity/makers', await registration(w, { name: 'Wide', maxSpreadBps: 100 }));
    const c = await chain.putCross({}, await newAddress());
    await insertCross(db, c, { kind: 1, state: 'Finalized', protocolFee: 4_000n, slot: 20 });
    await insertOrder(db, c, 100, w.address, 'buy', 1_000_000n, 500n);
    await insertOrder(db, c, 101, w.address, 'sell', 1_100_000n, 500n);
    const out = await get(`/v1/liquidity/makers/${w.address}`);
    expect(out.body.measured.compliant).toBe(0);
    expect(out.body.measured.perCross[0].reasons[0]).toMatch(/spread is 953 bps/);
    expect(out.body.rebate.quoteAtoms).toBe('0');
  });
});
