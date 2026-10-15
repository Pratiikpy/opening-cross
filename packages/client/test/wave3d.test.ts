// The client methods for the seven Wave 3D programs: each read asks the URL its route serves and each transaction method posts to its route, with the body untouched; and every URL the client
// can ask exists in the API's route sources (a route renamed there fails here).
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createApiClient } from '../src/index.js';

type Call = { url: string; method: string; body: string | null };
function client() {
  const calls: Call[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? init.body : null });
    return new Response(JSON.stringify({ transaction: 'AQID', signers: ['x'], ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof globalThis.fetch;
  return { api: createApiClient({ baseUrl: 'http://api.test', fetch, sleep: async () => {} }), calls };
}
const A = 'F5k8EDDXBF24xgt4Y8MMtwPZFH9TikJvJcNmD1NJQPnZ';
const B = 'DTB3Jtxb6dy7GvocUbypiJb548ZLGRzVdPrNNCWAKEdC';

const READS: [string, (api: ReturnType<typeof client>['api']) => Promise<unknown>, string][] = [
  ['getMandate', (a) => a.getMandate(A), `/v1/mandates/${A}`],
  ['listMandates', (a) => a.listMandates({ owner: A, agent: B, limit: 5 }), `/v1/mandates?owner=${A}&agent=${B}&limit=5`],
  ['getMandateActivity', (a) => a.getMandateActivity(A), `/v1/mandates/${A}/activity`],
  ['ownerMandates', (a) => a.ownerMandates(A), `/v1/owners/${A}/mandates`],
  ['getConviction', (a) => a.getConviction(A), `/v1/owners/${A}/conviction`],
  ['getConvictionLock', (a) => a.getConvictionLock(A), `/v1/conviction/locks/${A}`],
  ['getConvictionMint', (a) => a.getConvictionMint(A), `/v1/conviction/mints/${A}`],
  ['getBasket', (a) => a.getBasket(A), `/v1/baskets/${A}`],
  ['quoteBasket', (a) => a.quoteBasket(A, { shares: '1500000', side: 'mint' }), `/v1/baskets/${A}/quote?shares=1500000&side=mint`],
  ['listBaskets', (a) => a.listBaskets({ creator: A }), `/v1/baskets?creator=${A}`],
  ['listListingVenues', (a) => a.listListingVenues(), '/v1/listing/venues'],
  ['getListingVenue', (a) => a.getListingVenue(A, { lister: B }), `/v1/listing/venues/${A}?lister=${B}`],
  ['getVenueListings', (a) => a.getVenueListings(A), `/v1/listing/venues/${A}/listings`],
  ['getListing', (a) => a.getListing(A), `/v1/listing/listings/${A}`],
  ['getCrossListings', (a) => a.getCrossListings(A), `/v1/crosses/${A}/listings`],
  ['listBounties', (a) => a.listBounties({ sponsor: A }), `/v1/bounties?sponsor=${A}`],
  ['getBounty', (a) => a.getBounty(A), `/v1/bounties/${A}`],
  ['getBountyPayouts', (a) => a.getBountyPayouts(A), `/v1/bounties/${A}/payouts`],
  ['getCrossInvariants', (a) => a.getCrossInvariants(A), `/v1/crosses/${A}/invariants`],
  ['getBacking', (a) => a.getBacking(A), `/v1/assets/${A}/backing`],
  ['listBackingPolicies', (a) => a.listBackingPolicies(), '/v1/backing/policies'],
  ['getGraduation', (a) => a.getGraduation(A), `/v1/crosses/${A}/graduation`],
  ['getGraduationRound', (a) => a.getGraduationRound(A, { voter: B }), `/v1/graduation/rounds/${A}?voter=${B}`],
];

const TX: [string, string][] = [
  ['mandateCreate', 'mandate-create'], ['mandateFund', 'mandate-fund'], ['mandateSetLimits', 'mandate-set-limits'], ['mandateRevoke', 'mandate-revoke'], ['mandateWithdraw', 'mandate-withdraw'],
  ['mandateWithdrawLamports', 'mandate-withdraw-lamports'], ['mandateSweep', 'mandate-sweep'], ['mandatePlaceOrder', 'mandate-place-order'], ['mandateCancelOrder', 'mandate-cancel-order'], ['mandateRevealOrder', 'mandate-reveal-order'],
  ['convictionLock', 'conviction-lock'], ['convictionUnlock', 'conviction-unlock'], ['convictionClaimBadge', 'conviction-claim-badge'], ['convictionCloseLock', 'conviction-close-lock'],
  ['basketCreate', 'basket-create'], ['basketMint', 'basket-mint'], ['basketRedeem', 'basket-redeem'],
  ['listingCreateVenue', 'listing-create-venue'], ['listingOpenBond', 'listing-open-bond'], ['listingDepositBond', 'listing-deposit-bond'], ['listingWithdrawBond', 'listing-withdraw-bond'], ['listingListCross', 'listing-list-cross'],
  ['listingRelease', 'listing-release'], ['listingSlash', 'listing-slash'],
  ['bountyCreate', 'bounty-create'], ['bountyFund', 'bounty-fund'], ['bountyClaimInvariant', 'bounty-claim-invariant'], ['bountyAward', 'bounty-award'], ['bountyWithdraw', 'bounty-withdraw'],
  ['backingInitHaltState', 'backing-init-halt-state'], ['backingCreatePolicy', 'backing-create-policy'], ['backingAttest', 'backing-attest'], ['backingCheck', 'backing-check'],
  ['graduateInitCharter', 'graduate-init-charter'], ['graduateStartRound', 'graduate-start-round'], ['graduateCastVote', 'graduate-cast-vote'], ['graduatePostVolume', 'graduate-post-volume'], ['graduateFinalizeRound', 'graduate-finalize-round'],
  ['graduatePublishOutcome', 'graduate-publish-outcome'], ['graduateWithdrawVote', 'graduate-withdraw-vote'],
  ['openFixedPricePresale', 'open-fixed-price-presale'], ['seedFutarchyDao', 'seed-futarchy-dao'],
];

/** The routes the API registers, from its sources. */
function apiRoutes(): Set<string> {
  const files: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(d, e.name));
      else if (e.name.endsWith('.ts')) files.push(join(d, e.name));
    }
  };
  walk(join(__dirname, '..', '..', '..', 'services', 'api', 'src'));
  const out = new Set<string>();
  for (const f of files) for (const m of readFileSync(f, 'utf8').matchAll(/\.(get|post)(?:<[^>]*>)?\(\s*['"`]([^'"`]+)['"`]/g)) out.add(`${m[1]!.toUpperCase()} ${m[2]}`);
  return out;
}
const served = (routes: Set<string>, method: string, path: string) =>
  [...routes].some((r) => {
    const [m, p] = r.split(' ') as [string, string];
    return m === method && new RegExp(`^${p.replace(/:[A-Za-z]+/g, '[^/]+')}$`).test(path);
  });

describe('Wave 3D reads', () => {
  for (const [name, call, path] of READS) {
    it(`${name} asks ${path.replace(/[1-9A-HJ-NP-Za-km-z]{32,44}/g, ':x')}`, async () => {
      const { api, calls } = client();
      await call(api);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ method: 'GET', url: `http://api.test${path}` });
    });
  }

  it('every URL it can ask is a route the API registers', () => {
    const routes = apiRoutes();
    const missing = READS.filter(([, , path]) => !served(routes, 'GET', path.split('?')[0]!)).map(([n]) => n);
    expect(missing).toEqual([]);
  });
});

describe('Wave 3D transactions', () => {
  it('posts each action to its route with the body untouched and hands back the unsigned transaction', async () => {
    for (const [method, route] of TX) {
      const { api, calls } = client();
      const body = { who: A, amount: '10', nested: { a: [1, 2] } };
      const built = await (api.tx as unknown as Record<string, (b: object) => Promise<{ transactions?: unknown[] }>>)[method]!(body);
      expect(calls[0], method).toMatchObject({ method: 'POST', url: `http://api.test/v1/tx/${route}` });
      expect(JSON.parse(calls[0]!.body!), method).toEqual(body);
      expect(built, method).toBeDefined();
    }
    expect(TX).toHaveLength(42);
  });

  it('every route it posts to is registered by the API', () => {
    const routes = apiRoutes();
    expect(TX.filter(([, route]) => !served(routes, 'POST', `/v1/tx/${route}`)).map(([m]) => m)).toEqual([]);
  });

  it('checks an agent transaction through the guard route', async () => {
    const { api, calls } = client();
    await api.checkAgentTransaction('AQID');
    expect(calls[0]).toMatchObject({ method: 'POST', url: 'http://api.test/v1/mandates/check-transaction', body: JSON.stringify({ transaction: 'AQID' }) });
    expect(served(apiRoutes(), 'POST', '/v1/mandates/check-transaction')).toBe(true);
  });
});
