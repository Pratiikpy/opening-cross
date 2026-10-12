// Real payments, end to end, against a solana-test-validator: a real mint and token accounts, a payer, a fee payer, a
// Postgres ledger and a Fastify route behind the gate. Every state a buyer or an attacker can put a payment in is
// driven, and every outcome is read back from the chain (token balances, fee payer lamports, signature status), not
// from the HTTP answer alone. The suite skips itself when no validator answers on X402_TEST_RPC (default 127.0.0.1:8940).
import { randomBytes } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import pg from 'pg';
import { type Address, type KeyPairSigner, generateKeyPairSigner } from '@solana/kit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildExactPayment } from '../src/client.js';
import { decodeBase64Json, encodeBase64Json } from '../src/codec.js';
import { LocalFacilitator, type Facilitator } from '../src/facilitator.js';
import { registerPaidRoute } from '../src/fastify.js';
import { X402Gate, requestKeyOf } from '../src/gate.js';
import { PaymentLedger, migrate } from '../src/ledger.js';
import { createPayFetch } from '../src/pay-fetch.js';
import { decodeReceipt, encodeCredential, parseChallenges } from '../src/mpp-wire.js';
import { networkOf } from '../src/network.js';
import type { PaymentPayload, PaymentRequired, SettleResponse } from '../src/types.js';
import { airdrop, chainUp, createAta, createMint, lamportBalance, mintTo, rpc, tokenBalance, TOKEN_2022_PROGRAM_ADDRESS, TOKEN_PROGRAM_ADDRESS } from './chain.js';
import { paymentTransaction } from './tx-builders.js';

const up = await chainUp();
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://postgres:oc@localhost:55432/postgres';
const PRICE = 10_000n;

class Down implements Facilitator {
  broken = false;
  constructor(private readonly inner: Facilitator) {}
  private guard() {
    if (this.broken) throw new Error('facilitator unreachable');
  }
  async supported() {
    this.guard();
    return this.inner.supported();
  }
  async verify(p: PaymentPayload, r: PaymentPayload['accepted'], o?: Parameters<Facilitator['verify']>[2]) {
    this.guard();
    return this.inner.verify(p, r, o);
  }
  async settle(p: PaymentPayload, r: PaymentPayload['accepted'], h?: Parameters<Facilitator['settle']>[2]) {
    this.guard();
    return this.inner.settle(p, r, h);
  }
  settlementStatus(sig: string) {
    return this.inner.settlementStatus!(sig);
  }
}

type World = {
  tokenProgram: Address;
  mint: KeyPairSigner;
  payer: KeyPairSigner;
  recipient: KeyPairSigner;
  feePayer: KeyPairSigner;
  authority: KeyPairSigner;
  db: pg.Pool;
  ledger: PaymentLedger;
  facilitator: Down;
  gate: X402Gate;
  app: FastifyInstance;
  clock: { offset: number };
  events: string[];
};

async function world(tokenProgram: Address): Promise<World> {
  const [payer, recipient, feePayer, authority] = await Promise.all([generateKeyPairSigner(), generateKeyPairSigner(), generateKeyPairSigner(), generateKeyPairSigner()]);
  await Promise.all([airdrop(payer.address, 2), airdrop(feePayer.address, 2), airdrop(authority.address, 2)]);
  const mint = await createMint(authority, authority.address, 6, tokenProgram);
  await mintTo(authority, authority, mint.address, payer.address, 1_000_000n, tokenProgram);
  await createAta(authority, recipient.address, mint.address, tokenProgram);

  const schema = `t_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ connectionString: DATABASE_URL });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.end();
  const db = new pg.Pool({ connectionString: DATABASE_URL, options: `-c search_path=${schema}` });
  await migrate(db);
  const ledger = new PaymentLedger(db);

  const inner = new LocalFacilitator({ rpc, network: await networkOf(rpc), signers: [feePayer], policy: { payTo: [recipient.address], assets: [mint.address] }, pollMs: 100, confirmTimeoutMs: 30_000 });
  const facilitator = new Down(inner);
  const clock = { offset: 0 };
  const events: string[] = [];
  const gate = new X402Gate({
    facilitator,
    ledger,
    network: await networkOf(rpc),
    asset: mint.address,
    payTo: recipient.address,
    secret: randomBytes(32),
    mpp: { realm: 'api.test', network: 'localnet', decimals: 6, tokenProgram },
    now: () => Date.now() + clock.offset,
    onEvent: (e) => events.push(e.type + (e.reason ? `:${e.reason}` : '')),
  });

  const app = Fastify();
  registerPaidRoute(app, gate, {
    method: 'GET',
    url: '/paid/echo/:n',
    description: 'Squares a number',
    prepare: async (req) => {
      const n = Number((req.params as { n: string }).n);
      if (!Number.isInteger(n) || n < 1 || n > 100) throw Object.assign(new Error('n must be an integer from 1 to 100'), { statusCode: 400 });
      return {
        amount: PRICE,
        preview: async () => ({ n, note: 'the paid response adds the square' }),
        full: async () => {
          if (n === 13) throw new Error('the resource failed after the payment was verified');
          return { n, square: n * n };
        },
      };
    },
  });
  await app.ready();
  return { tokenProgram, mint, payer, recipient, feePayer, authority, db, ledger, facilitator, gate, app, clock, events };
}

async function challenge(w: World, url: string): Promise<{ required: PaymentRequired; body: Record<string, unknown>; headers: Record<string, unknown> }> {
  const res = await w.app.inject({ method: 'GET', url });
  expect(res.statusCode).toBe(402);
  const required = decodeBase64Json(res.headers['payment-required'] as string, 'PAYMENT-REQUIRED') as PaymentRequired;
  return { required, body: res.json(), headers: res.headers };
}

async function pay(w: World, required: PaymentRequired, url: string, variant: Parameters<typeof paymentTransaction>[2] = {}, signer = w.payer): Promise<string> {
  const accepted = required.accepts[0]!;
  if (Object.keys(variant).length === 0) {
    const payload = await buildExactPayment({ rpc, signer, requirements: accepted, resource: { ...required.resource, url } });
    return encodeBase64Json(payload);
  }
  const { value: lifetime } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send();
  const parties = { payer: signer, feePayer: w.feePayer, mint: w.mint, recipient: w.recipient };
  const { base64 } = await paymentTransaction(parties, accepted, { tokenProgram: w.tokenProgram, lifetime: lifetime as never, ...variant });
  return encodeBase64Json({ x402Version: 2, accepted, payload: { transaction: base64 } });
}

const get = (w: World, url: string, payment?: string) => w.app.inject({ method: 'GET', url, headers: payment ? { 'payment-signature': payment } : {} });
const rows = async (w: World, sql: string) => (await w.db.query(sql)).rows as Record<string, unknown>[];

describe.skipIf(!up).each([
  ['SPL Token', TOKEN_PROGRAM_ADDRESS],
  ['Token-2022', TOKEN_2022_PROGRAM_ADDRESS],
])('x402 exact on %s', (_name, tokenProgram) => {
  let w: World;
  beforeAll(async () => {
    w = await world(tokenProgram);
  }, 120_000);
  afterAll(async () => {
    await w?.app.close();
    await w?.db.end();
  });

  it('answers an unpaid call with the requirements, a real sample and how to pay, and moves nothing', async () => {
    const before = [await tokenBalance(w.payer.address, w.mint.address, tokenProgram), await tokenBalance(w.recipient.address, w.mint.address, tokenProgram)];
    const { required, body, headers } = await challenge(w, '/paid/echo/7');
    const a = required.accepts[0]!;
    expect(a).toMatchObject({ scheme: 'exact', amount: PRICE.toString(), asset: w.mint.address, payTo: w.recipient.address, maxTimeoutSeconds: 60 });
    expect(a.network).toBe(await networkOf(rpc));
    expect(a.extra.feePayer).toBe(w.feePayer.address);
    expect(a.extra.memo).toMatch(/^oc1\./);
    expect(body.preview).toEqual({ n: 7, note: 'the paid response adds the square' });
    expect(String(body.howToPay)).toContain('PAYMENT-SIGNATURE');
    expect(headers['cache-control']).toBe('no-store');
    expect(await tokenBalance(w.payer.address, w.mint.address, tokenProgram)).toBe(before[0]);
    expect(await tokenBalance(w.recipient.address, w.mint.address, tokenProgram)).toBe(before[1]);
    expect(await rows(w, 'SELECT 1 FROM x402_attempts')).toHaveLength(0);
  });

  it('gives each unpaid call its own memo', async () => {
    const a = (await challenge(w, '/paid/echo/7')).required.accepts[0]!.extra.memo;
    const b = (await challenge(w, '/paid/echo/7')).required.accepts[0]!.extra.memo;
    expect(a).not.toBe(b);
  });

  it('refuses junk input with a 4xx and never offers a payment', async () => {
    for (const url of ['/paid/echo/abc', '/paid/echo/0', '/paid/echo/101', '/paid/echo/1.5', '/paid/echo/-3']) {
      const res = await get(w, url);
      expect(res.statusCode, url).toBe(400);
      expect(res.headers['payment-required'], url).toBeUndefined();
    }
    expect(await rows(w, 'SELECT 1 FROM x402_attempts')).toHaveLength(0);
  });

  it('sells the response for exactly the price, settles on chain and records the payment', async () => {
    const { required } = await challenge(w, '/paid/echo/9');
    const payment = await pay(w, required, '/paid/echo/9');
    const payerBefore = await tokenBalance(w.payer.address, w.mint.address, tokenProgram);
    const recipientBefore = await tokenBalance(w.recipient.address, w.mint.address, tokenProgram);
    const feeBefore = await lamportBalance(w.feePayer.address);

    const res = await get(w, '/paid/echo/9', payment);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ n: 9, square: 81 });
    const settled = decodeBase64Json(res.headers['payment-response'] as string, 'PAYMENT-RESPONSE') as SettleResponse;
    expect(settled).toMatchObject({ success: true, network: required.accepts[0]!.network, payer: w.payer.address });
    expect(settled.transaction).toMatch(/^[1-9A-HJ-NP-Za-km-z]{80,90}$/);

    // The chain, not the response, is the proof.
    expect(payerBefore - (await tokenBalance(w.payer.address, w.mint.address, tokenProgram))).toBe(PRICE);
    expect((await tokenBalance(w.recipient.address, w.mint.address, tokenProgram)) - recipientBefore).toBe(PRICE);
    const feeSpent = feeBefore - (await lamportBalance(w.feePayer.address));
    expect(feeSpent).toBeGreaterThanOrEqual(10_000n);
    expect(feeSpent).toBeLessThan(10_100n);
    const status = (await rpc.getSignatureStatuses([settled.transaction as never]).send()).value[0];
    expect(status?.err).toBeNull();
    expect(['confirmed', 'finalized']).toContain(status?.confirmationStatus);

    const payments = await rows(w, 'SELECT * FROM x402_payments');
    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({ signature: settled.transaction, payer: w.payer.address, route: '/paid/echo/:n', amount: PRICE.toString(), mint: w.mint.address, pay_to: w.recipient.address, protocol: 'x402' });
    expect(payments[0]!.request_hash).toBe(requestKeyOf({ method: 'GET', path: '/paid/echo/9', query: {} }));
    await new Promise((r) => setTimeout(r, 200));
    expect((await rows(w, 'SELECT status FROM x402_attempts'))[0]).toMatchObject({ status: 'delivered' });
  }, 60_000);

  it('refuses the same payment again, on the same request and on another, without moving funds', async () => {
    const { required } = await challenge(w, '/paid/echo/21');
    const payment = await pay(w, required, '/paid/echo/21');
    expect((await get(w, '/paid/echo/21', payment)).statusCode).toBe(200);
    await new Promise((r) => setTimeout(r, 200));
    const recipientAfterFirst = await tokenBalance(w.recipient.address, w.mint.address, tokenProgram);

    const again = await get(w, '/paid/echo/21', payment);
    expect(again.statusCode).toBe(402);
    expect(again.json().code).toBe('payment_already_used');
    expect(again.headers['payment-required']).toBeDefined();
    // The payment was made for /21; presented for /22 it is not a payment for that request at all.
    const other = await get(w, '/paid/echo/22', payment);
    expect(other.statusCode).toBe(402);
    expect(other.json().code).toBe('challenge_invalid');
    expect(await tokenBalance(w.recipient.address, w.mint.address, tokenProgram)).toBe(recipientAfterFirst);
  }, 60_000);

  it('refuses an amount that is too low, too high, or aimed at another mint or recipient, and charges nothing', async () => {
    const cases: [string, Parameters<typeof paymentTransaction>[2], string][] = [
      ['underpaid', { amount: PRICE - 1n }, 'invalid_exact_svm_payload_amount_mismatch'],
      ['overpaid', { amount: PRICE + 1n }, 'invalid_exact_svm_payload_amount_mismatch'],
      ['wrong recipient', { destinationOwner: (await generateKeyPairSigner()).address }, 'invalid_exact_svm_payload_recipient_mismatch'],
      ['wrong mint', { mint: (await generateKeyPairSigner()).address }, 'invalid_exact_svm_payload_mint_mismatch'],
    ];
    const before = await tokenBalance(w.recipient.address, w.mint.address, tokenProgram);
    for (const [name, variant, reason] of cases) {
      const url = '/paid/echo/30';
      const { required } = await challenge(w, url);
      const res = await get(w, url, await pay(w, required, url, variant));
      expect(res.statusCode, name).toBe(402);
      expect(res.json().code, name).toBe(reason);
    }
    expect(await tokenBalance(w.recipient.address, w.mint.address, tokenProgram)).toBe(before);
  }, 60_000);

  it('refuses a payer who cannot cover the price and charges nothing', async () => {
    const broke = await generateKeyPairSigner();
    await airdrop(broke.address, 1);
    await createAta(broke, broke.address, w.mint.address, tokenProgram);
    const { required } = await challenge(w, '/paid/echo/31');
    const res = await get(w, '/paid/echo/31', await pay(w, required, '/paid/echo/31', { tokenProgram }, broke));
    expect(res.statusCode).toBe(402);
    expect(res.json().code).toBe('insufficient_funds');
  }, 60_000);

  it('refuses a tampered signature, a garbage header and a wrong version', async () => {
    const url = '/paid/echo/32';
    const { required } = await challenge(w, url);
    const good = JSON.parse(Buffer.from(await pay(w, required, url), 'base64').toString()) as PaymentPayload;
    const wire = Buffer.from(good.payload.transaction, 'base64');
    wire[1 + 64 + 5] = wire[1 + 64 + 5]! ^ 1;
    const forged = encodeBase64Json({ ...good, payload: { transaction: wire.toString('base64') } });
    expect((await get(w, url, forged)).json().code).toBe('invalid_exact_svm_payload_signature_invalid');
    expect((await get(w, url, 'not base64 !!')).statusCode).toBe(400);
    expect((await get(w, url, encodeBase64Json({ x402Version: 1 }))).json().code).toBe('invalid_x402_version');
    expect((await get(w, url, encodeBase64Json({ ...good, accepted: { ...good.accepted, amount: '1' } }))).json().code).toBe('accepted_requirements_mismatch');
    expect((await get(w, url, encodeBase64Json({ ...good, accepted: { ...good.accepted, extra: { feePayer: good.accepted.extra.feePayer } } }))).json().code).toBe('challenge_missing');
  }, 60_000);

  it('refuses a payment made for an expired challenge', async () => {
    const url = '/paid/echo/33';
    const { required } = await challenge(w, url);
    const payment = await pay(w, required, url);
    w.clock.offset = 3 * 60_000;
    try {
      const res = await get(w, url, payment);
      expect(res.statusCode).toBe(402);
      expect(res.json().code).toBe('challenge_expired');
    } finally {
      w.clock.offset = 0;
    }
  }, 60_000);

  it('does not use the payment when the facilitator is down, and sells it once the facilitator is back', async () => {
    const url = '/paid/echo/34';
    const { required } = await challenge(w, url);
    const payment = await pay(w, required, url);
    const before = await tokenBalance(w.recipient.address, w.mint.address, tokenProgram);
    w.facilitator.broken = true;
    const down = await get(w, url, payment);
    expect(down.statusCode).toBe(503);
    expect(down.headers['retry-after']).toBeDefined();
    expect(await tokenBalance(w.recipient.address, w.mint.address, tokenProgram)).toBe(before);
    w.facilitator.broken = false;
    const retry = await get(w, url, payment);
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toEqual({ n: 34, square: 1156 });
    expect((await tokenBalance(w.recipient.address, w.mint.address, tokenProgram)) - before).toBe(PRICE);
  }, 60_000);

  it('lets exactly one of two concurrent requests with one payment succeed', async () => {
    const url = '/paid/echo/35';
    const { required } = await challenge(w, url);
    const payment = await pay(w, required, url);
    const before = await tokenBalance(w.recipient.address, w.mint.address, tokenProgram);
    const results = await Promise.all([get(w, url, payment), get(w, url, payment), get(w, url, payment)]);
    const ok = results.filter((r) => r.statusCode === 200);
    const seen = results.map((r) => `${r.statusCode}:${r.headers['payment-response'] ? 'paid' : String((r.json() as { code?: string }).code)}`).join(' ');
    expect(ok, seen).toHaveLength(1);
    expect(results.filter((r) => r.statusCode !== 200).every((r) => [402, 409].includes(r.statusCode))).toBe(true);
    expect((await tokenBalance(w.recipient.address, w.mint.address, tokenProgram)) - before).toBe(PRICE);
    expect(await rows(w, `SELECT 1 FROM x402_payments WHERE route = '/paid/echo/:n' AND request_hash = '${requestKeyOf({ method: 'GET', path: url, query: {} })}'`)).toHaveLength(1);
  }, 60_000);

  it('sells many different payments at once without crosstalk, and never two responses for one payment under repeated races', async () => {
    const before = await tokenBalance(w.recipient.address, w.mint.address, tokenProgram);
    const urls = Array.from({ length: 6 }, (_v, i) => `/paid/echo/${40 + i}`);
    const payments = await Promise.all(urls.map(async (url) => pay(w, (await challenge(w, url)).required, url)));
    const results = await Promise.all(urls.map((url, i) => get(w, url, payments[i])));
    expect(results.map((r) => r.statusCode), results.map((r) => r.body.slice(0, 300)).join(' | ')).toEqual(urls.map(() => 200));
    expect(results.map((r) => r.json().square)).toEqual(urls.map((_u, i) => (40 + i) ** 2));
    expect((await tokenBalance(w.recipient.address, w.mint.address, tokenProgram)) - before).toBe(PRICE * BigInt(urls.length));

    for (let round = 0; round < 4; round++) {
      const url = `/paid/echo/${60 + round}`;
      const payment = await pay(w, (await challenge(w, url)).required, url);
      const start = await tokenBalance(w.recipient.address, w.mint.address, tokenProgram);
      const burst = await Promise.all(Array.from({ length: 6 }, () => get(w, url, payment)));
      const seen = burst.map((r) => `${r.statusCode}:${r.headers['payment-response'] ? 'paid' : String((r.json() as { code?: string }).code)}`).join(' ');
      expect(burst.filter((r) => r.statusCode === 200), seen).toHaveLength(1);
      expect((await tokenBalance(w.recipient.address, w.mint.address, tokenProgram)) - start, seen).toBe(PRICE);
    }
  }, 120_000);

  it('charges nothing when the resource fails after the payment verified, and honours the same payment later', async () => {
    const url = '/paid/echo/13';
    const { required } = await challenge(w, url);
    const payment = await pay(w, required, url);
    const before = await tokenBalance(w.recipient.address, w.mint.address, tokenProgram);
    const res = await get(w, url, payment);
    expect(res.statusCode).toBe(500);
    expect(await tokenBalance(w.recipient.address, w.mint.address, tokenProgram)).toBe(before);
    const attempt = (await rows(w, `SELECT status FROM x402_attempts ORDER BY created_at DESC LIMIT 1`))[0];
    expect(attempt).toMatchObject({ status: 'aborted' });
    // Aborted means still unspent: the payer's transaction is still valid, so the same request may present it again.
    const again = await get(w, url, payment);
    expect(again.statusCode).toBe(500);
    expect(await tokenBalance(w.recipient.address, w.mint.address, tokenProgram)).toBe(before);
  }, 60_000);

  it('serves a settled but undelivered response once more, and not a third time', async () => {
    const url = '/paid/echo/36';
    const { required } = await challenge(w, url);
    const payment = await pay(w, required, url);
    const request = { route: '/paid/echo/:n', resource: required.resource, requestKey: requestKeyOf({ method: 'GET', path: url, query: {} }), amount: PRICE, paymentHeader: payment };
    const work = async () => ({ status: 200, body: { n: 36, square: 1296 } });
    const first = await w.gate.run(request, work);
    expect(first.kind).toBe('paid');
    // The first response never reached the buyer: nobody called delivered(). A retry that arrives at once may be racing the
    // original response, so it is refused; one that arrives after the grace period is served.
    const early = await w.gate.run(request, work);
    expect(early).toMatchObject({ kind: 'rejected', code: 'payment_already_used' });
    await w.db.query(`UPDATE x402_attempts SET settled_at = now() - interval '1 minute' WHERE request_hash = $1`, [request.requestKey]);
    const second = await w.gate.run({ ...request, paymentHeader: payment }, work);
    expect(second).toMatchObject({ kind: 'paid', redelivered: true });
    if (second.kind === 'paid') await second.delivered();
    const third = await w.gate.run(request, work);
    expect(third).toMatchObject({ kind: 'rejected', code: 'payment_already_used' });
    expect(await rows(w, `SELECT 1 FROM x402_payments WHERE request_hash = '${request.requestKey}'`)).toHaveLength(1);
  }, 60_000);

  it('records the signature before broadcast and reconciles a payment a crash left pending', async () => {
    const url = '/paid/echo/37';
    const { required } = await challenge(w, url);
    const payment = await pay(w, required, url);
    const payload = JSON.parse(Buffer.from(payment, 'base64').toString()) as PaymentPayload;
    // Run settlement directly through the facilitator, as a process that dies right after broadcasting would have.
    let recorded = '';
    const settled = await w.facilitator.settle(payload, payload.accepted, { beforeBroadcast: async (s) => void (recorded = s) });
    expect(settled.success).toBe(true);
    expect(recorded).toBe(settled.transaction);
    // The gate's own claim for this payment, abandoned in the pending state with the signature recorded.
    const { inspectTransaction } = await import('../src/inspect.js');
    const key = inspectTransaction(payload.payload.transaction).messageHash;
    await w.ledger.claim({ paymentKey: key, protocol: 'x402', payer: w.payer.address, route: '/paid/echo/:n', amount: PRICE, mint: w.mint.address, payTo: w.recipient.address, network: payload.accepted.network, requestHash: requestKeyOf({ method: 'GET', path: url, query: {} }) });
    await w.ledger.recordSignature(key, recorded);
    await w.db.query(`UPDATE x402_attempts SET created_at = now() - interval '10 minutes' WHERE payment_key = $1`, [key]);
    expect(await w.gate.reconcile(60)).toMatchObject({ settled: 1 });
    expect((await w.ledger.get(key))?.status).toBe('settled');
    // The buyer who retries the same request now receives what they paid for.
    const res = await get(w, url, payment);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ n: 37, square: 1369 });
    expect(await rows(w, `SELECT 1 FROM x402_payments WHERE payment_key = '${key}'`)).toHaveLength(1);
  }, 60_000);

  it('refuses to spend a fee payer that is nearly empty', async () => {
    const poor = await generateKeyPairSigner();
    await airdrop(poor.address, 0.001);
    const f = new LocalFacilitator({ rpc, network: await networkOf(rpc), signers: [poor], policy: { payTo: [w.recipient.address], assets: [w.mint.address] }, minFeePayerLamports: 5_000_000n });
    const requirements = { scheme: 'exact' as const, network: await networkOf(rpc), amount: PRICE.toString(), asset: w.mint.address, payTo: w.recipient.address, maxTimeoutSeconds: 60, extra: { feePayer: poor.address, memo: 'm' } };
    const payload = await buildExactPayment({ rpc, signer: w.payer, requirements });
    expect(await f.verify(payload, requirements)).toMatchObject({ isValid: false, invalidReason: 'fee_payer_balance_too_low' });
  }, 60_000);

  it('does not sponsor a transfer to a recipient or asset outside its policy', async () => {
    const stranger = await generateKeyPairSigner();
    const requirements = { scheme: 'exact' as const, network: await networkOf(rpc), amount: PRICE.toString(), asset: w.mint.address, payTo: stranger.address, maxTimeoutSeconds: 60, extra: { feePayer: w.feePayer.address, memo: 'm' } };
    await createAta(w.payer, stranger.address, w.mint.address, tokenProgram);
    const payload = await buildExactPayment({ rpc, signer: w.payer, requirements });
    const f = new LocalFacilitator({ rpc, network: await networkOf(rpc), signers: [w.feePayer], policy: { payTo: [w.recipient.address], assets: [w.mint.address] } });
    expect(await f.verify(payload, requirements)).toMatchObject({ isValid: false, invalidReason: 'pay_to_not_sponsored' });
    expect(await f.settle(payload, requirements)).toMatchObject({ success: false, errorReason: 'pay_to_not_sponsored' });
  }, 60_000);

  describe('MPP charge over the same route', () => {
    const header = async (url: string) => {
      const res = await w.app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(402);
      return { res, challenge: parseChallenges(String(res.headers['www-authenticate']))[0]! };
    };
    const credential = async (challenge: ReturnType<typeof parseChallenges>[number], variant: Parameters<typeof paymentTransaction>[2] = {}, signer = w.payer) => {
      const request = JSON.parse(Buffer.from(challenge.request, 'base64url').toString()) as { amount: string; currency: string; recipient: string; externalId: string; methodDetails: { feePayerKey: string } };
      const accepted = { scheme: 'exact' as const, network: 'x', amount: request.amount, asset: request.currency, payTo: request.recipient, maxTimeoutSeconds: 60, extra: { feePayer: request.methodDetails.feePayerKey, memo: request.externalId } };
      const { value: lifetime } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send();
      const parties = { payer: signer, feePayer: w.feePayer, mint: w.mint, recipient: w.recipient };
      const { base64 } = await paymentTransaction(parties, accepted, { tokenProgram: w.tokenProgram, lifetime: lifetime as never, ...variant });
      return encodeCredential({ challenge, source: signer.address, payload: { type: 'transaction', transaction: base64 } });
    };
    const getWith = (url: string, authorization?: string) => w.app.inject({ method: 'GET', url, headers: authorization ? { authorization } : {} });

    it('offers an MPP challenge beside the x402 requirements, bound to the request, and says how to pay either way', async () => {
      const { res, challenge } = await header('/paid/echo/50');
      expect(res.headers['payment-required']).toBeDefined();
      expect(challenge).toMatchObject({ realm: 'api.test', method: 'solana', intent: 'charge' });
      expect(challenge.expires).toMatch(/Z$/);
      const request = JSON.parse(Buffer.from(challenge.request, 'base64url').toString());
      expect(request).toMatchObject({ amount: PRICE.toString(), currency: w.mint.address, recipient: w.recipient.address, methodDetails: { network: 'localnet', decimals: 6, tokenProgram, feePayer: true, feePayerKey: w.feePayer.address } });
      expect(res.json().howToPay).toContain('Authorization: Payment');
    });

    it('sells the response for an MPP credential, settles on chain, and returns a receipt that names the transaction', async () => {
      const { challenge } = await header('/paid/echo/51');
      const auth = await credential(challenge);
      const payerBefore = await tokenBalance(w.payer.address, w.mint.address, tokenProgram);
      const recipientBefore = await tokenBalance(w.recipient.address, w.mint.address, tokenProgram);
      const res = await getWith('/paid/echo/51', auth);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toEqual({ n: 51, square: 2601 });
      expect(res.headers['payment-response']).toBeUndefined();
      const receipt = decodeReceipt(String(res.headers['payment-receipt']));
      expect(receipt).toMatchObject({ method: 'solana', challengeId: challenge.id, status: 'success' });
      expect(receipt.timestamp).toMatch(/^\d{4}-\d\d-\d\dT/);
      expect(payerBefore - (await tokenBalance(w.payer.address, w.mint.address, tokenProgram))).toBe(PRICE);
      expect((await tokenBalance(w.recipient.address, w.mint.address, tokenProgram)) - recipientBefore).toBe(PRICE);
      const status = (await rpc.getSignatureStatuses([receipt.reference as never]).send()).value[0];
      expect(status?.err).toBeNull();
      expect((await rows(w, `SELECT protocol, signature, route FROM x402_payments WHERE signature = '${receipt.reference}'`))[0]).toMatchObject({ protocol: 'mpp', route: '/paid/echo/:n' });
    }, 60_000);

    it('accepts the compute-budget order of the official client (price, then limit, 200000 units), which x402 refuses', async () => {
      const { challenge } = await header('/paid/echo/52');
      const auth = await credential(challenge, { swapBudget: true, limit: 200_000 });
      const r52 = await getWith('/paid/echo/52', auth);
      expect(r52.statusCode, r52.body).toBe(200);
      const url = '/paid/echo/53';
      const { required } = await (async () => ({ required: (await w.app.inject({ method: 'GET', url })).headers['payment-required'] }))();
      const decoded = decodeBase64Json(required as string, 'PAYMENT-REQUIRED') as PaymentRequired;
      const swapped = await pay(w, decoded, url, { swapBudget: true });
      const res = await get(w, url, swapped);
      expect(res.statusCode).toBe(402);
      expect(res.json().code).toBe('invalid_exact_svm_payload_transaction_instructions_compute_limit_instruction');
    }, 60_000);

    it('refuses the same credential twice, and a credential for another request, with problem documents', async () => {
      const { challenge } = await header('/paid/echo/54');
      const auth = await credential(challenge);
      expect((await getWith('/paid/echo/54', auth)).statusCode).toBe(200);
      await new Promise((r) => setTimeout(r, 200));
      const again = await getWith('/paid/echo/54', auth);
      expect(again.statusCode).toBe(402);
      expect(again.headers['content-type']).toContain('application/problem+json');
      expect(again.json()).toMatchObject({ type: 'https://paymentauth.org/problems/verification-failed', status: 402 });
      expect(String(again.headers['www-authenticate'])).toContain('Payment id=');
      const elsewhere = await getWith('/paid/echo/55', auth);
      expect(elsewhere.statusCode).toBe(402);
      expect(elsewhere.json().type).toBe('https://paymentauth.org/problems/invalid-challenge');
    }, 60_000);

    it('answers every kind of bad credential with 402, the matching problem type and a fresh challenge, and charges nothing', async () => {
      const before = await tokenBalance(w.recipient.address, w.mint.address, tokenProgram);
      const { challenge } = await header('/paid/echo/56');
      const good = await credential(challenge);
      const params = parseChallenges(String((await header('/paid/echo/56')).res.headers['www-authenticate']))[0]!;
      const cases: [string, string, string][] = [
        ['garbage', 'Payment !!!', 'malformed-credential'],
        ['not json', 'Payment ' + Buffer.from('nope').toString('base64url'), 'malformed-credential'],
        ['edited request', encodeCredential({ challenge: { ...challenge, request: Buffer.from(JSON.stringify({ amount: '1' })).toString('base64url') }, payload: { type: 'transaction', transaction: 'AQID' } }), 'invalid-challenge'],
        ['foreign id', encodeCredential({ challenge: { ...challenge, id: 'A'.repeat(43) }, payload: { type: 'transaction', transaction: 'AQID' } }), 'invalid-challenge'],
        ['push mode', encodeCredential({ challenge, payload: { type: 'signature', signature: '5UfDuX' } as never }), 'verification-failed'],
        ['bundle', encodeCredential({ challenge, payload: { type: 'bundle', transactions: [] } as never }), 'malformed-credential'],
        ['not a transaction', encodeCredential({ challenge, payload: { type: 'transaction', transaction: 'AQIDBA==' } }), 'malformed-credential'],
      ];
      for (const [name, auth, type] of cases) {
        const res = await getWith('/paid/echo/56', auth);
        expect(res.statusCode, name).toBe(402);
        expect(res.json().type, name).toBe(`https://paymentauth.org/problems/${type}`);
        expect(String(res.headers['www-authenticate']), name).toContain('Payment id=');
      }
      // The good credential is still good after all of that.
      expect((await getWith('/paid/echo/56', good)).statusCode).toBe(200);
      expect((await tokenBalance(w.recipient.address, w.mint.address, tokenProgram)) - before).toBe(PRICE);
      void params;
    }, 60_000);

    it('refuses wrong amounts, recipients and memos in the transaction, and an expired challenge', async () => {
      const cases: [string, Parameters<typeof paymentTransaction>[2], string][] = [
        ['underpaid', { amount: PRICE - 1n }, 'invalid_exact_svm_payload_amount_mismatch'],
        ['wrong recipient', { destinationOwner: (await generateKeyPairSigner()).address }, 'invalid_exact_svm_payload_recipient_mismatch'],
        ['no memo', { memo: null }, 'invalid_exact_svm_payload_memo_count'],
        ['someone else\'s memo', { memo: 'AAAAAAAAAAA' }, 'invalid_exact_svm_payload_memo_mismatch'],
      ];
      for (const [name, variant, code] of cases) {
        const { challenge } = await header('/paid/echo/57');
        const res = await getWith('/paid/echo/57', await credential(challenge, variant));
        expect(res.statusCode, name).toBe(402);
        expect(res.json().detail, name).toBeTruthy();
        expect(res.json().title, name).toBe(code.replace(/_/g, ' '));
      }
      const { challenge } = await header('/paid/echo/58');
      const auth = await credential(challenge);
      w.clock.offset = 3 * 60_000;
      try {
        const res = await getWith('/paid/echo/58', auth);
        expect(res.statusCode).toBe(402);
        expect(res.json().type).toBe('https://paymentauth.org/problems/payment-expired');
      } finally {
        w.clock.offset = 0;
      }
    }, 90_000);

    it('lets exactly one of several concurrent requests with one credential through', async () => {
      const { challenge } = await header('/paid/echo/59');
      const auth = await credential(challenge);
      const before = await tokenBalance(w.recipient.address, w.mint.address, tokenProgram);
      const burst = await Promise.all(Array.from({ length: 5 }, () => getWith('/paid/echo/59', auth)));
      const seen = burst.map((r) => `${r.statusCode}:${r.headers['payment-receipt'] ? 'paid' : String((r.json() as { title?: string }).title)}`).join(' ');
      expect(burst.filter((r) => r.statusCode === 200), seen).toHaveLength(1);
      expect((await tokenBalance(w.recipient.address, w.mint.address, tokenProgram)) - before, seen).toBe(PRICE);
    }, 60_000);

    it('pays over MPP with the buyer client when asked to, and over x402 by default', async () => {
      await w.app.listen({ port: 0, host: '127.0.0.1' });
      const base = `http://127.0.0.1:${(w.app.server.address() as { port: number }).port}`;
      const limits = { maxAmount: 100_000n, assets: [w.mint.address], payTo: [w.recipient.address], mppNetwork: 'localnet' as const };
      const viaMpp = await createPayFetch({ signer: w.payer, rpc, limits, prefer: 'mpp' })(`${base}/paid/echo/60`);
      expect(viaMpp.response.status).toBe(200);
      expect(viaMpp.paid).toMatchObject({ protocol: 'mpp', amount: PRICE, network: 'localnet' });
      expect(viaMpp.paid?.transaction).toBeTruthy();
      const viaX402 = await createPayFetch({ signer: w.payer, rpc, limits })(`${base}/paid/echo/61`);
      expect(viaX402.response.status).toBe(200);
      expect(viaX402.paid?.protocol).toBe('x402');
      // The buyer's limits hold for MPP too: a network it does not allow, or a price above its ceiling, is refused before anything is signed.
      const before = await tokenBalance(w.payer.address, w.mint.address, tokenProgram);
      await expect(createPayFetch({ signer: w.payer, rpc, limits: { ...limits, mppNetwork: 'mainnet' }, prefer: 'mpp' })(`${base}/paid/echo/62`)).rejects.toThrow(/mainnet/);
      await expect(createPayFetch({ signer: w.payer, rpc, limits: { ...limits, maxAmount: PRICE - 1n }, prefer: 'mpp' })(`${base}/paid/echo/62`)).rejects.toThrow(/above the limit/);
      expect(await tokenBalance(w.payer.address, w.mint.address, tokenProgram)).toBe(before);
    }, 60_000);
  });

  // The official client of the Solana Foundation, run as a separate process against this server. It is installed outside the
  // repository (see test/support/mpp-official-client.mjs); the test skips when MPP_INTEROP_DIR is not set.
  it.skipIf(!process.env.MPP_INTEROP_DIR)('is paid by the official @solana/mpp client, which this server has never seen', async () => {
    const { webcrypto } = await import('node:crypto');
    const { copyFileSync } = await import('node:fs');
    const { execFile } = await import('node:child_process');
    const run = (await import('node:util')).promisify(execFile);
    const { createKeyPairSignerFromBytes } = await import('@solana/kit');
    const dir = process.env.MPP_INTEROP_DIR!;
    copyFileSync(new URL('./support/mpp-official-client.mjs', import.meta.url), `${dir}/client.mjs`);
    const pair = (await webcrypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])) as CryptoKeyPair;
    const secret = Buffer.from(await webcrypto.subtle.exportKey('pkcs8', pair.privateKey)).subarray(-32);
    const pub = Buffer.from(await webcrypto.subtle.exportKey('raw', pair.publicKey));
    const buyer = await createKeyPairSignerFromBytes(Uint8Array.from([...secret, ...pub]));
    // The buyer holds tokens and no SOL at all: the server sponsors the fee, which is the point of the sponsored charge.
    await mintTo(w.authority, w.authority, w.mint.address, buyer.address, 1_000_000n, w.tokenProgram);
    if (!w.app.server.listening) await w.app.listen({ port: 0, host: '127.0.0.1' });
    const base = `http://127.0.0.1:${(w.app.server.address() as { port: number }).port}`;
    const before = [await tokenBalance(buyer.address, w.mint.address, tokenProgram), await tokenBalance(w.recipient.address, w.mint.address, tokenProgram), await lamportBalance(buyer.address)];
    // Asynchronous on purpose: this process also hosts the server the child is calling.
    const { stdout } = await run(process.execPath, ['client.mjs', `${base}/paid/echo/70`], { cwd: dir, env: { ...process.env, SECRET_KEY: JSON.stringify([...secret, ...pub]), RPC_URL: process.env.X402_TEST_RPC ?? 'http://127.0.0.1:8940', ALLOW_UNKNOWN_TOKEN2022: tokenProgram === TOKEN_2022_PROGRAM_ADDRESS ? '1' : '0' }, timeout: 60_000 });
    const out = JSON.parse(stdout.trim().split(/\r?\n/).at(-1)!) as { status: number; body: string; receipt: { method: string; reference: string; status: string; challengeId: string } | null };
    expect(out.status, out.body).toBe(200);
    expect(JSON.parse(out.body)).toEqual({ n: 70, square: 4900 });
    expect(out.receipt).toMatchObject({ method: 'solana', status: 'success' });
    expect(before[0]! - (await tokenBalance(buyer.address, w.mint.address, tokenProgram))).toBe(PRICE);
    expect((await tokenBalance(w.recipient.address, w.mint.address, tokenProgram)) - before[1]!).toBe(PRICE);
    expect(await lamportBalance(buyer.address)).toBe(before[2]);
    const status = (await rpc.getSignatureStatuses([out.receipt!.reference as never]).send()).value[0];
    expect(status?.err).toBeNull();
    expect((await rows(w, `SELECT protocol, payer FROM x402_payments WHERE signature = '${out.receipt!.reference}'`))[0]).toMatchObject({ protocol: 'mpp', payer: buyer.address });
  }, 120_000);

  it('logs events without wallet addresses', async () => {
    expect(w.events.length).toBeGreaterThan(5);
    expect(w.events.join(' ')).not.toMatch(/[1-9A-HJ-NP-Za-km-z]{32,}/);
  });
});
