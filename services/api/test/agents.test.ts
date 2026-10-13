import Fastify, { type FastifyInstance } from 'fastify';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Directory, type RpcLike } from '@opening-cross/agent-identity';
import { registerAgents } from '../src/routes/agents.js';
import { RequestError } from '../src/tx.js';
import { databaseUrl, insertCross, insertOrder, newAddress, openSchema } from './helpers/w2a.js';

const describeDb = databaseUrl ? describe : describe.skip;
if (!databaseUrl) console.warn('agents.test.ts: SKIPPED; set DATABASE_URL to a Postgres to run it');

// A real mainnet agent (asset and its Asset Signer wallet), as in packages/agent-identity.
const ASSET = '551trrW7wqEUZxTFULcs4SbedekpFgPEGMmzfzextGUi';
const WALLET = '9SyvAbtwFZa6VaPnNbztZcWw4P7Ls2YnqwzDn8PGVSvr';

describeDb('agent identity routes', () => {
  let db: pg.Pool;
  let close: () => Promise<void>;
  let app: FastifyInstance;
  let bare: FastifyInstance;
  const dir: Directory = { wallets: new Map([[WALLET, ASSET]]), loadedAt: 5, count: 68 };
  const rpc: RpcLike = { call: async () => ({ value: [null, null] }) as never };

  const get = async (url: string, a = app) => {
    const r = await a.inject({ method: 'GET', url });
    return { status: r.statusCode, body: r.json() };
  };

  beforeAll(async () => {
    ({ db, close } = await openSchema());
    const mk = (opts: Parameters<typeof registerAgents>[2]) => {
      const a = Fastify();
      a.setErrorHandler((err, _req, reply) => (err instanceof RequestError ? reply.code(err.status).send({ error: err.message }) : reply.code(500).send({ error: String(err) })));
      registerAgents(a, { db, network: 'test' }, opts);
      return a;
    };
    app = mk({ rpc, directory: async () => dir });
    bare = mk({ rpc: null });
    await app.ready();
    await bare.ready();
  });
  afterAll(async () => {
    await app.close();
    await bare.close();
    await close();
  });

  it('says whether an asset is a registered agent, with the reasons when it is not', async () => {
    const r = await get(`/v1/agents/assets/${ASSET}`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ registered: false, wallet: WALLET });
    expect(r.body.reasons.join(' ')).toMatch(/No identity record/);
    expect((await get('/v1/agents/assets/nope')).status).toBe(400);
  });

  it('says whether a wallet is the wallet of a registered agent', async () => {
    const yes = await get(`/v1/agents/wallets/${WALLET}`);
    expect(yes.body).toMatchObject({ registeredAgent: true, asset: ASSET, directory: { agents: 68 } });
    const no = await get(`/v1/agents/wallets/${await newAddress()}`);
    expect(no.body).toMatchObject({ registeredAgent: false, asset: null });
    expect(no.body.note).toMatch(/ordinary wallet is not recognised/);
  });

  it('finds the agents among a cross\'s bidders and checks the issuer\'s policy', async () => {
    const c = await newAddress();
    await insertCross(db, c);
    await insertOrder(db, c, 0, WALLET, 'buy', 1_500_000n, 300n);
    await insertOrder(db, c, 1, await newAddress(), 'buy', 1_500_000n, 700n);
    await insertOrder(db, c, 2, await newAddress(), 'sell', 1_400_000n, 500n, 'cancelled');
    const allow = await get(`/v1/crosses/${c}/agents`);
    expect(allow.body).toMatchObject({ compliant: true, agentOrders: 1, orders: 2, agentShareBps: 3000 });
    expect(allow.body.agentWallets).toEqual([{ wallet: WALLET, asset: ASSET, orders: 1 }]);
    expect((await get(`/v1/crosses/${c}/agents?policy=deny`)).body).toMatchObject({ compliant: false });
    expect((await get(`/v1/crosses/${c}/agents?policy=limit&maxShareBps=3000`)).body.compliant).toBe(true);
    expect((await get(`/v1/crosses/${c}/agents?policy=limit&maxShareBps=2999`)).body.compliant).toBe(false);
    expect((await get(`/v1/crosses/${c}/agents?policy=limit`)).status).toBe(400);
    expect((await get(`/v1/crosses/${c}/agents?policy=ban`)).status).toBe(400);
    expect((await get(`/v1/crosses/${await newAddress()}/agents`)).status).toBe(404);
  });

  it('says plainly when no RPC is configured instead of answering without one', async () => {
    for (const url of [`/v1/agents/assets/${ASSET}`, `/v1/agents/wallets/${WALLET}`, `/v1/crosses/${ASSET}/agents`]) {
      const r = await get(url, bare);
      expect(r.status, url).toBe(503);
      expect(r.body.error).toMatch(/not enabled/);
    }
  });
});
