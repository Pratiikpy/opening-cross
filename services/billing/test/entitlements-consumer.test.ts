// Row Y8: the keeper's scheduler reads the issuer's subscription from this service. The keeper's own client (services/keeper/src/entitlements.ts) is pointed at the billing
// routes, listening on a real port over a real Postgres engine, and a payment is made the way a subscriber makes one: the transaction is read back from the chain double, the
// period is recorded, and the next question the keeper asks is answered "entitled". The route tests that need Postgres run only when DATABASE_URL is set, like billing.test.ts.
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import Fastify, { type FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateKeyPairSigner } from '@solana/kit';
import { migrate } from '@opening-cross/indexer';
import { billingEntitlements, parseEntitlement } from '../../keeper/src/entitlements.js';
import { type BillingChain, MEMO_PREFIX, type ParsedTransaction } from '../src/chain.js';
import { registerBilling } from '../src/routes.js';

const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const REVENUE = 'DTB3Jtxb6dy7GvocUbypiJb548ZLGRzVdPrNNCWAKEdC';
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
// Fresh issuers and signatures per run: against a database that is not isolated by schema, another file's rows must not be this file's.
const [PAID, UNPAID, SHORT, AHEAD] = (await Promise.all([1, 2, 3, 4].map(async () => (await generateKeyPairSigner()).address as string))) as [string, string, string, string];
const sigs = new Map<number, string>();
const sig = (n: number): string => {
  if (!sigs.has(n)) sigs.set(n, Array.from(randomBytes(88), (b) => '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'[b % 58]).join(''));
  return sigs.get(n)!;
};

const payment = (o: { issuer: string; amount?: string; blockTime: number }): ParsedTransaction => ({
  slot: 77,
  blockTime: o.blockTime,
  meta: {
    err: null,
    preTokenBalances: [{ accountIndex: 3, mint: MINT, owner: REVENUE, uiTokenAmount: { amount: '5000000' } }],
    postTokenBalances: [{ accountIndex: 3, mint: MINT, owner: REVENUE, uiTokenAmount: { amount: String(5_000_000n + BigInt(o.amount ?? '99000000')) } }],
    innerInstructions: [],
  },
  transaction: {
    message: {
      accountKeys: [{ pubkey: o.issuer }, { pubkey: 'FromAta' }, { pubkey: MINT }, { pubkey: 'RevenueAta' }],
      instructions: [
        { program: 'spl-token', parsed: { type: 'transferChecked', info: { source: 'FromAta', destination: 'RevenueAta', mint: MINT, authority: o.issuer, tokenAmount: { amount: o.amount ?? '99000000' } } } },
        { program: 'spl-memo', parsed: `${MEMO_PREFIX}recurring-starter` },
      ],
    },
  },
});

const databaseUrl = process.env.DATABASE_URL;
const describeDb = databaseUrl ? describe : describe.skip;
if (!databaseUrl) console.warn('entitlements-consumer.test.ts: SKIPPED; set DATABASE_URL to a Postgres to run it');

describeDb('the keeper reads entitlements from the billing routes', () => {
  let db: pg.Pool;
  let drop: () => Promise<void>;
  let app: FastifyInstance;
  let url = '';
  const txs = new Map<string, ParsedTransaction>();
  const wall = Math.floor(Date.now() / 1000);
  let clock = wall;

  beforeAll(async () => {
    const schema = `t_${randomBytes(6).toString('hex')}`;
    const admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    db = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
    await migrate(db);
    drop = async () => {
      await db.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    };
    const chain: BillingChain = { mint: async () => ({ tokenProgram: TOKEN, decimals: 6 }), latestBlockhash: async () => ({ blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 1n }), transaction: async (s) => txs.get(s) ?? null };
    app = Fastify();
    registerBilling(app, { db }, { mint: MINT, revenueWallet: REVENUE, chain, signer: null, clock: () => clock });
    await app.listen({ port: 0, host: '127.0.0.1' });
    url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await app.close();
    await drop();
  });

  const report = async (n: number) => (await fetch(`${url}/v1/billing/payments`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ signature: sig(n) }) })).status;
  // A fresh client each time: the answers it keeps are the keeper's concern (its own tests), not this one's.
  const ask = (issuer: string) => billingEntitlements({ baseUrl: url })(issuer as never);

  it('an issuer who has not paid is not entitled, and the answer is one the keeper accepts', async () => {
    const raw = await (await fetch(`${url}/v1/billing/entitlements/${UNPAID}`)).json();
    expect(() => parseEntitlement(raw)).not.toThrow();
    expect(await ask(UNPAID)).toEqual({ entitled: false, plan: null, periodEnd: null, crossesIncluded: 0, crossesUsed: 0 });
  });

  it('after a subscription payment is read back from the chain the keeper is told: entitled, for the plan, until the end of the 30-day period', async () => {
    txs.set(sig(1), payment({ issuer: PAID, blockTime: wall }));
    expect(await report(1)).toBe(201);
    expect(await ask(PAID)).toEqual({ entitled: true, plan: 'recurring-starter', periodEnd: wall + 30 * 86_400, crossesIncluded: 4, crossesUsed: 0 });
  });

  it('a payment below the plan price buys nothing, and the keeper is told so', async () => {
    txs.set(sig(2), payment({ issuer: SHORT, amount: '98999999', blockTime: wall }));
    expect(await report(2)).toBe(201); // recorded, and listed as rejected
    expect((await ask(SHORT)).entitled).toBe(false);
  });

  it('an issuer whose payment block time is ahead of this machine\'s clock is entitled at once, not after the clock catches up', async () => {
    txs.set(sig(3), payment({ issuer: AHEAD, blockTime: wall + 45 }));
    await report(3);
    expect(await ask(AHEAD)).toMatchObject({ entitled: true, periodEnd: wall + 45 + 30 * 86_400 });
  });

  it('counts the recurring crosses created in the period against those included, which the keeper can see', async () => {
    for (let i = 0; i < 5; i++) {
      await db.query(
        `INSERT INTO crosses (address, creator, kind, supply_mode, disclosure, base_mint, quote_mint, open_ts, close_ts, reveal_end_ts, protocol_fee_bps, integrator_fee_bps, state, created_slot, updated_slot)
         VALUES ($1,$2,3,0,1,'b','q',$3,$3,$3,5,0,'Finalized',1,1)`,
        [`consumer-cross-${PAID.slice(0, 8)}-${i}`, PAID, wall + (i + 1) * 3600],
      );
    }
    expect(await ask(PAID)).toMatchObject({ entitled: true, crossesIncluded: 4, crossesUsed: 5 });
  });

  it('counts the crosses a series of the issuer spawned, whatever their kind: the address of the series is their creator, not the wallet of the issuer', async () => {
    const issuer = (await generateKeyPairSigner()).address as string;
    const [series, otherSeries, stranger] = (await Promise.all([1, 2, 3].map(async () => (await generateKeyPairSigner()).address as string))) as [string, string, string];
    txs.set(sig(10), payment({ issuer, blockTime: wall }));
    await report(10);
    await db.query('INSERT INTO series (address, authority, created_slot) VALUES ($1,$2,1), ($3,$4,2)', [series, issuer, otherSeries, stranger]);
    const cross = (name: string, creator: string, kind: number, openTs: number) =>
      db.query(
        `INSERT INTO crosses (address, creator, kind, supply_mode, disclosure, base_mint, quote_mint, open_ts, close_ts, reveal_end_ts, protocol_fee_bps, integrator_fee_bps, state, created_slot, updated_slot)
         VALUES ($1,$2,$3,0,1,'b','q',$4,$4,$4,5,0,'Finalized',1,1)`,
        [`${name}-${issuer.slice(0, 8)}`, creator, kind, openTs],
      );
    await cross('spawned-1', series, 1, wall + 3_600); // a series of reopens
    await cross('spawned-2', series, 3, wall + 7_200); // a series of recurring crosses
    await cross('spawned-3', series, 1, wall + 10_800);
    await cross('direct', issuer, 3, wall + 14_400); // created by the wallet, recurring kind
    await cross('direct-launch', issuer, 0, wall + 18_000); // a launch is not a recurring cross
    await cross('before-period', series, 1, wall - 86_400);
    await cross('after-period', series, 1, wall + 31 * 86_400);
    await cross('another-issuer', otherSeries, 1, wall + 3_600);
    expect(await ask(issuer)).toMatchObject({ entitled: true, crossesIncluded: 4, crossesUsed: 4 });
    const over = await (await fetch(`${url}/v1/billing/entitlements/${issuer}`)).json();
    expect(over).toMatchObject({ crossesUsed: 4, crossesOverIncluded: 0 });
    await cross('spawned-4', series, 1, wall + 21_600);
    expect(await (await fetch(`${url}/v1/billing/entitlements/${issuer}`)).json()).toMatchObject({ crossesUsed: 5, crossesOverIncluded: 1 });
  });

  it('when the period ends the keeper is told the issuer is no longer entitled, unless a second payment extended it', async () => {
    clock = wall + 31 * 86_400;
    expect((await ask(PAID)).entitled).toBe(false); // one period paid, 31 days on
    clock = wall;
    txs.set(sig(4), payment({ issuer: PAID, blockTime: wall + 60 }));
    await report(4);
    // Paid early, the second period begins where the first ends: today's answer still names the first period...
    expect(await ask(PAID)).toMatchObject({ entitled: true, periodEnd: wall + 30 * 86_400 });
    // ...and 31 days on the issuer is covered by the second.
    clock = wall + 31 * 86_400;
    expect(await ask(PAID)).toMatchObject({ entitled: true, periodEnd: wall + 60 * 86_400 });
    clock = wall + 61 * 86_400;
    expect((await ask(PAID)).entitled).toBe(false);
    clock = wall;
  });

  it('a malformed issuer address is a 400 the keeper reports as an error, never as "not entitled"', async () => {
    const res = await fetch(`${url}/v1/billing/entitlements/not-an-address`);
    expect(res.status).toBe(400);
    await expect(ask('not-an-address')).rejects.toThrow(/billing service answered 400/);
  });
});
