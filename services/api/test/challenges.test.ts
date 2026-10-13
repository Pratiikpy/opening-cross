// The arbiter and the challenge window, read from chain: accounts injected in memory, the same crosses the transaction routes are tested on (rules-tx-after.test.ts).
import Fastify from 'fastify';
import { beforeAll, describe, expect, it } from 'vitest';
import { type Address, generateKeyPairSigner, none } from '@solana/kit';
import { TOKEN_2022_PROGRAM_ADDRESS } from '@solana-program/token-2022';
import {
  CROSS_BODY_LEN,
  CROSS_CORE_PROGRAM_ADDRESS,
  CROSS_EXT_LEN,
  CrossKind,
  CrossState,
  Disclosure,
  SupplyMode,
  arbiterRegistryAddress,
  challengeAddress,
  completeRules,
  crossAddress,
  getArbiterRegistryEncoder,
  getChallengeEncoder,
  getCrossEncoder,
  getCrossExtEncoder,
} from '@opening-cross/sdk';
import { RequestError } from '../src/tx.js';
import { registerChallenges } from '../src/routes/challenges.js';

const NOW = 1_800_000_000;
const ZERO = '11111111111111111111111111111111' as Address;
const DAY = 86_400;
const key = async () => (await generateKeyPairSigner()).address;
type Account = { data: Uint8Array; owner: Address };

describe('the arbiter and the challenge window', () => {
  const accounts = new Map<string, Account>();
  let app: ReturnType<typeof Fastify>;
  let creator: Address, base: Address, quote: Address, alice: Address, bob: Address, arbiter: Address, insider: Address;
  let plain: Address, open: Address, finalized: Address;
  const get = async (url: string) => {
    const r = await app.inject({ method: 'GET', url });
    return { status: r.statusCode, body: JSON.parse(r.body) };
  };

  async function putCross(id: bigint, o: { state: CrossState; bond?: bigint; insiders?: Address[]; challenges?: number; openChallenges?: number; clearedTs?: bigint }): Promise<Address> {
    const address = await crossAddress(creator, id);
    const body = getCrossEncoder().encode({
      creator, crossId: id, kind: CrossKind.Launch, supplyMode: SupplyMode.Mint, disclosure: Disclosure.Open, state: o.state, baseMint: base, quoteMint: quote, baseTokenProgram: TOKEN_2022_PROGRAM_ADDRESS, quoteTokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
      baseDecimals: 6, quoteDecimals: 6, proceedsTo: creator, minPrice: 1_000_000n, tick: 100_000n, ticks: 20, priceScale: 1_000_000n, openTs: 1n, closeTs: 2n, revealEndTs: 3n, referencePrice: none(), minMatched: 0n, maxImbalanceBps: none(),
      protocolFeeBps: 30, integratorFeeBps: 20, integrator: creator, feeRecipient: arbiter, gateMint: none(), shards: 2, maxOrders: 64, dustBond: 0n, ordersTotal: 0, ordersOpen: 0, mergedMask: 3, clearing: none(), noPrintReason: none(),
      buyerPaid: 0n, baseBought: 0n, baseSold: 0n, sellerPaid: 0n, feesAccrued: 0n, oracle: none(), calendar: none(), settler: none(), settleDeadlineTs: 0n, baseBound: true, bump: 1, quoteVaultBump: 1, baseVaultBump: 1, bookBump: 1,
    } as never);
    const r = completeRules({});
    const ext = {
      version: 1, rulesSet: true, createdSlot: 1n, flags: 0, guards: { ...r.guards, haltSource: null }, ending: r.ending,
      draw: { epoch: 0, pendingSlot: 0n, pendingPurpose: 0, seed: new Uint8Array(32), seedEpoch: 0, seedReady: true, endBucket: 255, extPending: false, extensionUsed: false, auxMerged: 0n }, identity: r.identity, alloc: { ...r.alloc, priorityGate: null },
      neutrality: { insiders: [...(o.insiders ?? []), ...Array.from({ length: 8 - (o.insiders?.length ?? 0) }, () => ZERO)], insiderCount: o.insiders?.length ?? 0, insiderCliffSecs: 0, insiderVestSecs: 0, bondQuote: o.bond ?? 0n, challengeSecs: o.bond ? 3_600 : 0 },
      neutralState: { bondHeld: o.bond ?? 0n, slashed: 0n, openChallenges: o.openChallenges ?? 0, challenges: o.challenges ?? 0 }, clearing: { classQty: [0n, 0n, 0n], tickets: 0, rho: 0, clearedTs: o.clearedTs ?? 0n, insiderUb: 0n }, referral: r.referral,
      oracleSet: { extraFeeds: [new Uint8Array(32), new Uint8Array(32)] as never, extraCount: 0, quorum: 0, maxSpreadBps: 0, offHoursWidenBps: 0 },
    } as never;
    const data = new Uint8Array(CROSS_BODY_LEN + CROSS_EXT_LEN);
    data.set(body);
    data.set(getCrossExtEncoder().encode(ext), CROSS_BODY_LEN);
    accounts.set(address, { owner: CROSS_CORE_PROGRAM_ADDRESS, data });
    return address;
  }
  const putChallenge = async (cross: Address, id: number, filedTs: bigint, status: 0 | 1 | 2 = 0) =>
    accounts.set(await challengeAddress(cross, id), { owner: CROSS_CORE_PROGRAM_ADDRESS, data: new Uint8Array(getChallengeEncoder().encode({ cross, id, challenger: bob, subject: alice, evidence: Uint8Array.from({ length: 32 }, (_, i) => i), deposit: 10_000_000n, filedTs, status, slashed: 0n, bump: 255 } as never)) });
  const registry = async (owner: Address) => accounts.set(await arbiterRegistryAddress(), { owner, data: new Uint8Array(getArbiterRegistryEncoder().encode({ arbiter, bump: 255 })) });

  beforeAll(async () => {
    [creator, base, quote, alice, bob, arbiter, insider] = await Promise.all(Array.from({ length: 7 }, key));
    plain = await putCross(1n, { state: CrossState.Cleared });
    open = await putCross(2n, { state: CrossState.Cleared, bond: 1_000_000n, insiders: [insider], challenges: 3, openChallenges: 2, clearedTs: BigInt(NOW - 100) });
    finalized = await putCross(3n, { state: CrossState.Finalized, bond: 1_000_000n, insiders: [insider], challenges: 0, clearedTs: BigInt(NOW - 100 * DAY) });
    // challenge 0 was ruled on (its account closed), 1 was filed a day ago, 2 was filed fifteen days ago
    await putChallenge(open, 1, BigInt(NOW - DAY));
    await putChallenge(open, 2, BigInt(NOW - 15 * DAY));
    app = Fastify({ logger: false });
    app.setErrorHandler((err, _req, reply) => {
      if (err instanceof RequestError) return reply.code(err.status).type('application/json').send(JSON.stringify({ error: err.message, ...err.detail }, (_k, x) => (typeof x === 'bigint' ? x.toString() : x)));
      return reply.code(500).send({ error: String(err) });
    });
    registerChallenges(app, { account: async (a) => accounts.get(a) ?? null, clock: () => NOW });
  }, 60_000);

  it('GET /v1/arbiter says that no one is named, then who is', async () => {
    const unnamed = await get('/v1/arbiter');
    expect(unnamed.status).toBe(200);
    expect(unnamed.body).toMatchObject({ named: false, arbiter: null, deadlineSecs: String(14 * DAY) });
    expect(unnamed.body.note).toMatch(/H28/);
    await registry(CROSS_CORE_PROGRAM_ADDRESS);
    expect((await get('/v1/arbiter')).body).toMatchObject({ named: true, arbiter });
    // an account of another program at that address is not a registry
    await registry(arbiter);
    expect((await get('/v1/arbiter')).body.named).toBe(false);
    await registry(CROSS_CORE_PROGRAM_ADDRESS);
  });

  it('the challenge state lists the open challenges with the second each can be closed by anyone', async () => {
    const r = await get(`/v1/crosses/${open}/challenge-state`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ applies: true, state: 'Cleared', filed: 3, open: 2, arbiter, arbiterNamed: true, insiders: [insider], bond: { posted: '1000000', held: '1000000', slashed: '0' }, depositLamports: '10000000' });
    expect(r.body.window).toEqual({ clearedAt: String(NOW - 100), closesAt: String(NOW - 100 + 3_600), open: true });
    expect(r.body.challenges.map((c: { id: number }) => c.id)).toEqual([1, 2]);
    const [day, old] = r.body.challenges;
    expect(day).toMatchObject({ expirable: false, expirableAt: String(NOW - DAY + 14 * DAY), challenger: bob, subject: alice, deposit: '10000000' });
    expect(day.evidence).toBe(Buffer.from(Uint8Array.from({ length: 32 }, (_, i) => i)).toString('hex'));
    expect(old.expirable).toBe(true);
    expect(r.body.finalizeBlocked).toBe('open challenges');
  });

  it('a finalized cross has a closed window, and a cross with no insiders and no bond has none', async () => {
    const f = await get(`/v1/crosses/${finalized}/challenge-state`);
    expect(f.body.window.open).toBe(false);
    expect(f.body.finalizeBlocked).toBeNull();
    expect(f.body.challenges).toEqual([]);
    const p = await get(`/v1/crosses/${plain}/challenge-state`);
    expect(p.body).toMatchObject({ applies: false });
  });

  it('says so when no arbiter is named, and refuses what is not a cross', async () => {
    accounts.delete(await arbiterRegistryAddress());
    const r = await get(`/v1/crosses/${open}/challenge-state`);
    expect(r.body).toMatchObject({ arbiter: null, arbiterNamed: false });
    expect(r.body.note).toMatch(/expiring/);
    expect((await get(`/v1/crosses/${creator}/challenge-state`)).status).toBe(404);
    expect((await get(`/v1/crosses/${base}/challenge-state`)).status).toBe(404);
    expect((await get('/v1/crosses/nope/challenge-state')).status).toBe(400);
  });
});
