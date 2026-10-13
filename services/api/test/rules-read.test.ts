// The reads of what the rules extension and cross_settle produce: indexed rows joined with the accounts on chain that are the exact record. PGlite for the index,
// accounts injected in memory for the chain. A cross, wallet or mint that has none of it gets an empty answer with a note, never an error.
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import Fastify from 'fastify';
import { beforeAll, describe, expect, it } from 'vitest';
import { type Address, getAddressDecoder, none, some } from '@solana/kit';
import {
  CROSS_BODY_LEN,
  CROSS_CORE_PROGRAM_ADDRESS,
  CROSS_EXT_LEN,
  CrossKind,
  CrossState,
  Disclosure,
  SupplyMode,
  completeRules,
  getCrossEncoder,
  getCrossExtEncoder,
  getDrawFinishedEventEncoder,
  getHaltStateEncoder,
  getLevelsEncoder,
  getLockupEncoder,
  getPrintFeedEncoder,
  getSeriesEncoder,
  haltStateAddress,
  lockupAddress,
  paddedRules,
  printFeedAddress,
} from '@opening-cross/sdk';
import { CROSS_SETTLE_PROGRAM_ADDRESS, getGreenshoeEncoder } from '@opening-cross/cross-settle-client';
import { type ChainTx, ingestTransaction } from '@opening-cross/indexer';
import { bookAddressOf } from '@opening-cross/verifier';
import { RequestError } from '../src/tx.js';
import { registerRulesRead } from '../src/routes/rules-read.js';

const NOW = 1_800_000_000;
const addr = (n: number) => getAddressDecoder().decode(new Uint8Array(32).fill(n)) as Address;
const [CROSS, CREATOR, BASE, QUOTE, ALICE, BOB, SERIES, HALTER, PLAIN, GS, LIMIT, POOL] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((n) => addr(n + 60));
const ZERO = '11111111111111111111111111111111' as Address;
type Account = { data: Uint8Array; owner: Address };

describe('rules and settlement reads', () => {
  const accounts = new Map<string, Account>();
  let pg: PGlite;
  let app: ReturnType<typeof Fastify>;
  const q = async (text: string, params: unknown[] = []) => (await pg.query(text, params as never[])).rows as Record<string, unknown>[];
  const get = async (url: string) => {
    const r = await app.inject({ method: 'GET', url });
    return { status: r.statusCode, body: JSON.parse(r.body) };
  };
  const wrap = (): never =>
    ({
      query: async (text: string, params?: unknown[]) => {
        const r = await pg.query(text, params as never[]);
        return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length };
      },
      connect: async () => ({ query: async (text: string, params?: unknown[]) => { const r = await pg.query(text, params as never[]); return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length }; }, release() {} }),
    }) as never;

  const crossAccount = (extra: { ending?: { endingSecs: number; buckets: number; randomEnd: boolean }; endBucket?: number; epoch?: number } = {}, id = 1n) => {
    const body = getCrossEncoder().encode({
      creator: CREATOR, crossId: id, kind: CrossKind.Launch, supplyMode: SupplyMode.Mint, disclosure: Disclosure.Open, state: CrossState.Cleared, baseMint: BASE, quoteMint: QUOTE, baseTokenProgram: ZERO, quoteTokenProgram: ZERO,
      baseDecimals: 6, quoteDecimals: 6, proceedsTo: CREATOR, minPrice: 1n, tick: 1n, ticks: 2, priceScale: 1n, openTs: 1_000n, closeTs: 2_000n, revealEndTs: 2_100n, referencePrice: none(), minMatched: 0n, maxImbalanceBps: none(),
      protocolFeeBps: 0, integratorFeeBps: 0, integrator: CREATOR, feeRecipient: CREATOR, gateMint: none(), shards: 2, maxOrders: 8, dustBond: 0n, ordersTotal: 3, ordersOpen: 0, mergedMask: 3,
      clearing: some({ price: 1n, matched: 1n, demand: 1n, supply: 1n, rationed: 0, marginalQuantity: 0n, marginalRemaining: 0n, marginalOrders: 0 }), noPrintReason: none(), buyerPaid: 0n, baseBought: 0n, baseSold: 0n, sellerPaid: 0n, feesAccrued: 0n,
      oracle: none(), calendar: none(), settler: none(), settleDeadlineTs: 0n, baseBound: true, bump: 1, quoteVaultBump: 1, baseVaultBump: 1, bookBump: 1,
    } as never);
    const data = new Uint8Array(CROSS_BODY_LEN + (extra.ending ? CROSS_EXT_LEN : 0));
    data.set(body);
    if (extra.ending) {
      const r = completeRules({ ending: { ...extra.ending, cancelCutoffSecs: 10 } });
      data.set(
        getCrossExtEncoder().encode({
          version: 1, rulesSet: true, createdSlot: 1n, flags: 0, guards: { ...r.guards, haltSource: null }, ending: r.ending,
          draw: { epoch: extra.epoch ?? 0, pendingSlot: 0n, pendingPurpose: 0, seed: new Uint8Array(32), seedEpoch: 0, seedReady: false, endBucket: extra.endBucket ?? 255, extPending: false, extensionUsed: false, auxMerged: extra.ending ? 7n : 0n },
          identity: r.identity, alloc: { ...r.alloc, priorityGate: null }, neutrality: { insiders: Array.from({ length: 8 }, () => ZERO), insiderCount: 0, insiderCliffSecs: 0, insiderVestSecs: 0, bondQuote: 0n, challengeSecs: 0 },
          neutralState: { bondHeld: 0n, slashed: 0n, openChallenges: 0, challenges: 0 }, clearing: { classQty: [0n, 0n, 0n], tickets: 0, rho: 0, clearedTs: 0n, insiderUb: 0n }, referral: r.referral,
          oracleSet: { extraFeeds: [new Uint8Array(32), new Uint8Array(32)] as never, extraCount: 0, quorum: 0, maxSpreadBps: 0, offHoursWidenBps: 0 },
        } as never),
        CROSS_BODY_LEN,
      );
    }
    return data;
  };

  beforeAll(async () => {
    pg = new PGlite();
    const dir = fileURLToPath(new URL('../../indexer/migrations/', import.meta.url));
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.sql')).sort()) await pg.exec(readFileSync(`${dir}${f}`, 'utf8'));
    accounts.set(CROSS, { owner: CROSS_CORE_PROGRAM_ADDRESS, data: crossAccount({ ending: { endingSecs: 400, buckets: 4, randomEnd: true }, endBucket: 2 }) });
    accounts.set(PLAIN, { owner: CROSS_CORE_PROGRAM_ADDRESS, data: crossAccount({}, 2n) });
    await q("INSERT INTO crosses (address, creator, kind, supply_mode, disclosure, base_mint, quote_mint, open_ts, close_ts, reveal_end_ts, protocol_fee_bps, integrator_fee_bps, state, created_slot, updated_slot) VALUES ($1,$2,0,1,1,$3,$4,1000,2000,2100,0,0,'Cleared',1,1)", [CROSS, CREATOR, BASE, QUOTE]);
    for (const [i, bucket] of [255, 0, 0, 1, 2, 3].entries()) await q("INSERT INTO order_placements (order_address, cross_address, epoch, bucket, class, flags, lock_cliff, lock_vest, placed_ts, ticket, slot) VALUES ($1,$2,0,$3,0,0,0,0,1900,0,1)", [addr(100 + i), CROSS, bucket]);
    await q("INSERT INTO cross_challenges (cross_address, id, challenger, subject, evidence, status, filed_slot) VALUES ($1,0,$2,$3,'aa','Open',5), ($1,1,$2,$4,'bb','Upheld',6)", [CROSS, BOB, ALICE, HALTER]);
    app = Fastify({ logger: false });
    app.setErrorHandler((err, _req, reply) => {
      if (err instanceof RequestError) return reply.code(err.status).type('application/json').send(JSON.stringify({ error: err.message, ...err.detail }, (_k, x) => (typeof x === 'bigint' ? x.toString() : x)));
      return reply.code(500).send({ error: String(err) });
    });
    registerRulesRead(app, { db: wrap(), account: async (a) => accounts.get(a) ?? null, clock: () => NOW });
  }, 60_000);

  it('challenges: the rows of a cross, and an empty list for a cross with none', async () => {
    const r = await get(`/v1/crosses/${CROSS}/challenges`);
    expect(r.body.challenges.map((c: { id: number; status: string }) => [c.id, c.status])).toEqual([[0, 'Open'], [1, 'Upheld']]);
    expect(r.body.open).toBe(1);
    expect((await get(`/v1/crosses/${PLAIN}/challenges`)).body).toMatchObject({ challenges: [], open: 0 });
    expect((await get('/v1/crosses/not-an-address/challenges')).status).toBe(400);
  });

  it('ending: buckets with the orders that fell in them, the drawn last bucket; null for a cross without an ending', async () => {
    const r = await get(`/v1/crosses/${CROSS}/ending`);
    expect(r.status).toBe(200);
    expect(r.body.ending).toMatchObject({ startsAt: '1600', endsAt: '2000', cancelCutoffSecs: 10, randomEnd: true, before: 1, drawn: true, lastCountedBucket: 2 });
    expect(r.body.ending.buckets).toEqual([{ bucket: 0, orders: 2 }, { bucket: 1, orders: 1 }, { bucket: 2, orders: 1 }, { bucket: 3, orders: 1 }]);
    expect((await get(`/v1/crosses/${PLAIN}/ending`)).body).toMatchObject({ ending: null });
    expect((await get(`/v1/crosses/${addr(99)}/ending`)).status).toBe(404);
  });

  it('lockups: the schedule from the index, what is released and what can be released now from the lockup account', async () => {
    await q("INSERT INTO cross_locks (cross_address, owner, order_address, nonce, amount, start_ts, cliff_secs, vest_secs, released, created_slot, signature, seq) VALUES ($1,$2,$3,7,1000,$4,100,1000,0,9,'s1',0), ($1,$2,$5,8,500,$4,0,0,0,10,'s2',0)", [CROSS, ALICE, addr(101), NOW - 600, addr(102)]);
    // lock 7 is half vested at NOW - 600 + 100 + 500 = NOW, of which 200 were released; lock 8's account is gone (released in full)
    accounts.set(await lockupAddress(CROSS, ALICE, 7n), { owner: CROSS_CORE_PROGRAM_ADDRESS, data: new Uint8Array(getLockupEncoder().encode({ cross: CROSS, owner: ALICE, nonce: 7n, amount: 1000n, released: 200n, startTs: BigInt(NOW - 600), cliffSecs: 100, vestSecs: 1000, bump: 255 })) });
    const r = await get(`/v1/owners/${ALICE}/lockups`);
    const [l8, l7] = r.body.lockups;
    expect(l7).toMatchObject({ nonce: '7', state: 'locked', released: '200', releasable: '300', amount: '1000' });
    expect(l8).toMatchObject({ nonce: '8', state: 'closed', releasable: '0', released: '500' });
    expect((await get(`/v1/owners/${BOB}/lockups`)).body.lockups).toEqual([]);
    expect((await get(`/v1/owners/${ALICE}/lockups?cross=${PLAIN}`)).body.lockups).toEqual([]);
  });

  it('halts: nothing for a mint without a halt state; the chain state and the index for one with it', async () => {
    expect((await get(`/v1/halts/${BASE}`)).body.halt).toBeNull();
    const halt = await haltStateAddress(BASE);
    accounts.set(halt, { owner: CROSS_CORE_PROGRAM_ADDRESS, data: new Uint8Array(getHaltStateEncoder().encode({ baseMint: BASE, authority: HALTER, venueSigner: some(ALICE), halted: true, reason: 2, corporateAction: false, sinceTs: 1_799_999_000n, sinceSlot: 5n, issuerUnpaused: false, breaker: none(), lastResumeCross: none(), lastResumePrice: 0n, lastResumeTs: 0n, bump: 255 } as never)) });
    await q('INSERT INTO halt_states (base_mint, halted, reason, changed_slot, changes) VALUES ($1,true,2,5,3)', [BASE]);
    const r = await get(`/v1/halts/${BASE}`);
    expect(r.body.state).toMatchObject({ halted: true, reason: 'venue-halt', authority: HALTER, venueSigner: ALICE, breaker: null });
    expect(r.body.indexed).toMatchObject({ halted: true, changes: 3 });
  });

  it('feeds: the publishers and the latest print from the chain, the prints from the index', async () => {
    expect((await get(`/v1/feeds/${BASE}`)).body.feed).toBeNull();
    const feed = await printFeedAddress(BASE);
    accounts.set(feed, { owner: CROSS_CORE_PROGRAM_ADDRESS, data: new Uint8Array(getPrintFeedEncoder().encode({ baseMint: BASE, quoteMint: QUOTE, authority: HALTER, publishers: [ALICE, BOB, ZERO, ZERO], publisherCount: 2, minMatched: 5n, price: 1_300_000n, priceScale: 1_000_000n, matched: 50n, cross: CROSS, ts: 1_799_000_000n, slot: 9n, prints: 4n, bump: 255 } as never)) });
    await q('INSERT INTO print_feed_prints (base_mint, cross_address, price, matched, slot) VALUES ($1,$2,1300000,50,9)', [BASE, CROSS]);
    const r = await get(`/v1/feeds/${BASE}`);
    expect(r.body).toMatchObject({ publishers: [ALICE, BOB], minMatched: '5', latest: { price: '1300000', matched: '50' }, printCount: '4' });
    expect(r.body.prints).toHaveLength(1);
  });

  it('series: the chain account with the crosses the index saw it spawn, and a list by authority', async () => {
    expect((await get(`/v1/series/${SERIES}`)).status).toBe(404);
    const r0 = completeRules({});
    accounts.set(SERIES, {
      owner: CROSS_CORE_PROGRAM_ADDRESS,
      data: new Uint8Array(getSeriesEncoder().encode({
        authority: CREATOR, seriesId: 1n, baseMint: BASE, quoteMint: QUOTE, baseTokenProgram: ZERO, quoteTokenProgram: ZERO,
        config: { kind: CrossKind.Reopen, disclosure: Disclosure.Open, priceScale: 1_000_000n, grid: { relative: true, minPrice: 0n, tick: 0n, ticks: 20, tickBps: 50, center: 0n }, startTs: 1_800_000_000n, intervalSecs: 604_800n, calendar: none(), callSecs: 600n, revealSecs: 60n, minMatched: 0n, maxImbalanceBps: none(), integratorFeeBps: 0, integrator: CREATOR, gateMint: none(), shards: 2, maxOrders: 64, proceedsTo: CREATOR, oracle: none(), maxCrosses: 10n, rules: paddedRules({}) },
        nextIndex: 2n, lastCross: some(CROSS), lastCloseTs: 1_800_000_600n, lastPrice: 1_300_000n, active: true, bump: 255,
      } as never)),
    });
    void r0;
    await q("INSERT INTO series (address, authority, created_slot) VALUES ($1,$2,3)", [SERIES, CREATOR]);
    await q("INSERT INTO series_crosses (series, idx, cross_address, close_ts, slot) VALUES ($1,0,$2,1800000600,4), ($1,1,$3,1801000600,5)", [SERIES, CROSS, PLAIN]);
    const r = await get(`/v1/series/${SERIES}`);
    expect(r.body).toMatchObject({ authority: CREATOR, active: true, next: '2', maxCrosses: '10', lastPrice: '1300000', lastCross: CROSS, schedule: { intervalSecs: '604800' } });
    expect(r.body.crosses.map((c: { idx: string }) => c.idx)).toEqual(['1', '0']);
    expect((await get(`/v1/series?authority=${CREATOR}`)).body.series).toEqual([{ address: SERIES, authority: CREATOR, created_slot: '3', crosses: 2 }]);
    expect((await get(`/v1/series?authority=${ALICE}`)).body.series).toEqual([]);
  });

  it('settlement: nothing for a cross no adapter has settled; the venue, the partner payouts and the greenshoe (index and chain) for one that has', async () => {
    expect((await get(`/v1/crosses/${PLAIN}/settlement`)).body).toMatchObject({ venue: null, partner: null, greenshoe: null });
    await q("INSERT INTO settle_venues (cross_address, venue, pool, clearing_price, detail, slot) VALUES ($1,'dlmm',$2,1300000,'{\"binStep\":10}',6)", [CROSS, POOL]);
    await q("INSERT INTO settle_partner (cross_address, fee_base, fee_quote, fee_claims, updated_slot) VALUES ($1,6,9,2,7)", [CROSS]);
    await q("INSERT INTO settle_greenshoes (greenshoe, cross_address, budget, start_ts, expires_ts, bids, created_slot) VALUES ($1,$2,3000,10,$3,'[]',8)", [GS, CROSS, NOW + 86_400]);
    const gsAddress = (await import('@solana/kit')).getProgramDerivedAddress({ programAddress: CROSS_SETTLE_PROGRAM_ADDRESS, seeds: [new TextEncoder().encode('greenshoe'), (await import('@solana/kit')).getAddressEncoder().encode(CROSS)] });
    accounts.set((await gsAddress)[0], {
      owner: CROSS_SETTLE_PROGRAM_ADDRESS,
      data: new Uint8Array(getGreenshoeEncoder().encode({ cross: CROSS, creator: CREATOR, lbPair: POOL, baseMint: BASE, quoteMint: QUOTE, referencePrice: 1n, priceScale: 1n, startTs: 10n, expiresTs: BigInt(NOW + 86_400), budget: 3_000n, deployed: 1_000n, periodSecs: 3_600n, periodCap: 3_000n, periodStart: 0n, periodDeployed: 0n, orders: [LIMIT, ZERO, ZERO], bins: [90, 0, 0], amounts: [1_000n, 0n, 0n], levelSettled: [false, false, false], finished: false, bump: 1, vaultBump: 1, baseBump: 1 } as never)),
    });
    const r = await get(`/v1/crosses/${CROSS}/settlement`);
    expect(r.body.venue).toMatchObject({ venue: 'dlmm', pool: POOL, clearing_price: '1300000' });
    expect(r.body.partner).toMatchObject({ fee_base: '6', fee_quote: '9', fee_claims: 2 });
    expect(r.body.greenshoe).toMatchObject({ budget: '3000', finished: false, expired: false, onChain: { deployed: '1000', finished: false } });
  });

  it('the proof with the draws: an ending drawn before a later draw replaced the stored seed is checked from the event', async () => {
    const seed = new Uint8Array(32);
    seed[0] = 2; // the first word is 2: of 4 buckets, bucket 2
    const tx: ChainTx = { signature: 'drawsig', slot: 50n, blockTime: 1_800_000_000n, err: null, logs: [`Program ${CROSS_CORE_PROGRAM_ADDRESS} invoke [1]`, `Program data: ${Buffer.from(getDrawFinishedEventEncoder().encode({ cross: CROSS, purpose: 1, epoch: 0, begunSlot: 10n, sampledSlots: [14n, 18n, 22n, 26n], seed, endBucket: 2, closeTs: 2_000n })).toString('base64')}`, `Program ${CROSS_CORE_PROGRAM_ADDRESS} success`] };
    expect(await ingestTransaction(wrap(), tx)).toBe(1);
    // a one-tick book that clears at 1 for 1, as the cross account says it did
    const zeros = new Array<bigint>(256).fill(0n);
    const counts = new Array<number>(256).fill(0);
    const [buy, sell, bo, so] = [zeros.slice(), zeros.slice(), counts.slice(), counts.slice()];
    buy[0] = 1n;
    sell[0] = 1n;
    bo[0] = 1;
    so[0] = 1;
    accounts.set(await bookAddressOf(CROSS), { owner: CROSS_CORE_PROGRAM_ADDRESS, data: new Uint8Array(getLevelsEncoder().encode({ cross: CROSS, buy, sell, buyOrders: bo, sellOrders: so, index: 0, pad: new Uint8Array(7) })) });
    const r = await get(`/v1/crosses/${CROSS}/proof/draws`);
    expect(r.status).toBe(200);
    expect(r.body.draws).toEqual([{ purpose: 1, epoch: 0, endBucket: 2, closeTs: '2000', seed: Buffer.from(seed).toString('hex') }]);
    // the account holds no seed (never marked ready), so the only way to check the ending is the event: and it holds
    expect(r.body.proof.rules.checks).toEqual([
      { name: 'main-shards-merged', ok: true, detail: expect.any(String) },
      { name: 'aux-shards-merged', ok: true, detail: expect.stringContaining('required by the draw') },
      { name: 'ending-drawn', ok: true, detail: expect.stringContaining('gives bucket 2 of 4') },
    ]);
    expect(r.body.proof.verified).toBe(true);
    expect(r.body.proof.rules.ending).toMatchObject({ lastCountedBucket: 2, randomEnd: true });
  });
});
