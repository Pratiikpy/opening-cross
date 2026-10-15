// MPP and x402 over the API's real pay-per-call routes (rows X6, J1, P6). `registerPaid` from services/api is mounted behind the real gate, a real facilitator, a real Postgres
// ledger and a solana-test-validator; the buyer is the package's own paying client, and a second buyer is the official @solana/mpp client when MPP_INTEROP_DIR is set. The
// API's own tests (services/api/test/paid.test.ts) use a stand-in gate for the route logic; this is the other half: the money. Every outcome is read back from token balances,
// signature statuses and the ledger, not from the HTTP answer alone. Skips itself when no validator answers on X402_TEST_RPC, like payments.test.ts.
import { randomBytes } from 'node:crypto';
import { copyFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import Fastify, { type FastifyInstance } from 'fastify';
import pg from 'pg';
import { type Address, type KeyPairSigner, generateKeyPair, generateKeyPairSigner, getAddressFromPublicKey } from '@solana/kit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CrossState, Disclosure } from '../../sdk/src/index.js';
import { verifyDocument } from '../../attest/src/index.js';
import { PROPOSED_RATE_CARD } from '../../fees/src/index.js';
import { registerPaid } from '../../../services/api/src/routes/paid.js';
import { RequestError } from '../../../services/api/src/tx.js';
import { Chain, insertCross, insertOrder } from '../../../services/api/test/helpers/w2a.js';
import { LocalFacilitator } from '../src/facilitator.js';
import { X402Gate } from '../src/gate.js';
import { PaymentLedger, migrate } from '../src/ledger.js';
import { createPayFetch } from '../src/pay-fetch.js';
import { decodeReceipt, parseChallenges } from '../src/mpp-wire.js';
import { networkOf } from '../src/network.js';
import { TOKEN_PROGRAM_ADDRESS } from './chain.js';
import { airdrop, chainUp, createAta, createMint, lamportBalance, mintTo, rpc, tokenBalance } from './chain.js';

const up = await chainUp();
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://postgres:oc@localhost:55432/postgres';
const NOW = Math.floor(Date.now() / 1000);
const price = (product: string) => PROPOSED_RATE_CARD.usage.find((u) => u.product === product)!.priceUnits;
const VERIFY = price('proof-verification'); // 10,000 = 0.01 USDC
const BUNDLE = price('data-export'); // 50,000
const DESK = price('order-desk'); // 20,000

const PROOF = (cross: string) => ({
  schema: 'opening-cross/fairness-proof/v1', program: 'P', cross, state: 'Finalized',
  params: { minPrice: '1000000', tick: '50000', ticks: 41, priceScale: '1000000', referencePrice: null, minMatched: '0', maxImbalanceBps: null, oracleGuard: false },
  book: [], onchain: { printed: true, price: '1550000', matched: '100000000', rationed: 'sell', noPrintReason: null },
  recomputed: { printed: true, price: '1550000', matched: '100000000', rationed: 'sell', noPrintReason: null }, verified: true, notes: [],
});

type World = {
  mint: KeyPairSigner;
  payer: KeyPairSigner;
  recipient: KeyPairSigner;
  feePayer: KeyPairSigner;
  authority: KeyPairSigner;
  db: pg.Pool;
  app: FastifyInstance;
  chain: Chain;
  base: string;
  signer: { keyPair: CryptoKeyPair; address: string };
  limits: { maxAmount: bigint; assets: string[]; payTo: string[]; mppNetwork: 'localnet' };
  drop: () => Promise<void>;
};

async function world(): Promise<World> {
  const [payer, recipient, feePayer, authority] = await Promise.all([generateKeyPairSigner(), generateKeyPairSigner(), generateKeyPairSigner(), generateKeyPairSigner()]);
  await Promise.all([airdrop(payer.address, 2), airdrop(feePayer.address, 2), airdrop(authority.address, 2)]);
  const mint = await createMint(authority, authority.address, 6, TOKEN_PROGRAM_ADDRESS);
  await mintTo(authority, authority, mint.address, payer.address, 10_000_000n, TOKEN_PROGRAM_ADDRESS);
  await createAta(authority, recipient.address, mint.address, TOKEN_PROGRAM_ADDRESS);

  const schema = `t_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ connectionString: DATABASE_URL });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  const db = new pg.Pool({ connectionString: DATABASE_URL, options: `-c search_path=${schema}` });
  // The indexer's tables (the bundle reads orders and events) and the ledger's, in one schema, as the deployed API has them.
  const { migrate: indexerMigrate } = await import('../../../services/indexer/src/index.js');
  await indexerMigrate(db);
  await migrate(db);

  const network = await networkOf(rpc);
  const facilitator = new LocalFacilitator({ rpc, network, signers: [feePayer], policy: { payTo: [recipient.address], assets: [mint.address] }, pollMs: 100, confirmTimeoutMs: 30_000 });
  const gate = new X402Gate({ facilitator, ledger: new PaymentLedger(db), network, asset: mint.address, payTo: recipient.address, secret: randomBytes(32), mpp: { realm: 'api.test', network: 'localnet', decimals: 6, tokenProgram: TOKEN_PROGRAM_ADDRESS } });

  const kp = await generateKeyPair();
  const signer = { keyPair: kp, address: await getAddressFromPublicKey(kp.publicKey) };
  const chain = new Chain();
  const app = Fastify();
  app.setErrorHandler((err, _req, reply) => (err instanceof RequestError ? reply.code(err.status).send({ error: err.message, ...err.detail }) : reply.code(500).send({ error: String(err) })));
  registerPaid(
    app,
    {
      db,
      account: chain.read,
      lifetime: async () => {
        const { value } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send();
        return { blockhash: value.blockhash, lastValidBlockHeight: value.lastValidBlockHeight } as never;
      },
      clock: () => NOW,
      network: 'localnet',
    },
    { gate, attestation: signer, verifyProof: async (_f, c) => PROOF(c) as never, simulate: async () => ({ err: null, logs: ['Program log: simulated'], unitsConsumed: 21_000 }) },
  );
  await app.listen({ port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  return {
    mint, payer, recipient, feePayer, authority, db, app, chain, base, signer,
    limits: { maxAmount: 1_000_000n, assets: [mint.address], payTo: [recipient.address], mppNetwork: 'localnet' },
    drop: async () => {
      await app.close();
      await db.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    },
  };
}

describe.skipIf(!up)('the API\'s pay-per-call routes, paid over MPP and x402 on a real chain', () => {
  let w: World;
  beforeAll(async () => {
    w = await world();
  }, 120_000);
  afterAll(async () => {
    await w?.drop();
  });

  const balances = async () => ({ payer: await tokenBalance(w.payer.address, w.mint.address, TOKEN_PROGRAM_ADDRESS), recipient: await tokenBalance(w.recipient.address, w.mint.address, TOKEN_PROGRAM_ADDRESS) });
  const ledgerRows = async (route: string) => (await w.db.query('SELECT protocol, payer, amount::text, signature FROM x402_payments WHERE route = $1 ORDER BY settled_at', [route])).rows as { protocol: string; payer: string; amount: string; signature: string }[];
  const finalized = () => w.chain.putCross({ state: CrossState.Finalized });
  const open = (over: Record<string, unknown> = {}) =>
    w.chain.putCross({ state: CrossState.Live, disclosure: Disclosure.Open, openTs: BigInt(NOW - 100), closeTs: BigInt(NOW + 300), minPrice: 1_000_000n, tick: 50_000n, ticks: 41, protocolFeeBps: 5, integratorFeeBps: 20, ...over });
  const order = (cross: string, over: Record<string, unknown> = {}) => ({ cross, owner: w.payer.address, nonce: '42', side: 'buy', price: '1600000', quantity: '100000000', ...over });
  const post = (cross: string) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(order(cross)) });
  const payOver = (prefer: 'mpp' | 'x402', limits = w.limits) => createPayFetch({ signer: w.payer, rpc, limits, prefer });

  describe('what an unpaid caller is shown', () => {
    it('offers the same request over x402 and over MPP, bound to this request, with a real sample of what the payment buys', async () => {
      const cross = await finalized();
      const res = await fetch(`${w.base}/v1/paid/verify/${cross}`);
      expect(res.status).toBe(402);
      const body = (await res.json()) as { preview: Record<string, unknown>; accepts: { amount: string; asset: string; payTo: string }[]; howToPay: string };
      expect(body.preview).toMatchObject({ cross, verified: true, state: 'Finalized' });
      expect(body.accepts[0]).toMatchObject({ amount: VERIFY.toString(), asset: w.mint.address, payTo: w.recipient.address });
      expect(body.howToPay).toContain('Authorization: Payment');
      const challenge = parseChallenges(res.headers.get('www-authenticate')!)[0]!;
      expect(challenge).toMatchObject({ method: 'solana', intent: 'charge', realm: 'api.test' });
      const request = JSON.parse(Buffer.from(challenge.request, 'base64url').toString());
      expect(request).toMatchObject({ amount: VERIFY.toString(), currency: w.mint.address, recipient: w.recipient.address });
      expect(res.headers.get('payment-required')).toBeTruthy();
    });

    it('moves nothing: an unpaid call to each of the three routes leaves both balances where they were', async () => {
      const before = await balances();
      const cross = await finalized();
      const live = await open();
      for (const r of [await fetch(`${w.base}/v1/paid/verify/${cross}`), await fetch(`${w.base}/v1/paid/bundle/${cross}`), await fetch(`${w.base}/v1/paid/order-desk`, post(live))]) expect(r.status).toBe(402);
      expect(await balances()).toEqual(before);
    });
  });

  describe('verify, paid over MPP', () => {
    it('sells a signed verdict for exactly the rate-card price, settles on chain, and records an MPP payment', async () => {
      const cross = await finalized();
      const before = await balances();
      const { response, paid } = await payOver('mpp')(`${w.base}/v1/paid/verify/${cross}`);
      const body = (await response.json()) as { receipt: { signer: string; body: Record<string, unknown> } };
      expect(response.status, JSON.stringify(body)).toBe(200);
      expect(paid).toMatchObject({ protocol: 'mpp', amount: VERIFY, network: 'localnet' });
      // The document is signed by the published key and says what was verified.
      expect(body.receipt.signer).toBe(w.signer.address);
      expect(body.receipt.body).toMatchObject({ schema: 'opening-cross/verification-receipt/v1', cross, verified: true, cluster: 'localnet' });
      expect(await verifyDocument(body.receipt as never, w.signer.address)).toEqual({ ok: true });
      // The chain agrees with the HTTP answer.
      const after = await balances();
      expect(before.payer - after.payer).toBe(VERIFY);
      expect(after.recipient - before.recipient).toBe(VERIFY);
      const receipt = decodeReceipt(response.headers.get('payment-receipt')!);
      expect(receipt).toMatchObject({ method: 'solana', status: 'success' });
      expect((await rpc.getSignatureStatuses([receipt.reference as never]).send()).value[0]?.err).toBeNull();
      expect(await ledgerRows('/v1/paid/verify/:cross')).toContainEqual({ protocol: 'mpp', payer: w.payer.address, amount: VERIFY.toString(), signature: receipt.reference });
    }, 90_000);
  });

  describe('bundle, paid over MPP', () => {
    it('sells every order and event of a settled cross in one signed document for the data-export price', async () => {
      const cross = await finalized();
      await insertCross(w.db, cross, { state: 'Finalized' });
      await insertOrder(w.db, cross, 0, 'ownerA', 'buy', 1_600_000n, 100_000_000n, 'claimed');
      await insertOrder(w.db, cross, 1, 'ownerB', 'sell', 1_550_000n, 200_000_000n, 'claimed');
      await w.db.query(`INSERT INTO events (signature, seq, slot, block_time, name, cross_address, payload) VALUES ($1, 0, 5, to_timestamp(1799999000), 'CrossCleared', $2, '{"price":"1550000"}')`, [`bundle-${cross}`, cross]);
      const unpaid = await (await fetch(`${w.base}/v1/paid/bundle/${cross}`)).json();
      expect(unpaid.preview).toMatchObject({ orders: 2, events: 1 });
      const before = await balances();
      const { response, paid } = await payOver('mpp')(`${w.base}/v1/paid/bundle/${cross}`);
      const body = await response.json();
      expect(response.status, JSON.stringify(body)).toBe(200);
      expect(paid).toMatchObject({ protocol: 'mpp', amount: BUNDLE });
      expect(body.data.orders.map((o: { owner: string }) => o.owner)).toEqual(['ownerA', 'ownerB']);
      expect(body.attestation.body).toMatchObject({ schema: 'opening-cross/audit-bundle/v1', orders: 2, events: 1, verified: true });
      expect(await verifyDocument(body.attestation, w.signer.address)).toEqual({ ok: true });
      const after = await balances();
      expect(before.payer - after.payer).toBe(BUNDLE);
      expect(after.recipient - before.recipient).toBe(BUNDLE);
    }, 90_000);
  });

  describe('order desk, paid over MPP (a POST with a body)', () => {
    it('sells the unsigned transaction and the simulation for the order-desk price; the body is part of what the payment is bound to', async () => {
      const live = await open();
      const before = await balances();
      const { response, paid } = await payOver('mpp')(`${w.base}/v1/paid/order-desk`, post(live));
      const body = await response.json();
      expect(response.status, JSON.stringify(body)).toBe(200);
      expect(paid).toMatchObject({ protocol: 'mpp', amount: DESK });
      expect(typeof body.transaction).toBe('string');
      expect(body.preflight).toMatchObject({ wouldSucceed: true, unitsConsumed: 21_000 });
      expect(body.escrow).toBe('160000000');
      const after = await balances();
      expect(before.payer - after.payer).toBe(DESK);
      expect(after.recipient - before.recipient).toBe(DESK);
    }, 90_000);

    it('a credential paid for one order buys nothing for a different order', async () => {
      const live = await open();
      let credential = '';
      const spy: typeof fetch = async (input, init) => {
        const h = new Headers(init?.headers);
        if (h.get('authorization')) credential = h.get('authorization')!;
        return fetch(input, init);
      };
      const first = await createPayFetch({ signer: w.payer, rpc, limits: w.limits, prefer: 'mpp', fetch: spy })(`${w.base}/v1/paid/order-desk`, post(live));
      expect(first.response.status).toBe(200);
      const before = await balances();
      const other = await fetch(`${w.base}/v1/paid/order-desk`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: credential }, body: JSON.stringify(order(live, { price: '1650000' })) });
      expect(other.status).toBe(402);
      expect(await other.json()).toMatchObject({ type: 'https://paymentauth.org/problems/invalid-challenge', detail: 'the payment was not made for this request' });
      expect(await balances()).toEqual(before);
    }, 90_000);
  });

  describe('the same routes, paid over x402', () => {
    it('verify and order desk settle on chain for the same prices', async () => {
      const cross = await finalized();
      const live = await open();
      const before = await balances();
      const v = await payOver('x402')(`${w.base}/v1/paid/verify/${cross}`);
      const d = await payOver('x402')(`${w.base}/v1/paid/order-desk`, post(live));
      expect(v.response.status).toBe(200);
      expect(d.response.status).toBe(200);
      expect([v.paid?.protocol, d.paid?.protocol]).toEqual(['x402', 'x402']);
      const after = await balances();
      expect(before.payer - after.payer).toBe(VERIFY + DESK);
      expect(after.recipient - before.recipient).toBe(VERIFY + DESK);
    }, 90_000);
  });

  describe('the careless buyer', () => {
    it('is never offered a price for a request that cannot be answered: no challenge on a 4xx, and nothing charged', async () => {
      const live = await open();
      const before = await balances();
      const cases: [string, RequestInit | undefined, number][] = [
        [`/v1/paid/verify/not-an-address`, undefined, 400],
        [`/v1/paid/verify/${(await generateKeyPairSigner()).address}`, undefined, 404],
        [`/v1/paid/verify/${live}`, undefined, 409], // not settled
        [`/v1/paid/bundle/${live}`, undefined, 409],
        [`/v1/paid/order-desk`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }, 400],
        [`/v1/paid/order-desk`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(order(live, { price: '1610000' })) }, 400], // off the grid
        [`/v1/paid/order-desk`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(order(live, { side: 'hold' })) }, 400],
      ];
      for (const [path, init, status] of cases) {
        const res = await fetch(w.base + path, init);
        expect(res.status, path).toBe(status);
        expect(res.headers.get('www-authenticate'), path).toBeNull();
        expect(res.headers.get('payment-required'), path).toBeNull();
        const text = await res.text();
        expect(text, path).not.toMatch(/"accepts"/);
      }
      expect(await balances()).toEqual(before);
    });

    it('a paying client refuses a price above its own limit before signing anything, and the server never sees a payment', async () => {
      const cross = await finalized();
      const before = await balances();
      await expect(payOver('mpp', { ...w.limits, maxAmount: VERIFY - 1n })(`${w.base}/v1/paid/verify/${cross}`)).rejects.toThrow(/above the limit/);
      expect(await balances()).toEqual(before);
    });

    it('a failure after the payment verified charges nothing: the work runs before the money moves', async () => {
      // Replace the simulation with one that fails the way a down RPC does. The order desk's `full` runs it before settlement.
      const live = await open();
      const broken = Fastify();
      broken.setErrorHandler((err, _req, reply) => reply.code(500).send({ error: String(err) }));
      const gate = new X402Gate({
        facilitator: new LocalFacilitator({ rpc, network: await networkOf(rpc), signers: [w.feePayer], policy: { payTo: [w.recipient.address], assets: [w.mint.address] }, pollMs: 100, confirmTimeoutMs: 30_000 }),
        ledger: new PaymentLedger(w.db),
        network: await networkOf(rpc),
        asset: w.mint.address,
        payTo: w.recipient.address,
        secret: randomBytes(32),
        mpp: { realm: 'api.test', network: 'localnet', decimals: 6, tokenProgram: TOKEN_PROGRAM_ADDRESS },
      });
      registerPaid(broken, { db: w.db, account: w.chain.read, lifetime: async () => ({ blockhash: '4NCYB3kRT8sCNodPNuCZo8VUh4xqpBQxsxed2wd9xaD4' as never, lastValidBlockHeight: 1n }), clock: () => NOW, network: 'localnet' }, {
        gate,
        simulate: async () => {
          throw new Error('the RPC is down');
        },
      });
      await broken.listen({ port: 0, host: '127.0.0.1' });
      const base = `http://127.0.0.1:${(broken.server.address() as { port: number }).port}`;
      const before = await balances();
      const rows = (await w.db.query('SELECT count(*)::int AS n FROM x402_payments')).rows[0].n;
      const { response } = await payOver('mpp')(`${base}/v1/paid/order-desk`, post(live));
      expect(response.status).toBeGreaterThanOrEqual(500);
      expect(await balances()).toEqual(before);
      expect((await w.db.query('SELECT count(*)::int AS n FROM x402_payments')).rows[0].n).toBe(rows);
      await broken.close();
    }, 90_000);
  });

  describe('an agent that has never seen this server', () => {
    it.skipIf(!process.env.MPP_INTEROP_DIR)('the official @solana/mpp client pays the verify route with no SOL at all, and the server sponsors the fee', async () => {
      const { webcrypto } = await import('node:crypto');
      const dir = process.env.MPP_INTEROP_DIR!;
      copyFileSync(new URL('./support/mpp-official-client.mjs', import.meta.url), `${dir}/client.mjs`);
      const pair = (await webcrypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])) as CryptoKeyPair;
      const secret = Buffer.from(await webcrypto.subtle.exportKey('pkcs8', pair.privateKey)).subarray(-32);
      const pub = Buffer.from(await webcrypto.subtle.exportKey('raw', pair.publicKey));
      const { createKeyPairSignerFromBytes } = await import('@solana/kit');
      const buyer = await createKeyPairSignerFromBytes(Uint8Array.from([...secret, ...pub]));
      await mintTo(w.authority, w.authority, w.mint.address, buyer.address, 1_000_000n, TOKEN_PROGRAM_ADDRESS);
      const cross = await finalized();
      const before = [await tokenBalance(buyer.address, w.mint.address, TOKEN_PROGRAM_ADDRESS), await tokenBalance(w.recipient.address, w.mint.address, TOKEN_PROGRAM_ADDRESS), await lamportBalance(buyer.address)];
      const { stdout } = await promisify(execFile)(process.execPath, ['client.mjs', `${w.base}/v1/paid/verify/${cross}`], {
        cwd: dir,
        env: { ...process.env, SECRET_KEY: JSON.stringify([...secret, ...pub]), RPC_URL: process.env.X402_TEST_RPC ?? 'http://127.0.0.1:8940', ALLOW_UNKNOWN_TOKEN2022: '0' },
        timeout: 90_000,
      });
      const out = JSON.parse(stdout.trim().split(/\r?\n/).at(-1)!) as { status: number; body: string; receipt: { reference: string; status: string } | null };
      expect(out.status, out.body).toBe(200);
      const doc = JSON.parse(out.body) as { receipt: { signer: string; body: { cross: string; verified: boolean } } };
      expect(doc.receipt.body).toMatchObject({ cross, verified: true });
      expect(await verifyDocument(doc.receipt as never, w.signer.address)).toEqual({ ok: true });
      expect(out.receipt).toMatchObject({ status: 'success' });
      expect(before[0]! - (await tokenBalance(buyer.address, w.mint.address, TOKEN_PROGRAM_ADDRESS))).toBe(VERIFY);
      expect((await tokenBalance(w.recipient.address, w.mint.address, TOKEN_PROGRAM_ADDRESS)) - before[1]!).toBe(VERIFY);
      expect(await lamportBalance(buyer.address)).toBe(before[2]);
    }, 150_000);
  });

  it('the ledger holds exactly the payments the routes sold, each once', async () => {
    const all = (await w.db.query('SELECT signature, route, protocol, amount::text FROM x402_payments')).rows as { signature: string; route: string; protocol: string; amount: string }[];
    expect(new Set(all.map((r) => r.signature)).size).toBe(all.length);
    expect(all.map((r) => r.route).every((r) => ['/v1/paid/verify/:cross', '/v1/paid/bundle/:cross', '/v1/paid/order-desk'].includes(r))).toBe(true);
    expect(all.filter((r) => r.protocol === 'mpp').length).toBeGreaterThanOrEqual(3);
    void ({} as Address);
  });
});
