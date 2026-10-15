// Row Y8: the keeper's scheduler reads the issuer's subscription (ADR-0960). The client is exercised against a real HTTP server; the series duty against the in-memory chain of
// test/helpers/world.ts. The billing service's own answer is produced by its real routes in services/billing/test/entitlements-consumer.test.ts, which this client parses.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { CLEAR_DISCRIMINATOR, CrossState, FINALIZE_DISCRIMINATOR, RELEASE_LOCKED_DISCRIMINATOR, SPAWN_NEXT_DISCRIMINATOR } from '@opening-cross/cross-core-client';
import { type Entitlement, EntitlementError, billingEntitlements, parseEntitlement, runOnce } from '../src/index.js';
import { DAY, NOW, World, key } from './helpers/world.js';

// The shape of the billing route's answer (services/billing/src/routes.ts, `entitlementFor`), as it is on the wire.
const answer = (over: Record<string, unknown> = {}) => ({
  schema: 'opening-cross/entitlement/v1',
  issuer: 'x',
  at: 1_800_000_000,
  entitled: true,
  current: { plan: 'recurring-starter', start: 1_799_999_000, end: 1_802_591_000, paymentAt: 1_799_999_000 },
  crossesIncluded: 4,
  crossesUsed: 1,
  crossesOverIncluded: 0,
  periods: [],
  rejectedPayments: [],
  ...over,
});
const none = () => answer({ entitled: false, current: null, crossesIncluded: 0, crossesUsed: 0 });

let server: Server | null = null;
afterEach(async () => {
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = null;
});

/** A billing service double: `respond` decides the answer per request; `hits` counts requests and records the paths. */
async function billing(respond: (issuer: string, n: number) => { status?: number; body?: unknown; hang?: boolean }) {
  const hits: string[] = [];
  server = createServer((req, res) => {
    hits.push(req.url!);
    const issuer = decodeURIComponent(req.url!.split('/').pop()!);
    const r = respond(issuer, hits.length);
    if (r.hang) return;
    res.writeHead(r.status ?? 200, { 'content-type': 'application/json' }).end(typeof r.body === 'string' ? r.body : JSON.stringify(r.body ?? answer()));
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server!.address() as AddressInfo).port}`, hits };
}

describe('parseEntitlement', () => {
  it('reads an entitled answer: the plan, the end of the period and the crosses used against those included', () => {
    expect(parseEntitlement(answer())).toEqual({ entitled: true, plan: 'recurring-starter', periodEnd: 1_802_591_000, crossesIncluded: 4, crossesUsed: 1 });
  });
  it('reads a refusal', () => {
    expect(parseEntitlement(none())).toEqual({ entitled: false, plan: null, periodEnd: null, crossesIncluded: 0, crossesUsed: 0 });
  });
  it('refuses what does not say plainly whether the issuer is entitled: no schema, no boolean, an entitled answer without its period, uncounted crosses', () => {
    for (const bad of [null, 'yes', {}, answer({ schema: 'other' }), answer({ entitled: 'true' }), answer({ current: null }), answer({ current: { plan: 'p' } }), answer({ crossesUsed: -1 }), answer({ crossesIncluded: 1.5 })]) {
      expect(() => parseEntitlement(bad)).toThrow(EntitlementError);
    }
  });
});

describe('billingEntitlements (over HTTP)', () => {
  it('asks the billing route for the issuer, with no time of its own: the route defaults to now or the latest payment, whichever is later', async () => {
    const b = await billing(() => ({ body: answer() }));
    const e = await billingEntitlements({ baseUrl: b.url + '/' })('IssuerA' as never);
    expect(e.entitled).toBe(true);
    expect(b.hits).toEqual(['/v1/billing/entitlements/IssuerA']);
  });

  it('reuses an entitled answer for a minute and a refusal for ten seconds, so an issuer who has just paid is served at the next pass after that', async () => {
    let paid = false;
    const b = await billing(() => ({ body: paid ? answer() : none() }));
    let t = 1_800_000_000_000;
    const get = billingEntitlements({ baseUrl: b.url, now: () => t });
    expect((await get('I' as never)).entitled).toBe(false);
    paid = true;
    t += 9_000;
    expect((await get('I' as never)).entitled).toBe(false); // still inside the refusal's ten seconds
    expect(b.hits).toHaveLength(1);
    t += 1_001;
    expect((await get('I' as never)).entitled).toBe(true); // asked again, and now paid
    expect(b.hits).toHaveLength(2);
    t += 59_000;
    await get('I' as never);
    expect(b.hits).toHaveLength(2); // an entitled answer stands for a minute
    t += 1_001;
    await get('I' as never);
    expect(b.hits).toHaveLength(3);
  });

  it('keeps one answer per issuer', async () => {
    const b = await billing((issuer) => ({ body: issuer === 'Paid' ? answer() : none() }));
    const get = billingEntitlements({ baseUrl: b.url });
    expect((await get('Paid' as never)).entitled).toBe(true);
    expect((await get('Unpaid' as never)).entitled).toBe(false);
    expect(b.hits).toHaveLength(2);
  });

  it('when billing goes down, an earlier answer stands in: an entitled one only until its period ends, marked stale', async () => {
    let up = true;
    const b = await billing(() => (up ? { body: answer({ current: { plan: 'recurring-starter', start: 1_800_000_000 - 1000, end: 1_800_000_000 + 3_600, paymentAt: 0 } }) } : { status: 503, body: { error: 'down' } }));
    let t = 1_800_000_000_000;
    const get = billingEntitlements({ baseUrl: b.url, now: () => t });
    expect((await get('I' as never)).entitled).toBe(true);
    up = false;
    t += 120_000;
    const during = await get('I' as never);
    expect(during).toMatchObject({ entitled: true, stale: true });
    t += 3_600_000; // the period (one hour) has ended: the earlier yes no longer holds
    const after = await get('I' as never);
    expect(after).toMatchObject({ entitled: false, stale: true, plan: null, periodEnd: null });
  });

  it('a refusal also stands in while billing is down, and an issuer never seen is an error, not a guess', async () => {
    let up = true;
    const b = await billing(() => (up ? { body: none() } : { status: 500, body: 'boom' }));
    let t = 1_800_000_000_000;
    const get = billingEntitlements({ baseUrl: b.url, now: () => t });
    await get('Known' as never);
    up = false;
    t += 60_000;
    expect(await get('Known' as never)).toMatchObject({ entitled: false, stale: true });
    await expect(get('Stranger' as never)).rejects.toThrow(EntitlementError);
    // Past the stale window even the earlier answer is not used.
    t += 25 * 3_600_000;
    await expect(get('Known' as never)).rejects.toThrow(/billing service answered 500/);
  });

  it('is an error when billing is unreachable, answers non-JSON, answers the wrong shape, or does not answer in time', async () => {
    const dead = billingEntitlements({ baseUrl: 'http://127.0.0.1:9', timeoutMs: 500 });
    await expect(dead('I' as never)).rejects.toThrow(/could not be reached/);
    const garbled = await billing(() => ({ body: 'not json' }));
    await expect(billingEntitlements({ baseUrl: garbled.url })('I' as never)).rejects.toThrow(EntitlementError);
    await server!.close();
    const wrong = await billing(() => ({ body: { entitled: true } }));
    await expect(billingEntitlements({ baseUrl: wrong.url })('I' as never)).rejects.toThrow(/did not answer with opening-cross\/entitlement\/v1/);
    await server!.close();
    const slow = await billing(() => ({ hang: true }));
    await expect(billingEntitlements({ baseUrl: slow.url, timeoutMs: 200 })('I' as never)).rejects.toThrow(EntitlementError);
  });
});

// ------------------------------------------------------------------ the scheduler

/** An entitlement source with answers per issuer and a count of questions. */
const source = (by: Record<string, Entitlement | Error>) => {
  const asked: string[] = [];
  const fn = async (issuer: string) => {
    asked.push(issuer);
    const v = by[issuer];
    if (!v) throw new EntitlementError('unknown issuer');
    if (v instanceof Error) throw v;
    return v;
  };
  return { fn: fn as never, asked };
};
const paid: Entitlement = { entitled: true, plan: 'recurring-starter', periodEnd: 2_000_000_000, crossesIncluded: 4, crossesUsed: 0 };
const unpaid: Entitlement = { entitled: false, plan: null, periodEnd: null, crossesIncluded: 0, crossesUsed: 0 };
const spawns = (w: World) => w.sent.filter((ixs) => ixs.some((ix) => ix.data && Array.from(SPAWN_NEXT_DISCRIMINATOR).every((b, i) => ix.data![i] === b)));
const due = (w: World) => w.series({ startTs: NOW - 2n * DAY, intervalSecs: DAY });

describe('the series duty reads entitlements', () => {
  it('spawns for a subscriber and creates the shards', async () => {
    const w = await World.create();
    const series = await due(w);
    const e = source({ [w.payer.address]: paid });
    const r = await runOnce(w.deps({ duties: 'series', entitlement: e.fn }));
    expect(r.failed).toEqual([]);
    expect(r.done.map((d) => d.action.kind)).toEqual(['spawn-next']);
    expect(spawns(w)).toHaveLength(1);
    expect(e.asked).toEqual([w.payer.address]);
    expect(series).toBeTruthy();
  });

  it('does not spawn for an issuer without a paid period: the skip says so, and says anyone else may send spawn_next', async () => {
    const w = await World.create();
    const series = await due(w);
    const r = await runOnce(w.deps({ duties: 'series', entitlement: source({ [w.payer.address]: unpaid }).fn }));
    expect(spawns(w)).toHaveLength(0);
    expect(r.done).toEqual([]);
    expect(r.skipped).toContainEqual({ cross: series, code: 'NOT_ENTITLED', reason: expect.stringMatching(/no paid subscription period.*spawn_next is permissionless/) });
  });

  it('waits, rather than spend rent on a guess, when the subscription cannot be checked', async () => {
    const w = await World.create();
    const series = await due(w);
    const r = await runOnce(w.deps({ duties: 'series', entitlement: source({ [w.payer.address]: new EntitlementError('the billing service answered 503') }).fn }));
    expect(spawns(w)).toHaveLength(0);
    expect(r.failed).toEqual([]);
    expect(r.skipped).toContainEqual({ cross: series, code: 'ENTITLEMENT_UNKNOWN', reason: expect.stringContaining('503') });
  });

  it('spawns on the pass after the issuer pays, with nothing else changed', async () => {
    const w = await World.create();
    await due(w);
    const by: Record<string, Entitlement> = { [w.payer.address]: unpaid };
    const e = source(by);
    await runOnce(w.deps({ duties: 'series', entitlement: e.fn }));
    expect(spawns(w)).toHaveLength(0);
    by[w.payer.address] = paid;
    const r = await runOnce(w.deps({ duties: 'series', entitlement: e.fn }));
    expect(r.done.map((d) => d.action.kind)).toEqual(['spawn-next']);
  });

  it('serves the operator\'s own issuers without asking billing, and every series when no billing is configured', async () => {
    const w = await World.create();
    await due(w);
    const e = source({});
    const exempt = await runOnce(w.deps({ duties: 'series', entitlement: e.fn, entitlementExempt: new Set([w.payer.address]) }));
    expect(exempt.done.map((d) => d.action.kind)).toEqual(['spawn-next']);
    expect(e.asked).toEqual([]);

    const w2 = await World.create();
    await due(w2);
    expect((await runOnce(w2.deps({ duties: 'series' }))).done.map((d) => d.action.kind)).toEqual(['spawn-next']);
  });

  it('asks billing only when a spawn is due: a series that is waiting, paused or finished costs no request', async () => {
    const w = await World.create();
    await w.series({ startTs: NOW + 30n * DAY }); // not within the day before the call
    await w.series({ startTs: NOW - 2n * DAY, active: false });
    const e = source({ [w.payer.address]: paid });
    await runOnce(w.deps({ duties: 'series', entitlement: e.fn }));
    expect(e.asked).toEqual([]);
  });

  it('never conditions a user\'s money on a subscription: clearing, claims, refunds, finalizing and lock releases are done for an unsubscribed issuer', async () => {
    const w = await World.create();
    const live = await w.cross({ state: CrossState.Live }); // past its reveal window: to be cleared
    const noPrint = await w.cross({ state: CrossState.NoPrint });
    const order = await w.order(noPrint, { side: 'buy', price: 100n });
    const cleared = await w.cross({ state: CrossState.Cleared, price: 100n });
    const lockedCross = await w.cross({ state: CrossState.Finalized });
    await w.lockup({ cross: lockedCross, amount: 1_000n, startTs: NOW - 10n * DAY, cliffSecs: 0, vestSecs: 5 * 86_400 });
    const e = source({ [w.payer.address]: unpaid });
    const r = await runOnce(w.deps({ duties: 'all', entitlement: e.fn }));
    expect(r.failed).toEqual([]);
    const kinds = r.done.map((d) => d.action.kind);
    for (const k of ['settle', 'claim', 'finalize', 'release-locked']) expect(kinds).toContain(k);
    const sentDiscs = w.sent.flat().map((ix) => ix.data && Array.from(ix.data.slice(0, 8)).join(','));
    for (const d of [CLEAR_DISCRIMINATOR, FINALIZE_DISCRIMINATOR, RELEASE_LOCKED_DISCRIMINATOR]) expect(sentDiscs).toContain(Array.from(d).join(','));
    expect(w.accounts.has(order)).toBe(false); // the buyer's order was refunded
    expect(getState(w, live)).not.toBe(CrossState.Live);
    expect(getState(w, cleared)).toBe(CrossState.Finalized);
    expect(e.asked).toEqual([]); // none of it consulted billing
  });
});

import { getCrossDecoder } from '@opening-cross/cross-core-client';
const getState = (w: World, c: string) => getCrossDecoder().decode(w.get(c)).state;
void key;
