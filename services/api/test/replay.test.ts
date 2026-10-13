// Launch replay: pure event shaping, then the replay and listing routes and the router route over HTTP against a real
// Postgres schema. Needs DATABASE_URL (any Postgres 14+; each run uses and then drops its own schema). Without it the
// database half is skipped and says so.
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { type Address, generateKeyPairSigner } from '@solana/kit';
import { CROSS_CORE_PROGRAM_ADDRESS, CROSS_DISCRIMINATOR, CrossState, Disclosure, getCrossDecoder, getCrossEncoder } from '@opening-cross/sdk';
import { bookAddressOf } from '@opening-cross/verifier';
import { getLevelsEncoder } from '@opening-cross/cross-core-client';
import { migrate } from '@opening-cross/indexer';
import { buildServer } from '../src/server.js';
import { replayOf } from '../src/replay.js';
import { mintAccount } from './helpers/mint.js';

describe('replayOf', () => {
  const row = (name: string, payload: Record<string, unknown>, time: string | null) => ({ signature: `sig-${name}`, seq: 0, slot: '10', time: time ? new Date(time) : null, name, payload });

  it('numbers events in the order given, names their kind and keeps a missing time null', () => {
    const out = replayOf([row('CrossCreated', { cross: 'X' }, '2026-10-01T10:00:00Z'), row('CrossCleared', { cross: 'X', printed: true }, null)], new Map());
    expect(out.map((e) => [e.n, e.kind, e.time])).toEqual([[1, 'created', '2026-10-01T10:00:00.000Z'], [2, 'cleared', null]]);
  });

  it('adds the limit terms of an open order and never of a sealed one', () => {
    const terms = new Map([['O1', { price: '1500000', quantity: '2000000' }], ['O2', { price: '999', quantity: '999' }]]);
    const [open, sealed] = replayOf([row('OrderCommitted', { order: 'O1', sealed: false }, null), row('OrderCommitted', { order: 'O2', sealed: true }, null)], terms);
    expect(open!.details).toMatchObject({ price: '1500000', quantity: '2000000' });
    expect(sealed!.details.price).toBeUndefined();
  });

  it('passes an event it does not know through under its own name', () => {
    expect(replayOf([row('SomethingNew', {}, null)], new Map())[0]).toMatchObject({ kind: 'SomethingNew', event: 'SomethingNew' });
  });
});

const url = process.env.DATABASE_URL;
if (!url) console.warn('replay.test.ts (database half) SKIPPED: set DATABASE_URL to a Postgres to run the replay and router route tests against a real database');

describe.skipIf(!url)('replay and router routes', () => {
  const schema = `t_${randomBytes(6).toString('hex')}`;
  const NOW = 1_800_000_000;
  let admin: pg.Client;
  let db: pg.Pool;
  let app: Awaited<ReturnType<typeof buildServer>>;
  const accounts = new Map<string, { data: Uint8Array; owner: Address }>();
  let base: Address;
  let quote: Address;
  let openCross: Address;
  let sealedCross: Address;
  let closedCross: Address;
  let finalized: Address;
  let oldCross: Address;
  let dexCalls = 0;

  const addr = async () => (await generateKeyPairSigner()).address;

  async function liveCross(over: Record<string, unknown>) {
    const z = new Uint8Array(4096);
    z.set(CROSS_DISCRIMINATOR as Uint8Array, 0);
    const a = await addr();
    const data = getCrossEncoder().encode({
      ...getCrossDecoder().decode(z), state: CrossState.Live, baseMint: base, quoteMint: quote, baseDecimals: 6, quoteDecimals: 6, minPrice: 1_000_000n, tick: 100_000n, ticks: 10, priceScale: 1_000_000n,
      openTs: BigInt(NOW - 1000), closeTs: BigInt(NOW + 1000), revealEndTs: BigInt(NOW + 2000), shards: 1, mergedMask: 1, maxOrders: 100, ordersTotal: 0, ordersOpen: 0, protocolFeeBps: 0, integratorFeeBps: 0,
      referencePrice: { __option: 'None' }, disclosure: Disclosure.Open, ...over,
    } as never);
    accounts.set(a, { owner: CROSS_CORE_PROGRAM_ADDRESS, data: new Uint8Array(data) });
    return a;
  }

  const insertCross = (a: string, state: string, o: { base?: string; quote?: string; open: number; close: number; price?: string; matched?: string; disclosure?: number; slot?: number; ordersCommitted?: number }) =>
    db.query(
      `INSERT INTO crosses (address, creator, kind, supply_mode, disclosure, base_mint, quote_mint, open_ts, close_ts, reveal_end_ts, protocol_fee_bps, integrator_fee_bps, state, clearing_price, matched, orders_committed, created_slot, updated_slot)
       VALUES ($1,'creator',0,0,$2,$3,$4,$5,$6,$6,30,0,$7,$8,$9,$10,$11,$11)`,
      [a, o.disclosure ?? 1, o.base ?? base, o.quote ?? quote, o.open, o.close, state, o.price ?? null, o.matched ?? null, o.ordersCommitted ?? 0, o.slot ?? 1],
    );
  const insertEvent = (cross: string, sig: string, seq: number, slot: number, name: string, payload: Record<string, unknown>, at: string | null) =>
    db.query(`INSERT INTO events (signature, seq, slot, block_time, name, cross_address, payload) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [sig, seq, slot, at, name, cross, JSON.stringify(payload)]);

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: url });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    db = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` });
    await migrate(db);

    base = await addr();
    quote = await addr();
    accounts.set(base, mintAccount(null, { decimals: 6 }));
    accounts.set(quote, mintAccount(null, { decimals: 6 }));

    // An open cross with resting sellers at 1.0 and a bid at 1.5, all merged into the book account.
    openCross = await liveCross({});
    const levels = { cross: openCross, buy: Array(256).fill(0n), sell: Array(256).fill(0n), buyOrders: Array(256).fill(0), sellOrders: Array(256).fill(0), index: 0, pad: new Uint8Array(7) };
    levels.sell[0] = 5_000_000n;
    levels.sellOrders[0] = 1;
    levels.buy[5] = 1_000_000n;
    levels.buyOrders[5] = 1;
    accounts.set(await bookAddressOf(openCross), { owner: CROSS_CORE_PROGRAM_ADDRESS, data: new Uint8Array(getLevelsEncoder().encode(levels as never)) });
    sealedCross = await liveCross({ disclosure: Disclosure.Sealed });
    closedCross = await liveCross({ closeTs: BigInt(NOW - 5) });
    await insertCross(openCross, 'Live', { open: NOW - 1000, close: NOW + 1000 });
    await insertCross(sealedCross, 'Live', { open: NOW - 1000, close: NOW + 1000, disclosure: 0 });
    await insertCross(closedCross, 'Live', { open: NOW - 1000, close: NOW - 5 });

    // A finalized cross with a full history, and one that opened 90 days ago.
    finalized = await addr();
    oldCross = await addr();
    await insertCross(finalized, 'Finalized', { open: NOW - 86_400 * 3, close: NOW - 86_400 * 3 + 600, price: '1300000', matched: '1350', ordersCommitted: 2, slot: 50 });
    await insertCross(oldCross, 'Finalized', { open: NOW - 86_400 * 90, close: NOW - 86_400 * 90 + 600, slot: 5 });
    const t = (s: number) => new Date((NOW - 86_400 * 3 + s) * 1000).toISOString();
    await insertEvent(finalized, 'sigC', 0, 50, 'CrossCreated', { cross: finalized }, t(-100));
    await insertEvent(finalized, 'sigO1', 0, 51, 'OrderCommitted', { cross: finalized, order: 'ord1', owner: 'ownerA', side: 0, sealed: false, index: 0, escrow: '5' }, t(10));
    await insertEvent(finalized, 'sigO2', 0, 52, 'OrderCommitted', { cross: finalized, order: 'ord2', owner: 'ownerB', side: 1, sealed: true, index: 1, escrow: '7' }, t(20));
    await insertEvent(finalized, 'sigR2', 0, 60, 'OrderRevealed', { cross: finalized, order: 'ord2', price: '1300000', quantity: '1350' }, t(700));
    await insertEvent(finalized, 'sigX', 0, 70, 'CrossCleared', { cross: finalized, printed: true }, t(900));
    await insertEvent(finalized, 'sigK', 1, 80, 'OrderClaimed', { cross: finalized, order: 'ord1', fill: '1350' }, t(1000));
    await insertEvent(finalized, 'sigK', 0, 80, 'OrderClaimed', { cross: finalized, order: 'ord2', fill: '1350' }, t(1000));
    await insertEvent(finalized, 'sigF', 0, 90, 'CrossFinalized', { cross: finalized }, t(1100));
    await db.query(`INSERT INTO orders (cross_address, idx, address, owner, side, escrow, sealed, status, price, quantity, created_slot, updated_slot) VALUES
      ($1,0,'ord1','ownerA',0,5,false,'claimed',1500000,2000000,51,80), ($1,1,'ord2','ownerB',1,7,true,'claimed',1300000,1350,52,80)`, [finalized]);

    app = await buildServer({
      db,
      network: 'devnet',
      clock: () => NOW,
      account: async (a) => accounts.get(a) ?? null,
      lifetime: async () => ({ blockhash: '4NCYB3kRT8sCNodPNuCZo8VkwveZSHhg7R7mrRBFM1Uy' as never, lastValidBlockHeight: 1n }),
      dexQuote: async ({ intent }) => {
        dexCalls++;
        // 1.6 per base token, executable for the full size.
        return { venue: 'jupiter', available: true, quote: (intent.quantity * 16n) / 10n, base: intent.quantity, contextSlot: 99n, route: ['Meteora DAMM v2'], priceImpactPct: '0.02' };
      },
    });
  });
  afterAll(async () => {
    await app?.close();
    await db?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  const get = async (u: string) => {
    const r = await app.inject({ method: 'GET', url: u });
    return { status: r.statusCode, body: JSON.parse(r.body) };
  };

  describe('GET /v1/replay/:address', () => {
    it('returns the whole history in chain order with times, signatures and order terms', async () => {
      const { status, body } = await get(`/v1/replay/${finalized}`);
      expect(status).toBe(200);
      expect(body).toMatchObject({ cross: finalized, complete: true, state: 'Finalized' });
      expect(body.events.map((e: { kind: string }) => e.kind)).toEqual(['created', 'order_placed', 'order_placed', 'order_revealed', 'cleared', 'order_claimed', 'order_claimed', 'finalized']);
      expect(body.events.map((e: { n: number }) => e.n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
      // Within one transaction the position inside it orders the events (seq 0 before seq 1).
      expect(body.events[5].details.order).toBe('ord2');
      expect(body.events[6].details.order).toBe('ord1');
      expect(body.events[1].details).toMatchObject({ price: '1500000', quantity: '2000000' });
      expect(body.events[2].details.price).toBeUndefined(); // sealed until its reveal event
      expect(body.events[3].details.price).toBe('1300000');
      expect(body.events[0]).toMatchObject({ slot: '50', signature: 'sigC', time: expect.stringMatching(/Z$/) });
      expect(body.summary).toMatchObject({ events: 8, ordersPlaced: 2, revealed: 1, claimed: 2, cancelled: 0, cleared: true, finalized: true, clearingPrice: '1300000', matched: '1350' });
      expect(body.summary.firstEventAt < body.summary.lastEventAt).toBe(true);
    });

    it('a cross still live replays so far and says it is not complete', async () => {
      const { body } = await get(`/v1/replay/${openCross}`);
      expect(body).toMatchObject({ complete: false, state: 'Live', events: [] });
    });

    it('404 for a cross the index does not have, 400 for a bad address', async () => {
      expect((await get(`/v1/replay/${await addr()}`)).status).toBe(404);
      expect((await get('/v1/replay/nope')).status).toBe(400);
    });
  });

  describe('GET /v1/replay', () => {
    it('lists crosses that opened within the window, newest first, with a summary each', async () => {
      const { status, body } = await get('/v1/replay?days=30');
      expect(status).toBe(200);
      expect(body.days).toBe(30);
      const addresses = body.crosses.map((c: { address: string }) => c.address);
      expect(addresses).toContain(finalized);
      expect(addresses).not.toContain(oldCross);
      const opens = body.crosses.map((c: { window: { openTs: string } }) => Number(c.window.openTs));
      expect([...opens].sort((a, b) => b - a)).toEqual(opens);
      const f = body.crosses.find((c: { address: string }) => c.address === finalized);
      expect(f).toMatchObject({ state: 'Finalized', outcome: 'printed', clearingPrice: '1300000', disclosure: 'open', orders: { placed: 2, wallets: 2, claimed: 2, cancelled: 0 }, events: 8 });
      expect(f.finalizedAt).toMatch(/Z$/);
      expect(f.firstOrderAt < f.clearedAt && f.clearedAt < f.finalizedAt).toBe(true);
    });

    it('a longer window reaches the older cross; limit and bad parameters are validated', async () => {
      const wide = await get('/v1/replay?days=120');
      expect(wide.body.crosses.map((c: { address: string }) => c.address)).toContain(oldCross);
      expect((await get('/v1/replay?days=120&limit=1')).body.count).toBe(1);
      for (const q of ['days=0', 'days=366', 'days=x', 'limit=0', 'limit=201']) expect((await get(`/v1/replay?${q}`)).status).toBe(400);
    });
  });

  describe('GET /v1/router/quote', () => {
    const q = (o: Record<string, string>) => `/v1/router/quote?${new URLSearchParams({ base, quote, side: 'buy', amount: '2000000', ...o })}`;

    it('ranks the live cross against the DEX route per whole base token and explains every exclusion', async () => {
      const { status, body } = await get(q({}));
      expect(status).toBe(200);
      expect(body).toMatchObject({ schema: 'opening-cross/router-quote/v1', network: 'devnet', base: { decimals: 6 }, priceUnit: 'quote atoms per one whole base token', intent: { side: 'buy', amount: '2000000' } });
      const [first, second] = body.venues;
      expect(first).toMatchObject({ rank: 1, venue: 'cross', cross: openCross, fill: 'full', indicative: true, executableNow: false });
      const p = BigInt(first.pricePerBase);
      expect(p >= 1_000_000n && p <= 1_900_000n).toBe(true); // on the cross's grid
      expect(BigInt(first.quoteAtoms)).toBe((BigInt(first.baseAtoms) * p) / 1_000_000n);
      expect(second).toMatchObject({ rank: 2, venue: 'jupiter', pricePerBase: '1600000', fill: 'full', executableNow: true, route: ['Meteora DAMM v2'] });
      expect(body.best).toEqual({ venue: 'cross', cross: openCross });
      const reasons = body.excluded.map((e: { venue: string; cross?: string; reason: string }) => `${e.venue}:${e.cross ?? ''}:${e.reason}`);
      expect(reasons.some((r: string) => r.startsWith(`cross:${sealedCross}:Sealed cross`))).toBe(true);
      expect(reasons.some((r: string) => r.startsWith('meteora::'))).toBe(true);
      expect(JSON.stringify(body)).not.toContain(closedCross); // a cross whose call has closed is not offered
    });

    it('a seller is ranked the other way round', async () => {
      const { body } = await get(q({ side: 'sell', amount: '1000000' }));
      const prices = body.venues.map((v: { pricePerBase: string }) => BigInt(v.pricePerBase));
      expect([...prices].sort((a, b) => (a < b ? 1 : -1))).toEqual(prices);
    });

    it('on a network other than mainnet the DEX is excluded with that reason and never called', async () => {
      const bare = await buildServer({ db, network: 'devnet', clock: () => NOW, account: async (a) => accounts.get(a) ?? null, lifetime: async () => ({ blockhash: '4NCYB3kRT8sCNodPNuCZo8VkwveZSHhg7R7mrRBFM1Uy' as never, lastValidBlockHeight: 1n }) });
      const r = await bare.inject({ method: 'GET', url: q({}) });
      const body = JSON.parse(r.body);
      expect(body.venues.map((v: { venue: string }) => v.venue)).toEqual(['cross']);
      expect(body.excluded.find((e: { venue: string }) => e.venue === 'jupiter').reason).toMatch(/mainnet liquidity only; this API follows devnet/);
      await bare.close();
    });

    it('POST /v1/route/quote answers the best-execution report the client library, the CLI and the React hook ask for', async () => {
      const r = await app.inject({ method: 'POST', url: '/v1/route/quote', payload: { cross: openCross, side: 'buy', quantity: '2000000' } });
      const body = JSON.parse(r.body);
      expect(r.statusCode).toBe(200);
      expect(body).toMatchObject({ schema: 'opening-cross/best-execution/v1', intent: { side: 'buy', quantity: '2000000', limitPrice: null } });
      expect(body.comparison.filledOnCross).toBe('2000000');
      expect(body.comparison.dexPrice).toBe('1600000');
      expect(['cross', 'dex']).toContain(body.recommendation);
      expect(body.caveats.join(' ')).toMatch(/Indicative/);
      const limited = JSON.parse((await app.inject({ method: 'POST', url: '/v1/route/quote', payload: { cross: openCross, side: 'sell', quantity: '1000000', limitPrice: '1000000' } })).body);
      expect(limited.intent).toMatchObject({ side: 'sell', limitPrice: '1000000' });
    });

    it('POST /v1/route/quote refuses a cross that is not accepting orders, and bad bodies, with the errors the client maps', async () => {
      const cleared = await liveCross({ state: CrossState.Cleared });
      const post = async (payload: unknown) => app.inject({ method: 'POST', url: '/v1/route/quote', payload: payload as never });
      expect((await post({ cross: cleared, side: 'buy', quantity: '1' })).statusCode).toBe(409);
      expect((await post({ cross: openCross, side: 'hold', quantity: '1' })).statusCode).toBe(400);
      expect((await post({ cross: openCross, side: 'buy', quantity: '0' })).statusCode).toBe(400);
      expect((await post({ cross: openCross, side: 'buy' })).statusCode).toBe(400);
      expect((await post({ cross: base, side: 'buy', quantity: '1' })).statusCode).toBe(404);
      expect((await post([])).statusCode).toBe(400);
    });

    it('validates the query before reading anything', async () => {
      const before = dexCalls;
      for (const bad of [{ base: 'x' }, { quote: 'x' }, { side: 'hold' }, { amount: '0' }, { amount: '-1' }, { amount: '1.5' }, { amount: '18446744073709551616' }, { quote: base }]) {
        expect((await get(q(bad))).status).toBe(400);
      }
      expect((await get(`/v1/router/quote?base=${base}`)).status).toBe(400);
      expect(dexCalls).toBe(before);
    });

    it('404 when a mint is missing, and an empty answer (not an error) when nothing trades the pair', async () => {
      expect((await get(q({ base: await addr() }))).status).toBe(404);
      const other = await addr();
      accounts.set(other, mintAccount(null, { decimals: 9 }));
      const { status, body } = await get(q({ quote: other }));
      expect(status).toBe(200);
      expect(body.excluded[0]).toMatchObject({ venue: 'cross', reason: 'No live cross trades this pair.' });
      expect(body.venues.map((v: { venue: string }) => v.venue)).toEqual(['jupiter']);
    });
  });
});

