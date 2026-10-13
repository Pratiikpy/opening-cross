// /v1/paid/*: what an unpaid caller is shown, what a paid caller gets, and what is never charged. The payment gate here is a
// stand-in that speaks the gate's interface (the real gate, facilitator and ledger are tested in packages/x402 and run on
// devnet in docs/evidence/W2A-X6-x402-api.md); everything else is real: signed receipts, the chain reads and the database.
import Fastify from 'fastify';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateKeyPair } from '@solana/kit';
import { CrossState, Disclosure } from '@opening-cross/sdk';
import { verifyDocument } from '@opening-cross/attest';
import type { FairnessProof } from '@opening-cross/verifier';
import { registerPaid } from '../src/routes/paid.js';
import { RequestError } from '../src/tx.js';
import { Chain, databaseUrl, insertCross, insertOrder, newAddress, openSchema } from './helpers/w2a.js';

const NOW = 1_800_000_000;
const describeDb = databaseUrl ? describe : describe.skip;
if (!databaseUrl) console.warn('paid.test.ts: SKIPPED; set DATABASE_URL to a Postgres to run it');

const PROOF = (cross: string): FairnessProof =>
  ({
    schema: 'opening-cross/fairness-proof/v1', program: 'P', cross, state: 'Finalized',
    params: { minPrice: '1000000', tick: '50000', ticks: 41, priceScale: '1000000', referencePrice: null, minMatched: '0', maxImbalanceBps: null, oracleGuard: false },
    book: [], onchain: { printed: true, price: '1550000', matched: '100000000', rationed: 'sell', noPrintReason: null },
    recomputed: { printed: true, price: '1550000', matched: '100000000', rationed: 'sell', noPrintReason: null }, verified: true, notes: [],
  }) as unknown as FairnessProof;

/** A gate that charges nothing real: no payment header gives a 402, any header is "paid" and the work is run. */
function fakeGate() {
  const calls: { paid: boolean; amount: bigint; route: string }[] = [];
  return {
    calls,
    gate: {
      async run(p: { route: string; amount: bigint; paymentHeader: string | undefined; resource: unknown }, work: () => Promise<{ status: number; body: unknown }>) {
        calls.push({ paid: Boolean(p.paymentHeader), amount: p.amount, route: p.route });
        if (!p.paymentHeader) return { kind: 'challenge', status: 402, required: { x402Version: 2, resource: p.resource, accepts: [{ scheme: 'exact', network: 'solana:test', amount: p.amount.toString(), asset: 'Mint', payTo: 'Wallet', maxTimeoutSeconds: 60, extra: { feePayer: 'FeePayer', memo: 'oc1.memo' } }] }, headers: {} };
        const d = await work();
        return { kind: 'paid', status: d.status, body: d.body, headers: {}, settlement: { success: true }, redelivered: false, delivered: async () => undefined };
      },
    } as never,
  };
}

describeDb('paid routes', () => {
  let db: pg.Pool;
  let close: () => Promise<void>;
  const chain = new Chain();
  const signer = { keyPair: undefined as unknown as CryptoKeyPair, address: '' };

  const build = async (paid: Parameters<typeof registerPaid>[2]) => {
    const app = Fastify();
    app.setErrorHandler((err, _req, reply) => (err instanceof RequestError ? reply.code(err.status).send({ error: err.message, ...err.detail }) : reply.code(500).send({ error: String(err) })));
    registerPaid(app, { db, account: chain.read, lifetime: async () => ({ blockhash: '4NCYB3kRT8sCNodPNuCZo8VUh4xqpBQxsxed2wd9xaD4' as never, lastValidBlockHeight: 1n }), clock: () => NOW, network: 'devnet' }, paid);
    await app.ready();
    return app;
  };
  const call = async (app: Awaited<ReturnType<typeof build>>, method: 'GET' | 'POST', url: string, opts: { pay?: boolean; body?: unknown } = {}) => {
    const res = await app.inject({ method, url, ...(opts.body !== undefined ? { payload: opts.body as object } : {}), headers: opts.pay ? { 'payment-signature': 'x' } : {} });
    return { status: res.statusCode, body: JSON.parse(res.body) };
  };

  beforeAll(async () => {
    ({ db, close } = await openSchema());
    const kp = await generateKeyPair();
    const { getAddressFromPublicKey } = await import('@solana/kit');
    signer.keyPair = kp;
    signer.address = await getAddressFromPublicKey(kp.publicKey);
  });
  afterAll(async () => {
    await close?.();
  });

  it('answers 501 and points at the free route when no gate is configured', async () => {
    const app = await build(null);
    const a = await newAddress();
    for (const r of [call(app, 'GET', `/v1/paid/verify/${a}`), call(app, 'GET', `/v1/paid/bundle/${a}`), call(app, 'POST', '/v1/paid/order-desk', { body: {} })]) {
      const out = await r;
      expect(out.status).toBe(501);
      expect(out.body.free).toMatch(/free/);
    }
    expect((await call(app, 'GET', '/v1/attestations/signer')).body.signer).toBeNull();
  });

  it('verify: shows the verdict unpaid, charges the rate card price, and signs the receipt with the published key', async () => {
    const g = fakeGate();
    const app = await build({ gate: g.gate, attestation: signer, verifyProof: async (_f, c) => PROOF(c) });
    const cross = await chain.putCross({ state: CrossState.Finalized });
    const unpaid = await call(app, 'GET', `/v1/paid/verify/${cross}`);
    expect(unpaid.status).toBe(402);
    expect(unpaid.body.preview).toMatchObject({ cross, verified: true, state: 'Finalized' });
    expect(unpaid.body.accepts[0].amount).toBe('10000'); // proof-verification in the proposed rate card
    expect(unpaid.body.preview.note).toMatch(/signed by the published key/);

    const paid = await call(app, 'GET', `/v1/paid/verify/${cross}`, { pay: true });
    expect(paid.status).toBe(200);
    expect(paid.body.receipt.signer).toBe(signer.address);
    expect(paid.body.receipt.body).toMatchObject({ schema: 'opening-cross/verification-receipt/v1', cross, verified: true, cluster: 'devnet', issuedAt: NOW });
    expect(await verifyDocument(paid.body.receipt, signer.address)).toEqual({ ok: true });
    expect((await call(app, 'GET', '/v1/attestations/signer')).body.signer).toBe(signer.address);
  });

  it('verify: with no attestation key the receipt says it is unsigned instead of pretending', async () => {
    const app = await build({ gate: fakeGate().gate, verifyProof: async (_f, c) => PROOF(c) });
    const cross = await chain.putCross({ state: CrossState.Finalized });
    const paid = await call(app, 'GET', `/v1/paid/verify/${cross}`, { pay: true });
    expect(paid.body.receipt).toMatchObject({ unsigned: true, reason: expect.stringMatching(/no attestation key/) });
  });

  it('never offers a price for a request it cannot answer', async () => {
    const g = fakeGate();
    const app = await build({ gate: g.gate, attestation: signer, verifyProof: async (_f, c) => PROOF(c) });
    const live = await chain.putCross({ state: CrossState.Live });
    expect((await call(app, 'GET', `/v1/paid/verify/${live}`)).status).toBe(409);
    expect((await call(app, 'GET', `/v1/paid/verify/not-an-address`)).status).toBe(400);
    expect((await call(app, 'GET', `/v1/paid/verify/${await newAddress()}`)).status).toBe(404);
    expect((await call(app, 'GET', `/v1/paid/bundle/${live}`)).status).toBe(409);
    expect(g.calls).toEqual([]); // the gate was never reached: no challenge, no charge
  });

  it('bundle: returns every order and event with hashes under one signature', async () => {
    const app = await build({ gate: fakeGate().gate, attestation: signer, verifyProof: async (_f, c) => PROOF(c) });
    const cross = await chain.putCross({ state: CrossState.Finalized });
    await insertCross(db, cross, { state: 'Finalized' });
    await insertOrder(db, cross, 0, 'ownerA', 'buy', 1_600_000n, 100_000_000n, 'claimed');
    await insertOrder(db, cross, 1, 'ownerB', 'sell', 1_550_000n, 200_000_000n, 'claimed');
    await db.query(`INSERT INTO events (signature, seq, slot, block_time, name, cross_address, payload) VALUES ('sig1', 0, 5, to_timestamp(1799999000), 'CrossCleared', $1, '{"price":"1550000"}')`, [cross]);
    const unpaid = await call(app, 'GET', `/v1/paid/bundle/${cross}`);
    expect(unpaid.status).toBe(402);
    expect(unpaid.body.preview).toMatchObject({ orders: 2, events: 1 });
    expect(unpaid.body.accepts[0].amount).toBe('50000');
    const paid = await call(app, 'GET', `/v1/paid/bundle/${cross}`, { pay: true });
    expect(paid.status).toBe(200);
    expect(paid.body.data.orders).toHaveLength(2);
    expect(paid.body.data.events[0]).toMatchObject({ name: 'CrossCleared', signature: 'sig1' });
    expect(paid.body.attestation.body).toMatchObject({ schema: 'opening-cross/audit-bundle/v1', orders: 2, events: 1, verified: true });
    expect(await verifyDocument(paid.body.attestation, signer.address)).toEqual({ ok: true });
  });

  describe('order desk', () => {
    const order = (cross: string, over: Record<string, unknown> = {}) => ({ cross, owner: signer.address, nonce: '42', side: 'buy', price: '1600000', quantity: '100000000', ...over });
    const open = (over: Record<string, unknown> = {}) =>
      chain.putCross({ state: CrossState.Live, disclosure: Disclosure.Open, openTs: BigInt(NOW - 100), closeTs: BigInt(NOW + 300), minPrice: 1_000_000n, tick: 50_000n, ticks: 41, protocolFeeBps: 5, integratorFeeBps: 20, ...over });

    it('previews the check unpaid and returns an unsigned transaction with the cluster\'s simulation when paid', async () => {
      const app = await build({ gate: fakeGate().gate, simulate: async () => ({ err: null, logs: ['Program log: ok'], unitsConsumed: 21_000 }) });
      const cross = await open();
      const unpaid = await call(app, 'POST', '/v1/paid/order-desk', { body: order(cross) });
      expect(unpaid.status).toBe(402);
      expect(unpaid.body.preview).toMatchObject({ escrow: '160000000', escrowAsset: 'quote', secondsLeft: '300', feeNote: 'Buyers pay no fee.' });
      expect(unpaid.body.preview.transaction).toBeUndefined();
      expect(unpaid.body.accepts[0].amount).toBe('20000');
      const paid = await call(app, 'POST', '/v1/paid/order-desk', { pay: true, body: order(cross) });
      expect(paid.status).toBe(200);
      expect(typeof paid.body.transaction).toBe('string');
      expect(paid.body.signers).toContain(signer.address);
      expect(paid.body.preflight).toEqual({ wouldSucceed: true, error: null, unitsConsumed: 21_000, logs: ['Program log: ok'] });
    });

    it('reports a failing simulation instead of hiding it', async () => {
      const app = await build({ gate: fakeGate().gate, simulate: async () => ({ err: { InstructionError: [0, { Custom: 6006 }] }, logs: ['Program log: Error: Paused'], unitsConsumed: 900 }) });
      const paid = await call(app, 'POST', '/v1/paid/order-desk', { pay: true, body: order(await open()) });
      expect(paid.body.preflight).toMatchObject({ wouldSucceed: false, error: { InstructionError: [0, { Custom: 6006 }] } });
    });

    it('refuses before any price: closed, upcoming, off-grid, missing salt, junk', async () => {
      const g = fakeGate();
      const app = await build({ gate: g.gate, simulate: async () => ({ err: null, logs: [], unitsConsumed: 1 }) });
      const post = (b: unknown) => call(app, 'POST', '/v1/paid/order-desk', { body: b });
      expect((await post(order(await open({ closeTs: BigInt(NOW - 1) })))).status).toBe(409);
      expect((await post(order(await open({ openTs: BigInt(NOW + 50) })))).status).toBe(409);
      expect((await post(order(await open({ state: CrossState.Cleared })))).status).toBe(409);
      const cross = await open();
      expect((await post(order(cross, { price: '1610000' }))).body.error).toMatch(/not on the grid/);
      expect((await post(order(cross, { price: '900000' }))).status).toBe(400);
      expect((await post(order(cross, { side: 'hold' }))).status).toBe(400);
      expect((await post(order(cross, { quantity: '1.5' }))).status).toBe(400);
      expect((await post(order(cross, { owner: 'nope' }))).status).toBe(400);
      expect((await post(order(await open({ disclosure: Disclosure.Sealed })))).body.error).toMatch(/provide a 32-byte hex salt/);
      expect((await post([])).status).toBe(400);
      expect(g.calls).toEqual([]);
    });
  });
});
