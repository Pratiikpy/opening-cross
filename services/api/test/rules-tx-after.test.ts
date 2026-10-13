// The instructions after the clear and the issuer's other rules instructions over HTTP, with accounts injected in memory: locks, pushed refunds, challenges, halt states,
// the lender feed and series. The refusals come before a transaction exists; the transactions are decoded back to instructions. The program is not run.
import Fastify from 'fastify';
import { beforeAll, describe, expect, it } from 'vitest';
import { type Address, type Instruction, decompileTransactionMessage, generateKeyPairSigner, getCompiledTransactionMessageDecoder, getTransactionDecoder, none } from '@solana/kit';
import { TOKEN_2022_PROGRAM_ADDRESS, getMintEncoder } from '@solana-program/token-2022';
import {
  CHALLENGE_DEPOSIT_LAMPORTS,
  CROSS_BODY_LEN,
  CROSS_CORE_PROGRAM_ADDRESS,
  CROSS_EXT_LEN,
  CrossKind,
  CrossState,
  Disclosure,
  SupplyMode,
  challengeAddress,
  completeRules,
  crossAddress,
  getChallengeEncoder,
  getCrossEncoder,
  getCrossExtEncoder,
  getHaltStateEncoder,
  getLockupEncoder,
  getOrderEncoder,
  getSeriesEncoder,
  haltStateAddress,
  lockupAddress,
  orderAddress,
  paddedRules,
  seriesAddress,
} from '@opening-cross/sdk';
import { RequestError } from '../src/tx.js';
import { registerRulesTx } from '../src/routes/rules-tx.js';

const NOW = 1_800_000_000;
const BLOCKHASH = '4NCYB3kRT8sCNodPNuCZo8VkwveZSHhg7R7mrRBFM1Uy' as never;
const ZERO = '11111111111111111111111111111111' as Address;
const key = async () => (await generateKeyPairSigner()).address;
type Account = { data: Uint8Array; owner: Address };

describe('rules instructions after the clear', () => {
  const accounts = new Map<string, Account>();
  let app: ReturnType<typeof Fastify>;
  let creator: Address, base: Address, quote: Address, alice: Address, bob: Address, arbiter: Address, outsider: Address;
  let cleared: Address, live: Address, bonded: Address;

  const post = async (url: string, payload: unknown) => {
    const r = await app.inject({ method: 'POST', url, payload: payload as never });
    return { status: r.statusCode, body: JSON.parse(r.body) };
  };
  const instructionsOf = (tx: string): Instruction[] => {
    const decoded = getTransactionDecoder().decode(Uint8Array.from(Buffer.from(tx, 'base64')));
    return decompileTransactionMessage(getCompiledTransactionMessageDecoder().decode(decoded.messageBytes)).instructions as Instruction[];
  };

  async function putCross(id: bigint, o: { state: CrossState; ext?: Parameters<typeof getCrossExtEncoder>[0] | null }): Promise<Address> {
    const address = await crossAddress(creator, id);
    const body = getCrossEncoder().encode({
      creator, crossId: id, kind: CrossKind.Launch, supplyMode: SupplyMode.Mint, disclosure: Disclosure.Open, state: o.state, baseMint: base, quoteMint: quote, baseTokenProgram: TOKEN_2022_PROGRAM_ADDRESS, quoteTokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
      baseDecimals: 6, quoteDecimals: 6, proceedsTo: creator, minPrice: 1_000_000n, tick: 100_000n, ticks: 20, priceScale: 1_000_000n, openTs: 1n, closeTs: 2n, revealEndTs: 3n, referencePrice: none(), minMatched: 0n, maxImbalanceBps: none(),
      protocolFeeBps: 30, integratorFeeBps: 20, integrator: creator, feeRecipient: arbiter, gateMint: none(), shards: 2, maxOrders: 64, dustBond: 0n, ordersTotal: 0, ordersOpen: 0, mergedMask: 3, clearing: none(), noPrintReason: none(),
      buyerPaid: 0n, baseBought: 0n, baseSold: 0n, sellerPaid: 0n, feesAccrued: 0n, oracle: none(), calendar: none(), settler: none(), settleDeadlineTs: 0n, baseBound: true, bump: 1, quoteVaultBump: 1, baseVaultBump: 1, bookBump: 1,
    } as never);
    const data = new Uint8Array(CROSS_BODY_LEN + (o.ext ? CROSS_EXT_LEN : 0));
    data.set(body);
    if (o.ext) data.set(getCrossExtEncoder().encode(o.ext), CROSS_BODY_LEN);
    accounts.set(address, { owner: CROSS_CORE_PROGRAM_ADDRESS, data });
    return address;
  }
  const ext = (over: { insiders?: Address[]; bond?: bigint; challenges?: number } = {}) => {
    const r = completeRules({});
    return {
      version: 1, rulesSet: true, createdSlot: 1n, flags: 0, guards: { ...r.guards, haltSource: null }, ending: r.ending,
      draw: { epoch: 0, pendingSlot: 0n, pendingPurpose: 0, seed: new Uint8Array(32), seedEpoch: 0, seedReady: true, endBucket: 255, extPending: false, extensionUsed: false, auxMerged: 0n }, identity: r.identity, alloc: { ...r.alloc, priorityGate: null },
      neutrality: { insiders: [...(over.insiders ?? []), ...Array.from({ length: 8 - (over.insiders?.length ?? 0) }, () => ZERO)], insiderCount: over.insiders?.length ?? 0, insiderCliffSecs: 0, insiderVestSecs: 0, bondQuote: over.bond ?? 0n, challengeSecs: over.bond ? 3_600 : 0 },
      neutralState: { bondHeld: over.bond ?? 0n, slashed: 0n, openChallenges: 0, challenges: over.challenges ?? 0 }, clearing: { classQty: [0n, 0n, 0n], tickets: 0, rho: 0, clearedTs: 0n, insiderUb: 0n }, referral: r.referral,
      oracleSet: { extraFeeds: [new Uint8Array(32), new Uint8Array(32)] as never, extraCount: 0, quorum: 0, maxSpreadBps: 0, offHoursWidenBps: 0 },
    } as never;
  };

  beforeAll(async () => {
    [creator, base, quote, alice, bob, arbiter, outsider] = await Promise.all(Array.from({ length: 7 }, key));
    const mint = new Uint8Array(getMintEncoder().encode({ mintAuthority: none(), supply: 0n, decimals: 6, isInitialized: true, freezeAuthority: none(), extensions: none() } as never).slice(0, 82));
    accounts.set(base, { owner: TOKEN_2022_PROGRAM_ADDRESS, data: mint });
    accounts.set(quote, { owner: TOKEN_2022_PROGRAM_ADDRESS, data: mint });
    cleared = await putCross(1n, { state: CrossState.Cleared, ext: ext() });
    live = await putCross(2n, { state: CrossState.Live, ext: ext() });
    bonded = await putCross(3n, { state: CrossState.Cleared, ext: ext({ insiders: [outsider], bond: 1_000_000n, challenges: 2 }) });
    app = Fastify({ logger: false });
    app.setErrorHandler((err, _req, reply) => {
      if (err instanceof RequestError) return reply.code(err.status).type('application/json').send(JSON.stringify({ error: err.message, ...err.detail }, (_k, x) => (typeof x === 'bigint' ? x.toString() : x)));
      return reply.code(500).send({ error: String(err) });
    });
    registerRulesTx(app, { account: async (a) => accounts.get(a) ?? null, lifetime: async () => ({ blockhash: BLOCKHASH, lastValidBlockHeight: 100n }), clock: () => NOW });
  }, 60_000);

  it('release-locked: nothing before the cliff, the vested part after, and no lockup at all', async () => {
    expect((await post('/v1/tx/release-locked', { cross: cleared, owner: alice, nonce: '1' })).body.reason).toBe('NO_LOCKUP');
    const put = async (nonce: bigint, startTs: number) =>
      accounts.set(await lockupAddress(cleared, alice, nonce), { owner: CROSS_CORE_PROGRAM_ADDRESS, data: new Uint8Array(getLockupEncoder().encode({ cross: cleared, owner: alice, nonce, amount: 1_000n, released: 0n, startTs: BigInt(startTs), cliffSecs: 100, vestSecs: 1_000, bump: 255 })) });
    await put(1n, NOW - 50);
    const early = await post('/v1/tx/release-locked', { cross: cleared, owner: alice, nonce: '1' });
    expect(early.status).toBe(409);
    expect(early.body).toMatchObject({ reason: 'NOTHING_VESTED', unlocksAt: String(NOW + 50) });
    await put(2n, NOW - 600);
    const half = await post('/v1/tx/release-locked', { cross: cleared, owner: alice, nonce: '2', payer: bob });
    expect(half.status).toBe(200);
    expect(half.body.releasable).toBe('500');
    expect(half.body.signers).toEqual([bob]);
    const [create, release] = instructionsOf(half.body.transaction);
    expect(create!.programAddress).toBe('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
    expect(release!.programAddress).toBe(CROSS_CORE_PROGRAM_ADDRESS);
  });

  it('push-refunds: up to twelve refund-only orders of a settled cross, three accounts each', async () => {
    const put = async (owner: Address, nonce: bigint, side: 0 | 1) =>
      accounts.set(await orderAddress(cleared, owner, nonce), { owner: CROSS_CORE_PROGRAM_ADDRESS, data: new Uint8Array(getOrderEncoder().encode({ cross: cleared, owner, nonce, index: Number(nonce), side, state: 1, commitment: new Uint8Array(32), price: 1n, quantity: 1n, escrow: 1n, bump: 255 } as never)) });
    await put(alice, 1n, 0);
    await put(bob, 2n, 1);
    const r = await post('/v1/tx/push-refunds', { cross: cleared, payer: outsider, orders: [{ owner: alice, nonce: '1' }, { owner: bob, nonce: '2' }] });
    expect(r.status).toBe(200);
    const [ix] = instructionsOf(r.body.transaction);
    // quote mint, quote vault, base mint, base vault, two programs, then three accounts per order
    expect(ix!.accounts).toHaveLength(13);
    expect(r.body.orders).toBe(2);
    expect((await post('/v1/tx/push-refunds', { cross: cleared, payer: outsider, orders: [{ owner: alice, nonce: '9' }] })).body.reason).toBe('NO_ORDER');
    expect((await post('/v1/tx/push-refunds', { cross: live, payer: outsider, orders: [{ owner: alice, nonce: '1' }] })).body.reason).toBe('LIVE');
    expect((await post('/v1/tx/push-refunds', { cross: cleared, payer: outsider, orders: [] })).status).toBe(400);
    expect((await post('/v1/tx/push-refunds', { cross: cleared, payer: outsider, orders: Array.from({ length: 13 }, () => ({ owner: alice, nonce: '1' })) })).status).toBe(400);
  });

  it('challenge-insider, resolve-challenge, expire-challenge', async () => {
    const evidence = 'ab'.repeat(32);
    expect((await post('/v1/tx/challenge-insider', { cross: cleared, challenger: bob, subject: outsider, evidence })).body.reason).toBe('NO_BOND');
    const filed = await post('/v1/tx/challenge-insider', { cross: bonded, challenger: bob, subject: alice, evidence });
    expect(filed.status).toBe(200);
    expect(filed.body).toMatchObject({ id: 2, challenge: await challengeAddress(bonded, 2), depositLamports: String(CHALLENGE_DEPOSIT_LAMPORTS) });
    expect((await post('/v1/tx/challenge-insider', { cross: bonded, challenger: bob, subject: alice, evidence: 'zz' })).status).toBe(400);
    const open = await challengeAddress(bonded, 1);
    const put = (addr: Address, id: number, status: 0 | 1) => accounts.set(addr, { owner: CROSS_CORE_PROGRAM_ADDRESS, data: new Uint8Array(getChallengeEncoder().encode({ cross: bonded, id, challenger: bob, subject: alice, evidence: new Uint8Array(32), deposit: 10_000_000n, filedTs: 1n, status, slashed: 0n, bump: 255 } as never)) });
    put(open, 1, 0);
    expect((await post('/v1/tx/resolve-challenge', { cross: bonded, arbiter, id: 1, upheld: true, slash: '2000000' })).body.reason).toBe('SLASH_OVER_BOND');
    expect((await post('/v1/tx/resolve-challenge', { cross: bonded, arbiter, id: 1, upheld: false, slash: '5' })).body.reason).toBe('SLASH_ON_REJECT');
    const ruled = await post('/v1/tx/resolve-challenge', { cross: bonded, arbiter, id: 1, upheld: true, slash: '400000' });
    expect(ruled.status).toBe(200);
    expect(ruled.body.signers).toEqual([arbiter]);
    expect((await post('/v1/tx/expire-challenge', { cross: bonded, id: 1, payer: outsider })).status).toBe(200);
    expect((await post('/v1/tx/resolve-challenge', { cross: bonded, arbiter, id: 7, upheld: true })).body.reason).toBe('NO_CHALLENGE');
    put(open, 1, 1);
    expect((await post('/v1/tx/expire-challenge', { cross: bonded, id: 1, payer: outsider })).body.reason).toBe('ALREADY_RESOLVED');
    expect((await post('/v1/tx/set-arbiter', { admin: creator, arbiter })).status).toBe(200);
  });

  it('halt states and the lender feed', async () => {
    const feedId = 'cd'.repeat(32);
    const made = await post('/v1/tx/init-halt-state', { authority: creator, baseMint: base, venueSigner: alice, breaker: { feedId, windowSlots: 10, moveBps: 500 } });
    expect(made.status).toBe(200);
    expect(made.body.halt).toBe(await haltStateAddress(base));
    expect((await post('/v1/tx/init-halt-state', { authority: creator, baseMint: await key() })).body.reason).toBe('MINT_NOT_FOUND');
    expect((await post('/v1/tx/init-halt-state', { authority: creator, baseMint: base, breaker: { feedId, windowSlots: 0, moveBps: 5 } })).status).toBe(400);
    accounts.set(await haltStateAddress(base), { owner: CROSS_CORE_PROGRAM_ADDRESS, data: new Uint8Array(getHaltStateEncoder().encode({ baseMint: base, authority: creator, venueSigner: none(), halted: false, reason: 0, corporateAction: false, sinceTs: 0n, sinceSlot: 0n, issuerUnpaused: false, breaker: none(), lastResumeCross: none(), lastResumePrice: 0n, lastResumeTs: 0n, bump: 255 } as never)) });
    expect((await post('/v1/tx/init-halt-state', { authority: creator, baseMint: base })).body.reason).toBe('HALT_EXISTS');
    for (const [path, body] of [
      ['set-halt', { signer: creator, baseMint: base }],
      ['set-corporate-action', { signer: creator, baseMint: base, flag: true }],
      ['sync-pause', { payer: creator, baseMint: base }],
      ['observe-price', { payer: creator, baseMint: base, priceUpdate: alice }],
    ] as const) expect((await post(`/v1/tx/${path}`, body)).status, path).toBe(200);
    expect((await post('/v1/tx/set-corporate-action', { signer: creator, baseMint: base, flag: 'yes' })).status).toBe(400);
    const feed = await post('/v1/tx/init-print-feed', { authority: creator, baseMint: base, quoteMint: quote, publishers: [alice, bob], minMatched: '5' });
    expect(feed.status).toBe(200);
    expect((await post('/v1/tx/init-print-feed', { authority: creator, baseMint: base, quoteMint: quote, publishers: [], minMatched: '5' })).status).toBe(400);
    expect((await post('/v1/tx/init-print-feed', { authority: creator, baseMint: base, quoteMint: quote, publishers: [alice, alice], minMatched: '5' })).status).toBe(400);
    expect((await post('/v1/tx/set-feed-publishers', { authority: creator, baseMint: base, publishers: [alice], minMatched: '0' })).status).toBe(200);
  });

  it('series: create, spawn, pause, withdraw', async () => {
    const config = { kind: 'reopen', disclosure: 'open', priceScale: '1000000', grid: { relative: true, ticks: 20, tickBps: 50 }, startTs: String(NOW + 60), intervalSecs: 604_800, callSecs: 600, revealSecs: 60, integrator: creator, shards: 2, maxOrders: 64, proceedsTo: creator, maxCrosses: '2' };
    const made = await post('/v1/tx/create-series', { authority: creator, seriesId: '5', baseMint: base, quoteMint: quote, baseTokenProgram: TOKEN_2022_PROGRAM_ADDRESS, quoteTokenProgram: TOKEN_2022_PROGRAM_ADDRESS, config });
    expect(made.status).toBe(200);
    expect(made.body.series).toBe(await seriesAddress(creator, 5n));
    expect(instructionsOf(made.body.transaction)).toHaveLength(3);
    expect((await post('/v1/tx/create-series', { authority: creator, seriesId: '5', baseMint: base, quoteMint: quote, baseTokenProgram: TOKEN_2022_PROGRAM_ADDRESS, quoteTokenProgram: TOKEN_2022_PROGRAM_ADDRESS, config: { ...config, kind: 'forward' } })).status).toBe(400);
    const series = await seriesAddress(creator, 5n);
    const putSeries = (active: boolean, nextIndex: bigint) =>
      accounts.set(series, {
        owner: CROSS_CORE_PROGRAM_ADDRESS,
        data: new Uint8Array(getSeriesEncoder().encode({
          authority: creator, seriesId: 5n, baseMint: base, quoteMint: quote, baseTokenProgram: TOKEN_2022_PROGRAM_ADDRESS, quoteTokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
          config: { kind: CrossKind.Reopen, disclosure: Disclosure.Open, priceScale: 1_000_000n, grid: { relative: true, minPrice: 0n, tick: 0n, ticks: 20, tickBps: 50, center: 0n }, startTs: 1n, intervalSecs: 604_800n, calendar: none(), callSecs: 600n, revealSecs: 60n, minMatched: 0n, maxImbalanceBps: none(), integratorFeeBps: 0, integrator: creator, gateMint: none(), shards: 2, maxOrders: 64, proceedsTo: creator, oracle: none(), maxCrosses: 2n, rules: paddedRules({}) },
          nextIndex, lastCross: none(), lastCloseTs: 0n, lastPrice: 0n, active, bump: 255,
        } as never)),
      });
    putSeries(true, 0n);
    const spawned = await post('/v1/tx/spawn-next', { series, payer: alice });
    expect(spawned.status).toBe(200);
    expect(spawned.body.cross).toBe(await crossAddress(series, 0n));
    putSeries(false, 0n);
    expect((await post('/v1/tx/spawn-next', { series, payer: alice })).body.reason).toBe('SERIES_PAUSED');
    putSeries(true, 2n);
    expect((await post('/v1/tx/spawn-next', { series, payer: alice })).body.reason).toBe('SERIES_DONE');
    expect((await post('/v1/tx/spawn-next', { series: await key(), payer: alice })).body.reason).toBe('NO_SERIES');
    expect((await post('/v1/tx/set-series-active', { authority: creator, series, active: false })).status).toBe(200);
    expect((await post('/v1/tx/series-withdraw', { authority: alice, series, mint: quote, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS, to: alice, amount: '5' })).body.reason).toBe('NOT_THE_AUTHORITY');
    expect((await post('/v1/tx/series-withdraw', { authority: creator, series, mint: quote, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS, to: alice, amount: '0' })).status).toBe(400);
    expect((await post('/v1/tx/series-withdraw', { authority: creator, series, mint: quote, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS, to: alice, amount: '5' })).status).toBe(200);
  });

  it('a request with a body that is not a JSON object, or an unknown route, is refused plainly', async () => {
    const r = await app.inject({ method: 'POST', url: '/v1/tx/draw-begin', payload: '[]' as never, headers: { 'content-type': 'application/json' } });
    expect(r.statusCode).toBe(400);
    expect(JSON.parse(r.body).error).toMatch(/JSON object/);
  });
});
