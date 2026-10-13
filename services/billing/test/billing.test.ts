import Fastify, { type FastifyInstance } from 'fastify';
import pg from 'pg';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateKeyPair, getAddressFromPublicKey, getBase64Encoder, getCompiledTransactionMessageDecoder, getTransactionDecoder, generateKeyPairSigner } from '@solana/kit';
import { MEMO_PROGRAM_ADDRESS } from '@solana-program/memo';
import { verifyDocument } from '@opening-cross/attest';
import { PROPOSED_RATE_CARD } from '@opening-cross/fees';
import { migrate } from '@opening-cross/indexer';
import { type BillingChain, MEMO_PREFIX, type ParsedTransaction, BillingError, buildSubscriptionTx, readPayment } from '../src/chain.js';
import { registerBilling } from '../src/routes.js';

const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const REVENUE = 'DTB3Jtxb6dy7GvocUbypiJb548ZLGRzVdPrNNCWAKEdC';
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const ISSUER = 'HjSYwwj6byv2KbUGHucjxhs1UJWPmzud6fRkB5GZRa8k';
const SIG = 'S'.repeat(88);

const payment = (over: { amount?: string; memo?: string | null; err?: unknown; issuer?: string; blockTime?: number | null; mint?: string; owner?: string } = {}): ParsedTransaction => ({
  slot: 77,
  blockTime: over.blockTime === undefined ? 1_800_000_000 : over.blockTime,
  meta: {
    err: over.err ?? null,
    preTokenBalances: [{ accountIndex: 3, mint: MINT, owner: over.owner ?? REVENUE, uiTokenAmount: { amount: '5000000' } }],
    postTokenBalances: [{ accountIndex: 3, mint: over.mint ?? MINT, owner: over.owner ?? REVENUE, uiTokenAmount: { amount: String(5_000_000n + BigInt(over.amount ?? '99000000')) } }],
    innerInstructions: [],
  },
  transaction: {
    message: {
      accountKeys: [{ pubkey: over.issuer ?? ISSUER }, { pubkey: 'FromAta' }, { pubkey: MINT }, { pubkey: 'RevenueAta' }],
      instructions: [
        { program: 'spl-token', parsed: { type: 'transferChecked', info: { source: 'FromAta', destination: 'RevenueAta', mint: MINT, authority: over.issuer ?? ISSUER, tokenAmount: { amount: over.amount ?? '99000000' } } } },
        ...(over.memo === null ? [] : [{ program: 'spl-memo', parsed: over.memo ?? `${MEMO_PREFIX}recurring-starter` }]),
      ],
    },
  },
});

describe('readPayment', () => {
  const c = { mint: MINT, revenueWallet: REVENUE };
  it('reads the payer, the plan and the amount from the transaction itself', async () => {
    expect(await readPayment(payment(), SIG, c)).toEqual({ signature: SIG, issuer: ISSUER, plan: 'recurring-starter', amountUnits: 99_000_000n, paidAt: 1_800_000_000, slot: 77 });
  });
  it('refuses what is not a subscription payment, and says why', async () => {
    const why = async (tx: ParsedTransaction | null) => readPayment(tx, SIG, c).then(() => 'ACCEPTED', (e: unknown) => (e as BillingError).message);
    expect(await why(null)).toMatch(/no such transaction/);
    expect(await why(payment({ err: { InstructionError: [0, 'x'] } }))).toMatch(/failed on chain/);
    expect(await why(payment({ memo: null }))).toMatch(/no "oc-sub:1:<plan>" memo/);
    expect(await why(payment({ mint: 'OtherMint' }))).toMatch(/did not move/);
    expect(await why(payment({ owner: 'SomeoneElse' }))).toMatch(/did not move/);
    expect(await why(payment({ amount: '0' }))).toMatch(/received nothing/);
    expect(await why(payment({ blockTime: null }))).toMatch(/no block time/);
    expect(await why({ ...payment(), meta: null })).toMatch(/no metadata/);
  });
  it('takes the amount from the revenue account\'s balance, not from the instruction a request names', async () => {
    const tx = payment({ amount: '99000000' });
    (tx.transaction.message.instructions[0] as { parsed: { info: { tokenAmount: { amount: string } } } }).parsed.info.tokenAmount.amount = '999999999'; // a lie in the instruction text
    expect((await readPayment(tx, SIG, c)).amountUnits).toBe(99_000_000n);
  });
});

describe('buildSubscriptionTx', () => {
  it('builds one unsigned transaction the issuer alone signs: create the revenue account if needed, transfer the price, record the plan', async () => {
    const issuer = (await generateKeyPairSigner()).address;
    const chain: BillingChain = { mint: async () => ({ tokenProgram: TOKEN, decimals: 6 }), latestBlockhash: async () => ({ blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 99n }), transaction: async () => null };
    const t = await buildSubscriptionTx(chain, { plan: 'recurring-starter', priceUnits: 99_000_000n, issuer, mint: (await generateKeyPairSigner()).address, revenueWallet: (await generateKeyPairSigner()).address });
    expect(t.memo).toBe('oc-sub:1:recurring-starter');
    const tx = getTransactionDecoder().decode(getBase64Encoder().encode(t.transaction));
    const msg = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
    expect(msg.header.numSignerAccounts).toBe(1);
    expect(msg.staticAccounts[0]).toBe(issuer);
    expect((msg as unknown as { instructions: unknown[] }).instructions).toHaveLength(3);
    expect(msg.staticAccounts).toContain(TOKEN);
    expect(msg.staticAccounts).toContain(MEMO_PROGRAM_ADDRESS);
    expect(Object.values(tx.signatures).every((s) => s === null)).toBe(true);
  });
  it('refuses a mint that does not exist', async () => {
    const chain: BillingChain = { mint: async () => null, latestBlockhash: async () => ({ blockhash: 'x', lastValidBlockHeight: 1n }), transaction: async () => null };
    await expect(buildSubscriptionTx(chain, { plan: 'p', priceUnits: 1n, issuer: ISSUER, mint: MINT, revenueWallet: REVENUE })).rejects.toThrow(/does not exist/);
  });
});

const databaseUrl = process.env.DATABASE_URL;
const describeDb = databaseUrl ? describe : describe.skip;
if (!databaseUrl) console.warn('billing.test.ts: route tests SKIPPED; set DATABASE_URL to a Postgres to run them');

describeDb('billing routes', () => {
  let db: pg.Pool;
  let drop: () => Promise<void>;
  let app: FastifyInstance;
  let noSigner: FastifyInstance;
  let signerAddress = '';
  const txs = new Map<string, ParsedTransaction>();
  let clock = 1_800_000_100;

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
    const kp = await generateKeyPair();
    signerAddress = await getAddressFromPublicKey(kp.publicKey);
    const chain: BillingChain = { mint: async () => ({ tokenProgram: TOKEN, decimals: 6 }), latestBlockhash: async () => ({ blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 1n }), transaction: async (s) => txs.get(s) ?? null };
    const mk = (signer: { keyPair: CryptoKeyPair; address: string } | null) => {
      const a = Fastify();
      registerBilling(a, { db }, { mint: MINT, revenueWallet: REVENUE, chain, signer, clock: () => clock });
      return a;
    };
    app = mk({ keyPair: kp, address: signerAddress });
    noSigner = mk(null);
    await app.ready();
    await noSigner.ready();
  });
  afterAll(async () => {
    await app.close();
    await noSigner.close();
    await drop();
  });

  const call = async (method: 'GET' | 'POST', url: string, payload?: unknown, a = app) => {
    const r = await a.inject({ method, url, ...(payload === undefined ? {} : { payload: payload as never }) });
    return { status: r.statusCode, body: r.json() };
  };
  const sig = (n: number) => String(n).repeat(88).slice(0, 88).replace(/0/g, '1');

  it('lists plans with the honest status of the prices', async () => {
    const r = await call('GET', '/v1/billing/plans');
    expect(r.body.plans.map((p: { plan: string }) => p.plan)).toEqual(['recurring-starter', 'recurring-weekly']);
    expect(r.body.plans[0].price).toBe('99.00 USDC');
    expect(r.body.status).toMatch(/proposals/);
    expect(r.body.invoiceSigner).toBe(signerAddress);
  });

  it('builds a payment for a plan and refuses a plan or issuer that does not exist', async () => {
    const issuer = (await generateKeyPairSigner()).address;
    const ok = await call('POST', '/v1/billing/subscribe', { plan: 'recurring-weekly', issuer });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ plan: 'recurring-weekly', price: '399.00 USDC', memo: 'oc-sub:1:recurring-weekly' });
    expect((await call('POST', '/v1/billing/subscribe', { plan: 'gold', issuer })).status).toBe(400);
    expect((await call('POST', '/v1/billing/subscribe', { plan: 'recurring-weekly', issuer: 'nope' })).status).toBe(400);
  });

  it('records a payment once, buys one period, and extends it when paid again early', async () => {
    txs.set(sig(1), payment());
    const first = await call('POST', '/v1/billing/payments', { signature: sig(1) });
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ recorded: true, fresh: true, buys: 'one 30-day period of recurring-starter' });
    expect(first.body.entitlement).toMatchObject({ entitled: true, crossesIncluded: 4, crossesUsed: 0, current: { plan: 'recurring-starter', start: 1_800_000_000, end: 1_800_000_000 + 30 * 86_400 } });
    const again = await call('POST', '/v1/billing/payments', { signature: sig(1) });
    expect(again.status).toBe(200);
    expect(again.body.fresh).toBe(false);
    expect(again.body.entitlement.periods).toHaveLength(1);
    txs.set(sig(2), { ...payment(), blockTime: 1_800_000_050 });
    const second = await call('POST', '/v1/billing/payments', { signature: sig(2) });
    expect(second.body.entitlement.periods).toHaveLength(2);
    expect(second.body.entitlement.periods[1].start).toBe(1_800_000_000 + 30 * 86_400);
  });

  it('a payment below the price, for a plan that does not exist, or by nobody known buys nothing and is listed', async () => {
    const payer = 'ESbKzKFcLz4g5m4rhzSHk9YHCT6skkEZgmEPZa9kAUfm';
    txs.set(sig(3), payment({ amount: '98999999', issuer: payer }));
    const low = await call('POST', '/v1/billing/payments', { signature: sig(3) });
    expect(low.body.buys).toMatch(/^nothing: .* is below the 99.00 USDC price/);
    expect(low.body.entitlement).toMatchObject({ entitled: false });
    expect(low.body.entitlement.rejectedPayments[0]).toMatchObject({ reason: 'below the plan price' });
    txs.set(sig(4), payment({ memo: `${MEMO_PREFIX}platinum`, issuer: payer }));
    expect((await call('POST', '/v1/billing/payments', { signature: sig(4) })).body.buys).toBe('nothing: no such plan');
  });

  it('is entitled at once even when the chain block time is ahead of this machine clock', async () => {
    const early = 'Ao9ZJvc133Ui22aKTfSvoP5WdEVJxF25ns25uL1ipaFc';
    txs.set(sig(7), { ...payment({ issuer: early }), blockTime: 1_800_000_100 + 30 });
    const r = await call('POST', '/v1/billing/payments', { signature: sig(7) });
    expect(r.body.entitlement).toMatchObject({ entitled: true, current: { start: 1_800_000_130 } });
    expect((await call('GET', `/v1/billing/entitlements/${early}`)).body.entitled).toBe(true);
    expect((await call('GET', `/v1/billing/entitlements/${early}?at=1800000100`)).body.entitled).toBe(false); // asked for a time before the period began
  });

  it('refuses a signature the cluster does not know, one that is not a payment, and junk', async () => {
    expect((await call('POST', '/v1/billing/payments', { signature: sig(5) })).status).toBe(404);
    txs.set(sig(6), payment({ memo: null }));
    expect((await call('POST', '/v1/billing/payments', { signature: sig(6) })).status).toBe(422);
    expect((await call('POST', '/v1/billing/payments', { signature: 'x' })).status).toBe(400);
    expect((await call('POST', '/v1/billing/payments', {})).status).toBe(400);
  });

  it('counts the recurring crosses created in the paid period, and invoices the overage', async () => {
    for (let i = 0; i < 6; i++) {
      await db.query(
        `INSERT INTO crosses (address, creator, kind, supply_mode, disclosure, base_mint, quote_mint, open_ts, close_ts, reveal_end_ts, protocol_fee_bps, integrator_fee_bps, state, created_slot, updated_slot)
         VALUES ($1,$2,$3,0,1,'b','q',$4,$4,$4,5,0,'Finalized',1,1)`,
        [`cross${i}`, ISSUER, i === 5 ? 1 : 3, 1_800_000_000 + (i + 1) * 3600], // five recurring in the period (the sixth is another kind)
      );
    }
    const e = await call('GET', `/v1/billing/entitlements/${ISSUER}?at=1800000100`);
    expect(e.body).toMatchObject({ entitled: true, crossesUsed: 5, crossesIncluded: 4, crossesOverIncluded: 1 });
  });

  it('issues a signed invoice, keeps it only when the period is over, and never issues an unsigned one', async () => {
    const open = await call('POST', '/v1/billing/invoices', { issuer: ISSUER, at: 1_800_000_100 });
    expect(open.status).toBe(200);
    expect(open.body).toMatchObject({ kept: false, signer: signerAddress, body: { plan: 'recurring-starter', final: false, crossesUsed: 5, totalUnits: '124000000', paidUnits: '99000000', dueUnits: '25000000', currency: 'USDC' } });
    expect((await verifyDocument(open.body)).ok).toBe(true);
    expect(open.body.body.lines.map((l: { description: string }) => l.description)).toEqual(['recurring-starter, 30 days, 4 crosses included', 'crosses beyond the plan']);
    expect((await call('GET', `/v1/billing/invoices/${ISSUER}`)).body.invoices).toHaveLength(0);
    clock = 1_800_000_000 + 31 * 86_400;
    const done = await call('POST', '/v1/billing/invoices', { issuer: ISSUER, at: 1_800_000_100 });
    expect(done.body).toMatchObject({ kept: true, body: { final: true } });
    expect((await call('GET', `/v1/billing/invoices/${ISSUER}`)).body.invoices).toHaveLength(1);
    // Issued again, a finished period is the same signed document and is kept once.
    const twice = await call('POST', '/v1/billing/invoices', { issuer: ISSUER, at: 1_800_000_100 });
    expect(twice.body.id).toBe(done.body.id);
    expect((await call('GET', `/v1/billing/invoices/${ISSUER}`)).body.invoices).toHaveLength(1);

    expect((await call('POST', '/v1/billing/invoices', { issuer: ISSUER }, noSigner)).status).toBe(409);
    expect((await call('POST', '/v1/billing/invoices', { issuer: 'Ao9ZJvc133Ui22aKTfSvoP5WdEVJxF25ns25uL1ipaFc' })).status).toBe(404);
  });
});
