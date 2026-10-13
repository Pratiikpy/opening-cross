// Router execution and intents over HTTP: the real router package prices real encoded books, the real transaction builder
// makes the transaction, and the Jupiter side runs against a stand-in for Jupiter's HTTP API. Needs DATABASE_URL.
import Fastify, { type FastifyInstance } from 'fastify';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Address, generateKeyPair, getAddressFromPublicKey } from '@solana/kit';
import { CROSS_CORE_PROGRAM_ADDRESS, CrossState, Disclosure, bookAddress, shardAddress } from '@opening-cross/sdk';
import { getLevelsDecoder, getLevelsEncoder } from '@opening-cross/cross-core-client';
import { INTENT_SCHEMA, signIntent } from '@opening-cross/liquidity';
import { registerExecute } from '../src/routes/execute.js';
import { RequestError } from '../src/tx.js';
import { Chain, databaseUrl, insertCross, newAddress, openSchema } from './helpers/w2a.js';

const NOW = 1_800_000_000;
const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb' as Address;
const describeDb = databaseUrl ? describe : describe.skip;
if (!databaseUrl) console.warn('execute.test.ts: SKIPPED; set DATABASE_URL to a Postgres to run it');

describeDb('router execution', () => {
  let db: pg.Pool;
  let close: () => Promise<void>;
  const chain = new Chain();
  let base: Address;
  let quote: Address;
  let owner: Address;
  const sims: string[] = [];

  const mint = (decimals: number) => {
    const data = new Uint8Array(82);
    data[44] = decimals;
    return { owner: TOKEN_2022, data };
  };
  /** An open-book cross with sells resting at a tick, as the router reads it from the book and the one unmerged shard. */
  async function liveCross(o: { sells?: [number, bigint][]; buys?: [number, bigint][]; closeTs?: number; sealed?: boolean; gate?: boolean; state?: number; pair?: [Address, Address] } = {}) {
    const [b, q] = o.pair ?? [base, quote];
    const address = await newAddress();
    await chain.putCross(
      {
        state: o.state ?? CrossState.Live, disclosure: o.sealed ? Disclosure.Sealed : Disclosure.Open, baseMint: b, quoteMint: q, baseBound: true,
        openTs: BigInt(NOW - 100), closeTs: BigInt(o.closeTs ?? NOW + 1_000), minPrice: 1_000_000n, tick: 50_000n, ticks: 41, priceScale: 1_000_000n, baseDecimals: 6, quoteDecimals: 6,
        shards: 1, mergedMask: 0, maxOrders: 1000, ordersTotal: 1, protocolFeeBps: 5, integratorFeeBps: 20,
        ...(o.gate ? { gateMint: { __option: 'Some', value: await newAddress() } } : {}),
      },
      address,
    );
    const zero = getLevelsDecoder().decode(new Uint8Array(getLevelsEncoder().fixedSize));
    const levels = { ...zero, cross: address, buy: [...zero.buy], sell: [...zero.sell], buyOrders: [...zero.buyOrders], sellOrders: [...zero.sellOrders] };
    for (const [i, q2] of o.sells ?? []) { levels.sell[i] = q2; levels.sellOrders[i] = 1; }
    for (const [i, q2] of o.buys ?? []) { levels.buy[i] = q2; levels.buyOrders[i] = 1; }
    const bytes = new Uint8Array(getLevelsEncoder().encode(levels as never));
    chain.set(await bookAddress(address), { owner: CROSS_CORE_PROGRAM_ADDRESS as Address, data: new Uint8Array(getLevelsEncoder().encode({ ...levels, buy: levels.buy.map(() => 0n), sell: levels.sell.map(() => 0n), buyOrders: levels.buyOrders.map(() => 0), sellOrders: levels.sellOrders.map(() => 0) } as never)) });
    chain.set(await shardAddress(address, 0), { owner: CROSS_CORE_PROGRAM_ADDRESS as Address, data: bytes });
    await insertCross(db, address, { state: 'Live', kind: 1, closeTs: BigInt(o.closeTs ?? NOW + 1_000), slot: 50 });
    await db.query('UPDATE crosses SET base_mint = $2, quote_mint = $3 WHERE address = $1', [address, b, q]);
    return address;
  }

  const build = async (network: string, extra: Partial<Parameters<typeof registerExecute>[1]> = {}, opts: Parameters<typeof registerExecute>[2] = {}) => {
    const app = Fastify();
    app.setErrorHandler((err, _req, reply) => (err instanceof RequestError ? reply.code(err.status).send({ error: err.message, ...err.detail }) : reply.code(500).send({ error: String(err) })));
    registerExecute(app, { db, account: chain.read, lifetime: async () => ({ blockhash: '4NCYB3kRT8sCNodPNuCZo8VUh4xqpBQxsxed2wd9xaD4' as never, lastValidBlockHeight: 99n }), clock: () => NOW, network, ...extra }, { simulate: async (w) => (sims.push(w), { err: null, logs: ['ok'], unitsConsumed: 22_000 }), ...opts });
    await app.ready();
    return app;
  };
  const post = async (app: FastifyInstance, url: string, payload: unknown) => {
    const r = await app.inject({ method: 'POST', url, payload: payload as object });
    return { status: r.statusCode, body: JSON.parse(r.body) };
  };
  const exec = (over: Record<string, unknown> = {}) => ({ base, quote, side: 'buy', amount: '50000000', owner, ...over });

  beforeAll(async () => {
    ({ db, close } = await openSchema());
    [base, quote, owner] = [await newAddress(), await newAddress(), await newAddress()];
    chain.set(base, mint(6));
    chain.set(quote, mint(6));
  });
  afterAll(async () => {
    await close?.();
  });

  it('on devnet builds the place-order transaction for the cross that wins, with a limit from its indicative price', async () => {
    const app = await build('devnet');
    const cross = await liveCross({ sells: [[11, 100_000_000n]] }); // 100 tokens offered at 1.55
    const r = await post(app, '/v1/route/execute', exec());
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ schema: 'opening-cross/route-execution/v1', network: 'devnet', venue: 'cross', cross, sealed: false });
    // Indicative clearing price 1.55; the limit is two grid steps above it; the escrow is the whole limit.
    expect(r.body.limit).toMatchObject({ price: '1650000', source: expect.stringContaining('plus 2 grid steps') });
    expect(r.body.escrow).toEqual({ atoms: '82500000', asset: 'quote' });
    expect(r.body.signers).toContain(owner);
    expect(r.body.preflight).toMatchObject({ err: null, unitsConsumed: 22_000 });
    expect(r.body.ranking.excluded.some((e: { venue: string; reason: string }) => e.venue === 'jupiter' && /mainnet liquidity only/.test(e.reason))).toBe(true);
    expect(r.body.ranking.caveats.join(' ')).toContain('unsigned');
    expect(sims.length).toBe(1);
  });

  it('sells with a limit below the indicative price, and a named limit and slack are honoured', async () => {
    const app = await build('devnet');
    await liveCross({ buys: [[11, 100_000_000n]] }); // bids for 100 tokens at 1.55
    const sell = await post(app, '/v1/route/execute', exec({ side: 'sell', amount: '40000000', slackTicks: 1 }));
    expect(sell.status).toBe(200);
    expect(sell.body.limit.price).toBe('1500000');
    expect(sell.body.escrow).toEqual({ atoms: '40000000', asset: 'base' });
    const named = await post(app, '/v1/route/execute', exec({ side: 'sell', amount: '40000000', limitPrice: '1400000' }));
    expect(named.body.limit).toMatchObject({ price: '1400000', source: 'the limit you named' });
  });

  it('on mainnet picks Jupiter when it is cheaper and returns its unsigned swap, and the cross when the cross is', async () => {
    const dexAt = (quoteAtoms: bigint): NonNullable<NonNullable<Parameters<typeof build>[1]>['dexQuote']> => async () => ({ venue: 'jupiter', available: true, quote: quoteAtoms, base: 50_000_000n, contextSlot: 7n, route: ['Orca'], priceImpactPct: '0.01' });
    const calls: string[] = [];
    const fetchImpl = (async (input: URL | string, init?: RequestInit) => {
      calls.push(String(input));
      if (String(input).includes('/quote')) return new Response(JSON.stringify({ inAmount: '70000000', outAmount: '50000000', priceImpactPct: '0.01', routePlan: [{ swapInfo: { label: 'Orca' } }] }), { status: 200 });
      return new Response(JSON.stringify({ swapTransaction: 'AQID', lastValidBlockHeight: 321 }), { status: 200 });
    }) as typeof fetch;
    await liveCross({ sells: [[11, 100_000_000n]] }); // the cross prices 50 tokens at 1.55 = 77.5
    const cheapDex = await build('mainnet-beta', { dexQuote: dexAt(70_000_000n) }, { fetchImpl });
    const j = await post(cheapDex, '/v1/route/execute', exec());
    expect(j.body).toMatchObject({ venue: 'jupiter', transaction: 'AQID', lastValidBlockHeight: '321', order: null, jupiter: { route: ['Orca'], swapMode: 'ExactOut' } });
    expect(calls.some((c) => c.endsWith('/swap'))).toBe(true);
    const dearDex = await build('mainnet-beta', { dexQuote: dexAt(90_000_000n) }, { fetchImpl });
    expect((await post(dearDex, '/v1/route/execute', exec())).body.venue).toBe('cross');
  });

  it('says why when nothing can fill, and refuses what it must before building anything', async () => {
    const app = await build('devnet');
    const empty = await post(app, '/v1/route/execute', exec({ base: await newAddress() }));
    expect(empty.status).toBe(404);
    const other: [Address, Address] = [await newAddress(), await newAddress()];
    chain.set(other[0], mint(6));
    chain.set(other[1], mint(6));
    const none = await post(app, '/v1/route/execute', exec({ base: other[0], quote: other[1] }));
    expect(none.status).toBe(422);
    expect(none.body.excluded.map((e: { reason: string }) => e.reason).join(' ')).toContain('No live cross trades this pair');
    for (const [over, status] of [[{ amount: '0' }, 400], [{ side: 'hold' }, 400], [{ base: quote }, 400], [{ owner: 'nope' }, 400], [{ slackTicks: 99 }, 400], [{ salt: 'zz' }, 400], [{ limitPrice: '1' }, 400]] as const) {
      expect((await post(app, '/v1/route/execute', exec(over))).status, JSON.stringify(over)).toBe(status);
    }
    expect((await post(app, '/v1/route/execute', [])).status).toBe(400);
  });

  it('bids in a sealed cross only when told to, with a limit and a salt, and a gated or closed cross is refused', async () => {
    const app = await build('devnet');
    const sealed = await liveCross({ sealed: true });
    const noLimit = await post(app, '/v1/route/execute', exec({ cross: sealed }));
    expect(noLimit.status).toBe(422);
    expect(noLimit.body.error).toMatch(/name a limitPrice/);
    const noSalt = await post(app, '/v1/route/execute', exec({ cross: sealed, limitPrice: '1500000' }));
    expect(noSalt).toMatchObject({ status: 400, body: { error: expect.stringContaining('provide a 32-byte hex salt') } });
    const ok = await post(app, '/v1/route/execute', exec({ cross: sealed, limitPrice: '1500000', salt: 'ab'.repeat(32) }));
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ venue: 'cross', sealed: true, reveal: expect.stringContaining('Keep the salt') });
    const gated = await liveCross({ gate: true, sells: [[11, 100_000_000n]] });
    expect((await post(app, '/v1/route/execute', exec({ cross: gated }))).body.error).toMatch(/holders of a pass/);
    const closed = await liveCross({ closeTs: NOW - 5, sells: [[11, 100_000_000n]] });
    expect((await post(app, '/v1/route/execute', exec({ cross: closed }))).status).toBe(422);
  });
});

describeDb('intents', () => {
  let db: pg.Pool;
  let close: () => Promise<void>;
  const chain = new Chain();
  let app: FastifyInstance;

  beforeAll(async () => {
    ({ db, close } = await openSchema());
    app = Fastify();
    app.setErrorHandler((err, _req, reply) => {
      if (err instanceof RequestError) return reply.code(err.status).send({ error: err.message, ...err.detail });
      const code = (err as { statusCode?: number }).statusCode;
      return code && code < 500 ? reply.code(code).send({ error: (err as Error).message }) : reply.code(500).send({ error: String(err) });
    });
    registerExecute(app, { db, account: chain.read, lifetime: async () => ({ blockhash: '4NCYB3kRT8sCNodPNuCZo8VUh4xqpBQxsxed2wd9xaD4' as never, lastValidBlockHeight: 9n }), clock: () => NOW, network: 'devnet' }, { simulate: async () => ({ err: null, logs: [], unitsConsumed: 1 }) });
    await app.ready();
  });
  afterAll(async () => {
    await app?.close();
    await close?.();
  });

  const post = async (url: string, payload?: unknown) => {
    const r = await app.inject({ method: 'POST', url, ...(payload !== undefined ? { payload: payload as object } : {}) });
    return { status: r.statusCode, body: JSON.parse(r.body) };
  };
  async function party() {
    const kp = await generateKeyPair();
    return { kp, address: await getAddressFromPublicKey(kp.publicKey) };
  }
  const body = (ownerAddr: string, base: string, quote: string, over: Record<string, unknown> = {}) => ({ schema: INTENT_SCHEMA as typeof INTENT_SCHEMA, owner: ownerAddr, baseMint: base, quoteMint: quote, side: 'buy' as const, quantity: '50000000', limitPrice: null, expiresAt: NOW + 3_600, nonce: 'a1b2c3d4e5f60718', ...over });

  it('stores a signed intent, lists it, and refuses forged, expired and malformed ones', async () => {
    const me = await party();
    const other = await party();
    const [b, q] = [await newAddress(), await newAddress()];
    const signed = await signIntent(body(me.address, b, q), me.kp);
    expect((await post('/v1/intents', signed)).status).toBe(201);
    expect((await post('/v1/intents', signed)).status).toBe(201); // storing twice is harmless
    const list = await app.inject({ method: 'GET', url: `/v1/intents?owner=${me.address}` });
    expect(JSON.parse(list.body).intents.map((i: { id: string }) => i.id)).toEqual([signed.id]);
    expect((await post('/v1/intents', await signIntent(body(me.address, b, q), other.kp))).body.reason).toBe('BAD_SIGNATURE');
    expect((await post('/v1/intents', await signIntent(body(me.address, b, q, { expiresAt: NOW - 1, nonce: 'b1b2c3d4e5f60718' }), me.kp))).body.reason).toBe('EXPIRED');
    expect((await post('/v1/intents', { body: 1 })).status).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/v1/intents?owner=nope' })).statusCode).toBe(400);
  });

  it('executes an intent into an unsigned transaction for the open cross of its pair, and explains when there is none', async () => {
    const me = await party();
    const [b, q] = [await newAddress(), await newAddress()];
    const mintData = () => ({ owner: TOKEN_2022, data: Object.assign(new Uint8Array(82), { 44: 6 }) });
    chain.set(b, mintData());
    chain.set(q, mintData());
    const signed = await signIntent(body(me.address, b, q, { limitPrice: '1650000' }), me.kp);
    await post('/v1/intents', signed);

    // No cross of the pair yet: the answer lists what it checked.
    const none = await post(`/v1/intents/${signed.id}/execute`);
    expect(none.status).toBe(409);
    expect(none.body.error).toMatch(/no open cross of this pair/);

    const cross = await chain.putCross({ state: CrossState.Live, disclosure: Disclosure.Open, baseMint: b, quoteMint: q, baseBound: true, openTs: BigInt(NOW - 100), closeTs: BigInt(NOW + 900), minPrice: 1_000_000n, tick: 50_000n, ticks: 41, baseDecimals: 6, quoteDecimals: 6, shards: 1, mergedMask: 0, maxOrders: 1000 });
    const zero = getLevelsDecoder().decode(new Uint8Array(getLevelsEncoder().fixedSize));
    const levels = { ...zero, cross, buy: [...zero.buy], sell: [...zero.sell], buyOrders: [...zero.buyOrders], sellOrders: [...zero.sellOrders] };
    chain.set(await bookAddress(cross), { owner: CROSS_CORE_PROGRAM_ADDRESS as Address, data: new Uint8Array(getLevelsEncoder().encode(levels as never)) });
    levels.sell[11] = 100_000_000n;
    levels.sellOrders[11] = 1;
    chain.set(await shardAddress(cross, 0), { owner: CROSS_CORE_PROGRAM_ADDRESS as Address, data: new Uint8Array(getLevelsEncoder().encode(levels as never)) });
    await insertCross(db, cross, { state: 'Live', kind: 1, closeTs: BigInt(NOW + 900), slot: 60 });
    await db.query('UPDATE crosses SET base_mint = $2, quote_mint = $3, disclosure = 1, open_ts = $4 WHERE address = $1', [cross, b, q, NOW - 100]);

    // HTTP clients often declare a JSON body they do not send: that is no body, not an error. Invalid JSON still is one.
    const declared = await app.inject({ method: 'POST', url: `/v1/intents/${signed.id}/execute`, headers: { 'content-type': 'application/json' }, payload: '' });
    expect(declared.statusCode).toBe(200);
    const broken = await app.inject({ method: 'POST', url: `/v1/intents/${signed.id}/execute`, headers: { 'content-type': 'application/json' }, payload: '{nope' });
    expect(broken.statusCode).toBe(400);
    const ok = await post(`/v1/intents/${signed.id}/execute`);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ intent: signed.id, venue: 'cross', cross, limit: { price: '1650000', source: 'the limit you named' } });
    expect(ok.body.signers).toContain(me.address);

    expect((await post('/v1/intents/zz/execute')).status).toBe(400);
    expect((await post(`/v1/intents/${'0'.repeat(64)}/execute`)).status).toBe(404);
  });
});
