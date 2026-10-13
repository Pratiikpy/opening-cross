// The three metrics routes and the per-cross fairness field, end to end over HTTP against a real Postgres schema.
// Needs DATABASE_URL (any Postgres 14+; each run uses and then drops its own schema). Without it the suite is
// skipped and says so: the pure computation is covered without a database in metrics.test.ts.
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { type Address, generateKeyPairSigner } from '@solana/kit';
import { CROSS_DISCRIMINATOR, CROSS_CORE_PROGRAM_ADDRESS, CrossState, getCrossDecoder, getCrossEncoder } from '@opening-cross/sdk';
import { migrate } from '@opening-cross/indexer';
import { buildServer } from '../src/server.js';

const url = process.env.DATABASE_URL;
if (!url) console.warn('metrics-http.test.ts SKIPPED: set DATABASE_URL to a Postgres to run the metrics route tests against a real database');

describe.skipIf(!url)('metrics routes', () => {
  const schema = `t_${randomBytes(6).toString('hex')}`;
  let admin: pg.Client;
  let db: pg.Pool;
  let app: Awaited<ReturnType<typeof buildServer>>;
  const accounts = new Map<string, Uint8Array>();
  let wallets: Address[] = [];
  let printedCross: Address;
  let noPrintCross: Address;
  let liveCross: Address;
  let reads = 0;

  const cross = async (over: Record<string, unknown>) => {
    const z = new Uint8Array(4096);
    z.set(CROSS_DISCRIMINATOR as Uint8Array, 0);
    const base = getCrossDecoder().decode(z);
    const address = (await generateKeyPairSigner()).address;
    accounts.set(address, new Uint8Array(getCrossEncoder().encode({ ...base, priceScale: 1_000_000n, quoteDecimals: 6, baseDecimals: 6, ...over } as never)));
    return address;
  };

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: url });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    db = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` });
    await migrate(db);
    wallets = await Promise.all(Array.from({ length: 8 }, async () => (await generateKeyPairSigner()).address));
    const [creator, integrator, feeRecipient] = wallets as [Address, Address, Address];
    const common = { creator, integrator, feeRecipient, proceedsTo: creator };
    printedCross = await cross({ ...common, state: CrossState.Finalized, clearing: { __option: 'Some', value: { price: 1_300_000n, matched: 1350n, demand: 1350n, supply: 1350n, rationed: 0, marginalQuantity: 0n, marginalRemaining: 0n, marginalOrders: 0 } } });
    noPrintCross = await cross({ ...common, state: CrossState.Finalized, clearing: { __option: 'None' } });
    liveCross = await cross({ ...common, state: CrossState.Live });

    const insertCross = (a: string, state: string, price: string | null) =>
      db.query(`INSERT INTO crosses (address, creator, kind, supply_mode, disclosure, base_mint, quote_mint, open_ts, close_ts, reveal_end_ts, protocol_fee_bps, integrator_fee_bps, state, clearing_price, matched, created_slot, updated_slot)
                VALUES ($1,$2,0,0,1,'B','Q',900,1000,1000,10,0,$3,$4,$5,1,1)`, [a, creator, state, price, price ? '1350' : null]);
    await insertCross(printedCross, 'Finalized', '1300000');
    await insertCross(noPrintCross, 'Finalized', null);
    await insertCross(liveCross, 'Live', null);
    let idx = 0;
    const insertOrder = (c: string, owner: string, side: number, escrow: number, price: number | null, quantity: number | null, status: string, fill: number | null, quoteOut: number | null) =>
      db.query(`INSERT INTO orders (cross_address, idx, address, owner, side, escrow, sealed, price, quantity, status, fill, quote_out, created_slot, updated_slot)
                VALUES ($1,$2,$3,$4,$5,$6,false,$7,$8,$9,$10,$11,1,1)`, [c, idx++, `o${idx}-${c}`, owner, side, escrow, price, quantity, status, fill, quoteOut]);
    // The same bids as the worked example in metrics.test.ts: improvement 3500 / 0 / 1875 bps, one priced out, one cancelled.
    await insertOrder(printedCross, wallets[3]!, 0, 2000, 2_000_000, 1000, 'claimed', 1000, 700);
    await insertOrder(printedCross, wallets[4]!, 0, 650, 1_300_000, 500, 'claimed', 250, 325);
    await insertOrder(printedCross, wallets[5]!, 0, 160, 1_600_000, 100, 'claimed', 100, 30);
    await insertOrder(printedCross, wallets[6]!, 0, 100, 1_000_000, 100, 'claimed', 0, 100);
    await insertOrder(printedCross, wallets[7]!, 0, 50, 1_500_000, 10, 'cancelled', null, null);
    await insertOrder(printedCross, creator, 1, 1350, 1_000_000, 1350, 'claimed', 1350, 1000);
    await insertOrder(noPrintCross, wallets[3]!, 0, 9, 1_000_000, 9, 'claimed', 0, 9);
    await insertOrder(liveCross, wallets[3]!, 0, 5, 1_000_000, 5, 'revealed', null, null);
    // close_ts 1000; cleared at 1010 and finalized at 1060.
    for (const [name, t] of [['CrossCleared', 1010], ['CrossFinalized', 1060]] as const) {
      await db.query(`INSERT INTO events (signature, seq, slot, block_time, name, cross_address, payload) VALUES ($1,0,1,to_timestamp($2),$3,$4,'{}')`, [`sig-${name}`, t, name, printedCross]);
    }
    app = await buildServer({
      db,
      network: 'devnet',
      ownWallets: new Set([wallets[3]!]),
      account: async (a) => {
        reads++;
        const data = accounts.get(a);
        return data ? { data, owner: CROSS_CORE_PROGRAM_ADDRESS } : null;
      },
      lifetime: async () => ({ blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 0n }) as never,
    });
  });

  afterAll(async () => {
    await app?.close();
    await db?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  it('GET /v1/metrics/execution aggregates the printed finalized crosses', async () => {
    const r = await app.inject({ method: 'GET', url: '/v1/metrics/execution' });
    expect(r.statusCode).toBe(200);
    const m = r.json();
    expect(m.network).toBe('devnet');
    expect(m.crosses).toBe(1);
    expect(m.finalizedWithoutPrint).toBe(1);
    expect(m.bids).toMatchObject({ placed: 5, filled: 3, fillRate: 0.6, fullyFilled: 2, partiallyFilled: 1, notFilledPricedOut: 1, cancelled: 1 });
    expect(m.priceImprovement).toMatchObject({ filledBids: 3, atClearingPrice: 1, bps: { median: 1875, p10: 0 }, quoteAtoms: { median: '30', p10: '0', quoteDecimals: [6] }, inconsistent: 0 });
    expect(m.refundShare.median).toBeCloseTo(1205 / 2960, 5); // escrow 2000+650+160+100+50 = 2960; returned 700+325+30+100+50 = 1205
    expect(m.closeToFinalizedSeconds).toMatchObject({ n: 1, median: 60 });
    expect(typeof m.method).toBe('string');
  });

  it('GET /v1/metrics/fairness gives per-cross and aggregate figures and validates its parameter', async () => {
    const m = (await app.inject({ method: 'GET', url: '/v1/metrics/fairness' })).json();
    expect(m.crosses).toBe(1);
    expect(m.perCross).toHaveLength(1);
    expect(m.perCross[0]).toMatchObject({ address: printedCross, bidders: 5, sellers: 1, wallets: 6, identity: { count: 5, basis: 'wallets, not people', gated: false } });
    // fills 1000 / 250 / 100 of 1350: the largest buyer took 1000/1350
    expect(m.perCross[0].buy.top1).toBeCloseTo(1000 / 1350, 5);
    expect(m.topBuyerAboveThreshold).toMatchObject({ k: 1, n: 1, proportion: 1 });
    expect((await app.inject({ method: 'GET', url: '/v1/metrics/fairness?threshold=2' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/v1/metrics/fairness?threshold=abc' })).statusCode).toBe(400);
  });

  it('GET /v1/metrics/external-flow excludes OWN_WALLETS and each cross\'s creator and integrator', async () => {
    const m = (await app.inject({ method: 'GET', url: '/v1/metrics/external-flow' })).json();
    expect(m.ownWalletsConfigured).toBe(1);
    // wallets: 3 (own list), 4, 5, 6, 7 and the creator (seller). The creator is own on every cross it appears in; wallets 4-7 are external.
    expect(m.wallets).toMatchObject({ total: 6, own: 2, external: 4 });
    expect(m.crosses.withOrders).toBe(3);
    expect(m.verdict).toBe('external wallets seen, not known to be ours (upper bound on outside users)');
  });

  it('GET /v1/crosses/:address carries the cross\'s fairness once finalized and a null before', async () => {
    const done = (await app.inject({ method: 'GET', url: `/v1/crosses/${printedCross}` })).json();
    expect(done.state).toBe('Finalized');
    expect(done.fairness).toMatchObject({ address: printedCross, bidders: 5 });
    expect(done.orders).toBeDefined(); // existing fields are untouched
    const live = (await app.inject({ method: 'GET', url: `/v1/crosses/${liveCross}` })).json();
    expect(live.fairness).toBeNull();
    expect((await app.inject({ method: 'GET', url: `/v1/crosses/${noPrintCross}` })).json().fairness).toBeNull();
  });

  it('serves repeat requests from its 15 second cache and the chain statics from memory', async () => {
    await app.inject({ method: 'GET', url: '/v1/metrics/execution' });
    const before = reads;
    await app.inject({ method: 'GET', url: '/v1/metrics/execution' });
    await app.inject({ method: 'GET', url: '/v1/metrics/external-flow' });
    expect(reads).toBe(before);
  });
});
