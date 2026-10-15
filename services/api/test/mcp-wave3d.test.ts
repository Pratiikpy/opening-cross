// The MCP tools for the seven Wave 3D programs against the whole API server (every route group registered over every migration): each read tool reaches a route that exists and answers
// without a server error, and each draft tool's body is accepted by the real route (a domain refusal is fine; "unknown field" or a malformed body is not). The tool catalog is read
// from services/mcp/src/tools.ts, which has no dependencies.
import { describe, expect, it } from 'vitest';
import { AllowKind, getMandateEncoder } from '@opening-cross/cross-mandate-client';
import { CROSS_MANDATE_PROGRAM_ADDRESS, mandateAddresses } from '@opening-cross/sdk';
import { buildServer } from '../src/server.js';
import { NEW_PROGRAM_INSTRUCTIONS } from '../src/routes/programs-catalog.js';
import { TOOLS } from '../../mcp/src/tools.js';
import { Chain, NOW, SPL, database, key } from './helpers/wave3d.js';

const HEX = 'cd'.repeat(32);
const READ_TOOLS = [
  'oc_get_mandate', 'oc_list_mandates', 'oc_get_mandate_activity', 'oc_check_agent_transaction', 'oc_get_conviction', 'oc_get_conviction_lock', 'oc_get_basket', 'oc_quote_basket', 'oc_list_baskets', 'oc_get_listing_venue',
  'oc_get_listing', 'oc_get_cross_listings', 'oc_get_bounty', 'oc_list_bounties', 'oc_get_cross_invariants', 'oc_get_backing', 'oc_get_graduation', 'oc_get_graduation_round', 'oc_get_program_release',
];

describe('the Wave 3D MCP tools against the real API', () => {
  it('every read tool reaches a registered route and none is answered with a server error; every mandate draft is accepted by its route', async () => {
    const chain = new Chain();
    const [owner, agent, creator, quote, base, stranger] = await Promise.all([key(), key(), key(), key(), key(), key()]);
    chain.mint(quote);
    chain.mint(base, { supply: 1_000_000n });
    chain.deploy('crossMandate', NEW_PROGRAM_INSTRUCTIONS.crossMandate.map(([, d]) => d));
    const { mandate, signer, vault } = await mandateAddresses(owner, 0n, quote, SPL);
    chain.put(mandate, CROSS_MANDATE_PROGRAM_ADDRESS, getMandateEncoder().encode({ owner, agent, id: 0n, quoteMint: quote, quoteTokenProgram: SPL, maxPerOrder: 1_000_000_000n, totalCap: 5_000_000_000n, committed: 0n, maxShareBps: 2_500, expiresAt: BigInt(NOW + 86_400 * 30), revoked: false, allow: [{ kind: AllowKind.Creator, key: creator }], bump: 1, signerBump: 1 }));
    await chain.token(owner, quote, 10_000_000_000n);
    chain.tokenAt(vault, signer, quote, 4_000_000_000n);
    const cross = await chain.cross({ creator, quoteMint: quote, baseMint: base, ext: { totalSupply: 1_000_000n } });
    const { db } = await database();
    const app = await buildServer({ db: db as never, network: 'devnet', account: chain.account, lifetime: chain.lifetime, clock: () => NOW, w2a: false } as never);
    await app.ready();

    // sample arguments by the schema: an address for every address, a number for every number
    const sample = (name: string, schema: Record<string, any>): Record<string, unknown> => {
      const out: Record<string, unknown> = {};
      const known: Record<string, unknown> = { mandate, cross, owner, agent, caller: owner, creator, mint: base, basket: stranger, lock: stranger, venue: stranger, lister: stranger, listing: stranger, bounty: stranger, sponsor: stranger, round: stranger, voter: stranger, shares: '1500000', side: 'mint', nonce: '0', price: '1300000', quantity: '1000', salt: HEX, transaction: 'AQID', amount: '10', escrow: '1300' };
      for (const k of Object.keys(schema.properties ?? {})) if (k in known) out[k] = known[k];
      void name;
      return out;
    };
    const seenRoutes: string[] = [];
    for (const t of READ_TOOLS.map((n) => TOOLS.find((x) => x.name === n) ?? expect.fail(`${n} is not in the catalog`))) {
      const args = sample(t.name, t.inputSchema as Record<string, any>);
      const req = t.request(args);
      const res = await app.inject({ method: req.method, url: req.path, ...(req.body ? { payload: req.body as never } : {}) });
      const body = JSON.parse(res.body) as { error?: string };
      expect(body.error, `${t.name}: ${req.method} ${req.path}`).not.toBe('no such route');
      expect(res.statusCode, `${t.name} ${req.path}: ${res.body}`).toBeLessThan(500);
      seenRoutes.push(t.name);
    }
    expect(seenRoutes).toHaveLength(READ_TOOLS.length);

    for (const name of ['oc_draft_mandate_place_order', 'oc_draft_mandate_cancel_order', 'oc_draft_mandate_reveal_order', 'oc_draft_mandate_revoke', 'oc_draft_mandate_withdraw']) {
      const t = TOOLS.find((x) => x.name === name)!;
      const args = sample(name, t.inputSchema as Record<string, any>);
      if (name === 'oc_draft_mandate_place_order') args.agent = agent;
      const req = t.request(args);
      const res = await app.inject({ method: 'POST', url: req.path, payload: req.body as never });
      const body = JSON.parse(res.body) as { error?: string; reason?: string; transaction?: string };
      // 200 (a draft), or a refusal that names a program or chain reason: never a 400 about the body, never a 404 for a missing route
      expect(res.statusCode, `${name}: ${res.body}`).not.toBe(400);
      expect(body.error, name).not.toBe('no such route');
      if (res.statusCode !== 200) expect(body.reason, `${name}: ${res.body}`).toBeTruthy();
    }

    // the agent's draft passes the guard the agent runs before it signs, and the owner's withdrawal does not
    const place = await app.inject({ method: 'POST', url: '/v1/tx/mandate-place-order', payload: { agent, mandate, cross, price: '1300000', quantity: '1000' } as never });
    expect(place.statusCode, place.body).toBe(200);
    const guard = async (transaction: string) => JSON.parse((await app.inject({ method: 'POST', url: '/v1/mandates/check-transaction', payload: { transaction } as never })).body) as { ok: boolean };
    expect((await guard(JSON.parse(place.body).transaction)).ok).toBe(true);
    const withdraw = await app.inject({ method: 'POST', url: '/v1/tx/mandate-withdraw', payload: { owner, mandate } as never });
    expect(withdraw.statusCode, withdraw.body).toBe(200);
    expect((await guard(JSON.parse(withdraw.body).transaction)).ok).toBe(false);
  }, 90_000);
});
