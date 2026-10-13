// All W2A route groups register together on one server without colliding, from the environment, and skipping works.
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { GROUPS, registerW2A } from '../src/routes/w2a.js';
import { Chain, databaseUrl, openSchema } from './helpers/w2a.js';

const describeDb = databaseUrl ? describe : describe.skip;
if (!databaseUrl) console.warn('w2a.test.ts: SKIPPED; set DATABASE_URL to a Postgres to run it');

const ROUTES: [string, string][] = [
  ['GET', '/v1/liquidity/makers'],
  ['GET', '/v1/paid/verify/:cross'],
  ['POST', '/v1/paid/order-desk'],
  ['GET', '/v1/attestations/signer'],
  ['GET', '/actions.json'],
  ['GET', '/v1/blinks/cross/:address'],
  ['POST', '/v1/route/execute'],
  ['POST', '/v1/intents'],
  ['GET', '/v1/fees/schedule'],
  ['GET', '/v1/fees/ledger'],
  ['POST', '/v1/referrals'],
  ['GET', '/v1/tokens/:mint/duplicates'],
  ['GET', '/v1/integrity/mint/:mint/holders'],
  ['GET', '/v1/integrity/cross/:address/conflicts'],
  ['GET', '/v1/integrity/cross/:address/organic'],
  ['GET', '/v1/integrity/cross/:address/rating'],
  ['GET', '/v1/integrity/cross/:address/brief'],
  ['POST', '/v1/integrity/verify-claims'],
  ['POST', '/v1/integrity/documents'],
  ['GET', '/v1/integrity/ratings/track-record'],
  ['POST', '/v1/presets'],
  ['GET', '/v1/presets'],
  ['GET', '/v1/presets/:author/:id/performance'],
  ['GET', '/v1/agents/assets/:asset'],
  ['GET', '/v1/crosses/:address/agents'],
  ['GET', '/v1/dashboard'],
];

describeDb('registerW2A', () => {
  let db: pg.Pool;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ db, close } = await openSchema());
  });
  afterAll(async () => close());

  const deps = () => ({ db, account: new Chain().read, lifetime: async () => ({ blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 1n }), network: 'devnet' }) as never;

  it('registers every group, every route exists once, and pay-per-call stays off without its configuration', async () => {
    const app = Fastify();
    const w = await registerW2A(app, deps(), { RPC_URL: 'https://api.devnet.solana.com,https://solana-devnet.api.onfinality.io/public' });
    await app.ready();
    expect(w.registered).toEqual([...GROUPS]);
    for (const [method, url] of ROUTES) expect(app.hasRoute({ method: method as 'GET', url }), `${method} ${url}`).toBe(true);
    expect(w.reconcile).toBeNull();
    expect(w.rpc.pool.urls).toHaveLength(2);
    const paid = await app.inject({ method: 'GET', url: `/v1/paid/verify/${'A'.repeat(32)}` });
    expect(paid.statusCode).toBe(501);
    // The dashboard reports sections whose routes this tiny server does not have as unavailable, not as failures of the dashboard.
    const dash = (await app.inject({ method: 'GET', url: '/v1/dashboard' })).json();
    expect(dash.sections.totals.ok).toBe(false);
    expect(dash.sections.totals.error).toMatch(/not enabled/);
    expect(dash.sections.protocol.source).toBe('/v1/fees/schedule');
    await app.close();
  });

  it('leaves out the groups it is told to, refuses a group that does not exist, and needs an RPC', async () => {
    const app = Fastify();
    const w = await registerW2A(app, deps(), { RPC_URL: 'https://api.devnet.solana.com', W2A_SKIP: 'dashboard, agents' });
    expect(w.registered).not.toContain('dashboard');
    expect(w.registered).not.toContain('agents');
    expect(app.hasRoute({ method: 'GET', url: '/v1/dashboard' })).toBe(false);
    expect(app.hasRoute({ method: 'GET', url: '/v1/presets' })).toBe(true);
    await app.close();
    await expect(registerW2A(Fastify(), deps(), { RPC_URL: 'https://x.test', W2A_SKIP: 'nonsense' })).rejects.toThrow(/unknown group "nonsense"/);
    await expect(registerW2A(Fastify(), deps(), {})).rejects.toThrow(/RPC_URL is required/);
  });

  it('turns pay-per-call on only when it is fully configured, and says what is missing otherwise', async () => {
    await expect(registerW2A(Fastify(), deps(), { RPC_URL: 'https://x.test', X402_ENABLED: '1' })).rejects.toThrow(/X402_ASSET is required/);
  });
});
