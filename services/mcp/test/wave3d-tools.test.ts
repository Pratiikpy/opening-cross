// The tools for the seven Wave 3D programs: what request each one makes, which are reads and which are drafts, what an agent is told about its key, and that every tool of the
// catalog still lands on a route the API registers (tools-routes.test.ts walks the API sources for that).
import { describe, expect, it } from 'vitest';
import { TOOLS } from '../src/index.js';

const A = 'F5k8EDDXBF24xgt4Y8MMtwPZFH9TikJvJcNmD1NJQPnZ';
const B = 'DTB3Jtxb6dy7GvocUbypiJb548ZLGRzVdPrNNCWAKEdC';
const tool = (name: string) => TOOLS.find((t) => t.name === name)!;
const HEX = 'ab'.repeat(32);

const READS: Record<string, { args: Record<string, unknown>; method: 'GET' | 'POST'; path: string; body?: Record<string, unknown> }> = {
  oc_get_mandate: { args: { mandate: A }, method: 'GET', path: `/v1/mandates/${A}` },
  oc_list_mandates: { args: { owner: A, agent: B, limit: 5 }, method: 'GET', path: `/v1/mandates?owner=${A}&agent=${B}&limit=5` },
  oc_get_mandate_activity: { args: { mandate: A }, method: 'GET', path: `/v1/mandates/${A}/activity` },
  oc_check_agent_transaction: { args: { transaction: 'AQID' }, method: 'POST', path: '/v1/mandates/check-transaction', body: { transaction: 'AQID' } },
  oc_get_conviction: { args: { owner: A }, method: 'GET', path: `/v1/owners/${A}/conviction` },
  oc_get_conviction_lock: { args: { lock: A }, method: 'GET', path: `/v1/conviction/locks/${A}` },
  oc_get_basket: { args: { basket: A }, method: 'GET', path: `/v1/baskets/${A}` },
  oc_quote_basket: { args: { basket: A, shares: '1500000', side: 'mint' }, method: 'GET', path: `/v1/baskets/${A}/quote?shares=1500000&side=mint` },
  oc_list_baskets: { args: { creator: A }, method: 'GET', path: `/v1/baskets?creator=${A}&limit=50` },
  oc_get_listing_venue: { args: { venue: A, lister: B }, method: 'GET', path: `/v1/listing/venues/${A}?lister=${B}` },
  oc_get_listing: { args: { listing: A }, method: 'GET', path: `/v1/listing/listings/${A}` },
  oc_get_cross_listings: { args: { cross: A }, method: 'GET', path: `/v1/crosses/${A}/listings` },
  oc_get_bounty: { args: { bounty: A }, method: 'GET', path: `/v1/bounties/${A}` },
  oc_list_bounties: { args: { sponsor: B, limit: 10 }, method: 'GET', path: `/v1/bounties?sponsor=${B}&limit=10` },
  oc_get_cross_invariants: { args: { cross: A }, method: 'GET', path: `/v1/crosses/${A}/invariants` },
  oc_get_backing: { args: { mint: A }, method: 'GET', path: `/v1/assets/${A}/backing` },
  oc_get_graduation: { args: { cross: A }, method: 'GET', path: `/v1/crosses/${A}/graduation` },
  oc_get_graduation_round: { args: { round: A, voter: B }, method: 'GET', path: `/v1/graduation/rounds/${A}?voter=${B}` },
};

const DRAFTS: Record<string, { args: Record<string, unknown>; path: string; body: Record<string, unknown>; required: string[] }> = {
  oc_draft_mandate_place_order: { args: { agent: B, mandate: A, cross: A, price: '1300000', quantity: '1000', nonce: '3', escrow: '1300', salt: HEX }, path: '/v1/tx/mandate-place-order', body: { agent: B, mandate: A, cross: A, price: '1300000', quantity: '1000', nonce: '3', escrow: '1300', salt: HEX }, required: ['agent', 'mandate', 'cross', 'price', 'quantity'] },
  oc_draft_mandate_cancel_order: { args: { caller: B, mandate: A, cross: A, nonce: '3' }, path: '/v1/tx/mandate-cancel-order', body: { caller: B, mandate: A, cross: A, nonce: '3' }, required: ['caller', 'mandate', 'cross', 'nonce'] },
  oc_draft_mandate_reveal_order: { args: { caller: B, mandate: A, cross: A, nonce: '3', price: '1', quantity: '2', salt: HEX }, path: '/v1/tx/mandate-reveal-order', body: { caller: B, mandate: A, cross: A, nonce: '3', price: '1', quantity: '2', salt: HEX }, required: ['caller', 'mandate', 'cross', 'nonce', 'price', 'quantity', 'salt'] },
  oc_draft_mandate_revoke: { args: { owner: B, mandate: A }, path: '/v1/tx/mandate-revoke', body: { owner: B, mandate: A }, required: ['owner', 'mandate'] },
  oc_draft_mandate_withdraw: { args: { owner: B, mandate: A, amount: '10' }, path: '/v1/tx/mandate-withdraw', body: { owner: B, mandate: A, amount: '10' }, required: ['owner', 'mandate'] },
};

describe('Wave 3D read tools', () => {
  for (const [name, c] of Object.entries(READS)) {
    it(`${name} is a read tool that calls ${c.method} ${c.path.replace(/[1-9A-HJ-NP-Za-km-z]{32,44}/g, ':x')}`, () => {
      const t = tool(name);
      expect(t, `${name} is in the catalog`).toBeDefined();
      expect(t.kind).toBe('read');
      const req = t.request(c.args);
      expect(req).toMatchObject({ method: c.method, path: c.path });
      if (c.body) expect(req.body).toEqual(c.body);
      expect(t.inputSchema).toMatchObject({ additionalProperties: false });
      expect(t.description.length).toBeGreaterThan(40);
    });
  }

  it('leaves the optional filters out of the path when they are not given', () => {
    expect(tool('oc_list_mandates').request({}).path).toBe('/v1/mandates?limit=50');
    expect(tool('oc_list_mandates').request({ owner: A }).path).toBe(`/v1/mandates?owner=${A}&limit=50`);
    expect(tool('oc_get_listing_venue').request({ venue: A }).path).toBe(`/v1/listing/venues/${A}`);
    expect(tool('oc_get_graduation_round').request({ round: A }).path).toBe(`/v1/graduation/rounds/${A}`);
    expect(tool('oc_list_bounties').request({}).path).toBe('/v1/bounties?limit=50');
  });

  it('require what the route requires', () => {
    expect(tool('oc_quote_basket').inputSchema).toMatchObject({ required: ['basket', 'shares', 'side'] });
    expect(tool('oc_get_listing_venue').inputSchema).toMatchObject({ required: ['venue'] });
    expect(tool('oc_list_mandates').inputSchema).toMatchObject({ required: [] });
  });
});

describe('Wave 3D draft tools: the mandate\'s agent and owner', () => {
  for (const [name, c] of Object.entries(DRAFTS)) {
    it(`${name} drafts ${c.path} and passes exactly the fields the route takes`, () => {
      const t = tool(name);
      expect(t.kind).toBe('draft');
      expect(t.request(c.args)).toEqual({ method: 'POST', path: c.path, body: c.body });
      expect(t.inputSchema).toMatchObject({ additionalProperties: false, required: c.required });
      // a field the route does not know is not passed along
      expect(t.request({ ...c.args, extra: 'x' }).body).toEqual(c.body);
    });
  }

  it('tells an agent which key signs what: the agent places, the owner revokes and withdraws, and the guard runs first', () => {
    expect(tool('oc_draft_mandate_place_order').description).toMatch(/AGENT key signs/);
    expect(tool('oc_draft_mandate_place_order').description).toMatch(/oc_check_agent_transaction/);
    expect(tool('oc_draft_mandate_revoke').description).toMatch(/Only the OWNER signs/);
    expect(tool('oc_draft_mandate_revoke').description).toMatch(/agent key must never/);
    expect(tool('oc_draft_mandate_withdraw').description).toMatch(/Only the OWNER signs/);
    expect(tool('oc_check_agent_transaction').description).toMatch(/place_order, cancel_order and reveal_order/);
    expect(tool('oc_check_agent_transaction').kind).toBe('read');
  });

  it('offers an agent no tool that creates, funds, re-limits or empties a mandate on the agent\'s behalf', () => {
    const names = TOOLS.map((t) => t.name).filter((n) => n.includes('mandate'));
    for (const forbidden of ['create', 'fund', 'set_limits', 'sweep']) expect(names.filter((n) => n.includes(forbidden)), forbidden).toEqual([]);
    // every mandate draft goes through a route the guard allows for the agent, or is the owner's revoke or withdraw
    const drafts = TOOLS.filter((t) => t.kind === 'draft' && t.name.includes('mandate')).map((t) => t.request(DRAFTS[t.name]?.args ?? {}).path);
    expect(drafts.sort()).toEqual(['/v1/tx/mandate-cancel-order', '/v1/tx/mandate-place-order', '/v1/tx/mandate-reveal-order', '/v1/tx/mandate-revoke', '/v1/tx/mandate-withdraw']);
  });

  it('marks every Wave 3D tool as free of third-party text, because none returns a token\'s own name', () => {
    for (const t of TOOLS.filter((x) => Object.keys(READS).includes(x.name) || Object.keys(DRAFTS).includes(x.name))) expect(t.untrusted, t.name).toEqual([]);
  });

  it('names the program release in the release tool', () => {
    expect(tool('oc_get_program_release').description).toMatch(/seven Wave 3D programs/);
    expect(tool('oc_get_program_release').description).toMatch(/H43/);
  });
});
