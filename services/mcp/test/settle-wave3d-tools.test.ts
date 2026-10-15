// The two drafts for the markets a cleared cross opens without a pool (X3 MetaDAO futarchy DAO, B4 fixed-price tranche): the request each tool makes, that the schema is as strict as the
// API route behind it, that a bad argument is refused before any request leaves the server, and what an agent is told about who signs.
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { type ApiCall, TOOLS, createServer } from '../src/index.js';

const CROSS = 'F5k8EDDXBF24xgt4Y8MMtwPZFH9TikJvJcNmD1NJQPnZ';
const CREATOR = 'DTB3Jtxb6dy7GvocUbypiJb548ZLGRzVdPrNNCWAKEdC';
const BASE = 'So11111111111111111111111111111111111111112';
const tool = (name: string) => TOOLS.find((t) => t.name === name)!;

const TERMS = { maxCap: '5000000000', minCap: '1000000000', start: '1800000000', end: '1800086400', supply: '2000000000', buyerMinDeposit: '1000000', buyerMaxDeposit: '500000000' };
const FULL_TERMS = { ...TERMS, depositFeeBps: 50, immediatelyReleaseBps: 2500, lockDuration: '86400', vestDuration: '604800', unsoldTokenAction: 1 };

async function connect(api: ApiCall) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createServer(api).connect(a);
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(b);
  return client;
}
type Result = { isError?: boolean; content: { type: string; text?: string }[]; structuredContent?: Record<string, unknown> };

describe('oc_draft_open_fixed_price_presale', () => {
  const t = () => tool('oc_draft_open_fixed_price_presale');

  it('is a draft that posts exactly the fields POST /v1/tx/open-fixed-price-presale takes', () => {
    expect(t().kind).toBe('draft');
    const args = { cross: CROSS, creator: CREATOR, base: BASE, terms: FULL_TERMS, disableWithdraw: true };
    expect(t().request(args)).toEqual({ method: 'POST', path: '/v1/tx/open-fixed-price-presale', body: args });
    // a field the route does not know never leaves the server
    expect(t().request({ ...args, extra: 'x', owner: CREATOR }).body).toEqual(args);
    // the optional flag and the optional terms are left out when not given
    expect(t().request({ cross: CROSS, creator: CREATOR, base: BASE, terms: TERMS }).body).toEqual({ cross: CROSS, creator: CREATOR, base: BASE, terms: TERMS });
  });

  it('requires what the route requires, and no more', () => {
    expect(t().inputSchema).toMatchObject({ additionalProperties: false, required: ['cross', 'creator', 'base', 'terms'] });
    const terms = (t().inputSchema as { properties: { terms: Record<string, unknown> } }).properties.terms;
    expect(terms).toMatchObject({ additionalProperties: false, required: ['maxCap', 'minCap', 'start', 'end', 'supply', 'buyerMinDeposit', 'buyerMaxDeposit'] });
    // every term the route's `only(...)` list accepts is in the schema, and nothing else
    expect(Object.keys((terms as { properties: object }).properties).sort()).toEqual(['buyerMaxDeposit', 'buyerMinDeposit', 'depositFeeBps', 'end', 'immediatelyReleaseBps', 'lockDuration', 'maxCap', 'minCap', 'start', 'supply', 'unsoldTokenAction', 'vestDuration']);
  });

  it('tells an agent who signs, what it does not move, and that buyers use Meteora', () => {
    expect(t().description).toMatch(/CREATOR signs/);
    expect(t().description).toMatch(/UNSIGNED/);
    expect(t().description).toMatch(/fresh keypair/);
    expect(t().description).toMatch(/Meteora's own program/);
    expect(t().untrusted).toEqual([]);
  });
});

describe('oc_draft_open_futarchy_dao', () => {
  const t = () => tool('oc_draft_open_futarchy_dao');

  it('is a draft that posts exactly the fields POST /v1/tx/seed-futarchy-dao takes', () => {
    expect(t().kind).toBe('draft');
    const settings = { twapMaxObservationChangePerUpdate: '1000', twapStartDelaySeconds: 60, minQuoteFutarchicLiquidity: '1', minBaseFutarchicLiquidity: '1', baseToStake: '5', passThresholdBps: 300, secondsPerProposal: 259200, teamSponsoredPassThresholdBps: -300 };
    const args = { cross: CROSS, creator: CREATOR, baseAmount: '5000000000', quoteAmount: '6500000', nonce: '2', settings };
    expect(t().request(args)).toEqual({ method: 'POST', path: '/v1/tx/seed-futarchy-dao', body: args });
    expect(t().request({ ...args, extra: 'x' }).body).toEqual(args);
    expect(t().request({ cross: CROSS, creator: CREATOR, baseAmount: '5' }).body).toEqual({ cross: CROSS, creator: CREATOR, baseAmount: '5' });
  });

  it('requires the cross, the creator and the base amount; the quote amount, nonce and settings are optional', () => {
    expect(t().inputSchema).toMatchObject({ additionalProperties: false, required: ['cross', 'creator', 'baseAmount'] });
    const settings = (t().inputSchema as { properties: { settings: Record<string, unknown> } }).properties.settings;
    expect(settings).toMatchObject({ additionalProperties: false, required: [] });
    expect(Object.keys((settings as { properties: object }).properties).sort()).toEqual(['baseToStake', 'minBaseFutarchicLiquidity', 'minQuoteFutarchicLiquidity', 'passThresholdBps', 'secondsPerProposal', 'teamSponsoredPassThresholdBps', 'twapMaxObservationChangePerUpdate', 'twapStartDelaySeconds']);
  });

  it('tells an agent who signs and the two limits that decide whether the API will build it', () => {
    expect(t().description).toMatch(/CREATOR signs/);
    expect(t().description).toMatch(/Legacy SPL Token/);
    expect(t().description).toMatch(/6 decimals/);
    expect(t().description).toMatch(/governed-graduation/);
  });

  it('is not named like a key tool (the server guards names containing "seed")', () => {
    expect(t().name).not.toMatch(/key|seed/);
  });
});

describe('the two drafts through the server', () => {
  it('forward a valid call to the API and return its body, with the API\'s refusal reason when it refuses', async () => {
    const seen: { method: string; path: string; body?: Record<string, unknown> }[] = [];
    const api: ApiCall = async (req) => {
      seen.push({ method: req.method, path: req.path, ...(req.body && { body: req.body }) });
      if (req.path.endsWith('presale')) return { status: 409, body: { error: 'The program is not deployed on this cluster.', reason: 'PROGRAM_NOT_DEPLOYED' } };
      return { status: 200, body: { transaction: 'AQID', dao: BASE } };
    };
    const c = await connect(api);
    const refused = (await c.callTool({ name: 'oc_draft_open_fixed_price_presale', arguments: { cross: CROSS, creator: CREATOR, base: BASE, terms: TERMS } })) as Result;
    expect(refused.isError).toBe(true);
    expect(JSON.parse(refused.content[0]!.text!)).toEqual({ error: { code: 'CONFLICT', message: 'The program is not deployed on this cluster.', status: 409 } });
    const ok = (await c.callTool({ name: 'oc_draft_open_futarchy_dao', arguments: { cross: CROSS, creator: CREATOR, baseAmount: '5000000000' } })) as Result;
    expect(ok.isError).toBeFalsy();
    expect(ok.structuredContent).toEqual({ transaction: 'AQID', dao: BASE });
    expect(seen.map((s) => `${s.method} ${s.path}`)).toEqual(['POST /v1/tx/open-fixed-price-presale', 'POST /v1/tx/seed-futarchy-dao']);
    await c.close();
  });

  it('refuses a malformed call before any request is made', async () => {
    const seen: unknown[] = [];
    const c = await connect(async (req) => (seen.push(req), { status: 200, body: {} }));
    const bad: [string, Record<string, unknown>][] = [
      ['oc_draft_open_fixed_price_presale', { cross: CROSS, creator: CREATOR, base: BASE }], // no terms
      ['oc_draft_open_fixed_price_presale', { cross: CROSS, creator: CREATOR, base: BASE, terms: { ...TERMS, maxCap: 'lots' } }],
      ['oc_draft_open_fixed_price_presale', { cross: CROSS, creator: CREATOR, base: BASE, terms: { ...TERMS, maxCap: '-5' } }],
      ['oc_draft_open_fixed_price_presale', { cross: CROSS, creator: CREATOR, base: BASE, terms: { ...TERMS, price: '1' } }], // a price cannot be set: it is the clearing price
      ['oc_draft_open_fixed_price_presale', { cross: CROSS, creator: CREATOR, base: BASE, terms: { ...TERMS, depositFeeBps: 10001 } }],
      ['oc_draft_open_fixed_price_presale', { cross: CROSS, creator: 'not-an-address', base: BASE, terms: TERMS }],
      ['oc_draft_open_fixed_price_presale', { cross: CROSS, creator: CREATOR, base: BASE, terms: TERMS, disableWithdraw: 'yes' }],
      ['oc_draft_open_futarchy_dao', { cross: CROSS, creator: CREATOR }], // no base amount
      ['oc_draft_open_futarchy_dao', { cross: CROSS, creator: CREATOR, baseAmount: 'x' }],
      ['oc_draft_open_futarchy_dao', { cross: CROSS, creator: CREATOR, baseAmount: '5', settings: { passThresholdBps: 70000 } }],
      ['oc_draft_open_futarchy_dao', { cross: CROSS, creator: CREATOR, baseAmount: '5', settings: { unknown: 1 } }],
      ['oc_draft_open_futarchy_dao', { cross: CROSS, creator: CREATOR, baseAmount: '5', startPrice: '1' }], // the start price is the clearing price, not an argument
    ];
    for (const [name, args] of bad) expect((await c.callTool({ name, arguments: args }) as Result).isError, `${name} ${JSON.stringify(args)}`).toBe(true);
    expect(seen).toEqual([]);
    await c.close();
  });
});
