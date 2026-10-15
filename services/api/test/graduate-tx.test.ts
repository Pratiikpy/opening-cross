// cross_graduate over HTTP with accounts injected in memory: the release gate, the charter conditions, the round lifecycle (start, vote, finalize, publish, withdraw) with the
// verdict computed exactly as the program computes it, and every built transaction decoded back to its instruction. The program is not run here
// (tests/core/test/graduate.test.ts runs it against the real DAMM v2 binary and cross_core).
import { describe, expect, it } from 'vitest';
import { none, some } from '@solana/kit';
import {
  CAST_VOTE_DISCRIMINATOR,
  FINALIZE_ROUND_DISCRIMINATOR,
  INIT_CHARTER_DISCRIMINATOR,
  POST_VOLUME_DISCRIMINATOR,
  PUBLISH_OUTCOME_DISCRIMINATOR,
  START_ROUND_DISCRIMINATOR,
  WITHDRAW_VOTE_DISCRIMINATOR,
  getCastVoteInstructionDataDecoder,
  getCharterEncoder,
  getInitCharterInstructionDataDecoder,
  getOutcomeEncoder,
  getPostVolumeInstructionDataDecoder,
  getRoundEncoder,
  getVoteRecordEncoder,
} from '@opening-cross/cross-graduate-client';
import { CROSS_GRADUATE_PROGRAM_ADDRESS, CrossState, FLAG_GOVERNED_GRADUATION, ata, charterAddress, outcomeAddress, roundAddress, voteAddress } from '@opening-cross/sdk';
import { registerGraduateTx } from '../src/routes/graduate-tx.js';
import { type Db } from '../src/routes/programs-support.js';
import { Chain, NOW, SPL, caller, database, decode, key, ready, server, startsWith } from './helpers/wave3d.js';

const DAY = 86_400;
const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';

type Round = { index?: number; closesTs?: number; tallies?: bigint[]; lockedTotal?: bigint; finalized?: boolean; passed?: boolean; winner?: number; volumeSet?: boolean; volumeQuote?: bigint; minVolume?: bigint; quorumBps?: number; attester?: boolean };

async function fixture(o: { state?: CrossState; governed?: boolean; orders?: number; charter?: boolean; rounds?: number; active?: boolean; passed?: boolean; supply?: bigint } = {}) {
  const chain = new Chain();
  const [creator, voter, attester, quote, base, stranger] = await Promise.all([key(), key(), key(), key(), key(), key()]);
  chain.mint(quote);
  chain.mint(base, { decimals: 6, supply: o.supply ?? 1_000_000n });
  chain.deploy('crossGraduate');
  await chain.token(voter, base, 400_000n);
  const state = o.state ?? CrossState.Finalized;
  const cross = await chain.cross({ creator, quoteMint: quote, baseMint: base, state, ordersTotal: o.orders ?? (state === CrossState.Live ? 0 : 5), ...(o.governed === false ? {} : { ext: { flags: FLAG_GOVERNED_GRADUATION, totalSupply: 1_000_000n } }) });
  const charter = await charterAddress(cross);
  const putCharter = (p: { rounds?: number; active?: boolean; passed?: boolean } = {}) =>
    chain.put(charter, CROSS_GRADUATE_PROGRAM_ADDRESS, getCharterEncoder().encode({ cross, creator, quorumBps: 4_000, windowSecs: BigInt(7 * DAY), minVolume: 0n, volumeAttester: none(), rounds: p.rounds ?? o.rounds ?? 0, active: p.active ?? o.active ?? false, passed: p.passed ?? o.passed ?? false, bump: 1 }));
  if (o.charter !== false) putCharter();
  const putRound = async (r: Round = {}) => {
    const index = r.index ?? 0;
    const address = await roundAddress(cross, index);
    chain.put(
      address,
      CROSS_GRADUATE_PROGRAM_ADDRESS,
      getRoundEncoder().encode({
        cross, index, baseMint: base, baseTokenProgram: SPL, opensTs: BigInt(NOW - 3 * DAY), closesTs: BigInt(r.closesTs ?? NOW + 4 * DAY), quorumBps: r.quorumBps ?? 4_000, minVolume: r.minVolume ?? 0n, volumeAttester: r.attester ? some(attester) : none(),
        tallies: r.tallies ?? [0n, 0n, 0n, 0n], lockedTotal: r.lockedTotal ?? 0n, volumeQuote: r.volumeQuote ?? 0n, volumeSet: r.volumeSet ?? false, finalized: r.finalized ?? false, passed: r.passed ?? false, winner: r.winner ?? 0, bump: 1,
      }),
    );
    return address;
  };
  const app = server();
  registerGraduateTx(app, { account: chain.account, lifetime: chain.lifetime, clock: () => NOW, gate: ready });
  return { chain, creator, voter, attester, quote, base, stranger, cross, charter, putCharter, putRound, app, ...caller(app) };
}
const programIxs = (tx: string) => decode(tx).filter((i) => i.programAddress === CROSS_GRADUATE_PROGRAM_ADDRESS);

describe('cross_graduate', () => {
  it('refuses every route when the program is not on the cluster, and the reads say so', async () => {
    const f = await fixture();
    const app = server();
    registerGraduateTx(app, { account: f.chain.account, lifetime: f.chain.lifetime, clock: () => NOW, gate: async () => 'program-missing', db: (await database()).db as Db });
    const c = caller(app);
    for (const [route, body] of [
      ['graduate-init-charter', { creator: f.creator, cross: f.cross, quorumBps: 4000, windowSecs: 7 * DAY }],
      ['graduate-start-round', { creator: f.creator, cross: f.cross }],
      ['graduate-cast-vote', { voter: f.voter, cross: f.cross, venue: 'dlmm', amount: '1' }],
      ['graduate-post-volume', { attester: f.attester, cross: f.cross, volumeQuote: '1' }],
      ['graduate-finalize-round', { payer: f.voter, cross: f.cross }],
      ['graduate-publish-outcome', { payer: f.voter, cross: f.cross }],
      ['graduate-withdraw-vote', { voter: f.voter, cross: f.cross }],
    ] as [string, Record<string, unknown>][]) {
      const r = await c.post(`/v1/tx/${route}`, body);
      expect(r.status, route).toBe(409);
      expect(r.body.reason, route).toBe('PROGRAM_NOT_DEPLOYED');
    }
    const g = await c.get(`/v1/crosses/${f.cross}/graduation`);
    expect(g.status).toBe(200);
    expect(g.body).toMatchObject({ governed: true, applies: true, charter: null, rounds: [], seeding: { requiresOutcome: true, ready: false }, release: { deployed: false } });
    expect(g.body.note).toMatch(/no pool can open/);
    expect((await c.get(`/v1/graduation/rounds/${f.charter}`)).body.reason).toBe('PROGRAM_NOT_DEPLOYED');
  }, 30_000);

  it('sets a charter for the creator of a governed cross before its first order, with sane terms, once', async () => {
    const f = await fixture({ state: CrossState.Live, charter: false });
    const ok = await f.post('/v1/tx/graduate-init-charter', { creator: f.creator, cross: f.cross, quorumBps: 4_000, windowSecs: 7 * DAY, minVolume: '5000', volumeAttester: f.attester });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.charter).toBe(f.charter);
    const ix = programIxs(ok.body.transaction)[0]!;
    expect(startsWith(ix, INIT_CHARTER_DISCRIMINATOR)).toBe(true);
    expect(getInitCharterInstructionDataDecoder().decode(ix.data!)).toMatchObject({ quorumBps: 4_000, windowSecs: BigInt(7 * DAY), minVolume: 5_000n });
    const bad = (patch: Record<string, unknown>) => f.post('/v1/tx/graduate-init-charter', { creator: f.creator, cross: f.cross, quorumBps: 4_000, windowSecs: 7 * DAY, ...patch });
    for (const patch of [{ quorumBps: 999 }, { quorumBps: 10_001 }, { windowSecs: 3 * DAY - 1 }, { windowSecs: 30 * DAY + 1 }, { minVolume: '1' }]) expect((await bad(patch)).body.reason, JSON.stringify(patch)).toBe('BAD_CHARTER');
    expect((await bad({ quorumBps: 1_000, windowSecs: 3 * DAY })).status).toBe(200);
    expect((await bad({ quorumBps: 10_000, windowSecs: 30 * DAY })).status).toBe(200);
    expect((await bad({ creator: f.stranger })).body.reason).toBe('NOT_THE_CREATOR');
    const ungoverned = await fixture({ state: CrossState.Live, charter: false, governed: false });
    expect((await ungoverned.post('/v1/tx/graduate-init-charter', { creator: ungoverned.creator, cross: ungoverned.cross, quorumBps: 4000, windowSecs: 7 * DAY })).body.reason).toBe('NOT_GOVERNED');
    const traded = await fixture({ state: CrossState.Live, charter: false, orders: 1 });
    expect((await traded.post('/v1/tx/graduate-init-charter', { creator: traded.creator, cross: traded.cross, quorumBps: 4000, windowSecs: 7 * DAY })).body.reason).toBe('TOO_LATE');
    f.putCharter();
    expect((await bad({})).body.reason).toBe('ALREADY_EXISTS');
  });

  it('starts a round once the cross is finalized, for the creator, one at a time, three at most', async () => {
    const f = await fixture();
    const ok = await f.post('/v1/tx/graduate-start-round', { creator: f.creator, cross: f.cross });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toMatchObject({ round: await roundAddress(f.cross, 0), index: 0, escrow: await ata(await roundAddress(f.cross, 0), f.base, SPL), closesAt: String(NOW + 7 * DAY) });
    expect(startsWith(programIxs(ok.body.transaction)[0]!, START_ROUND_DISCRIMINATOR)).toBe(true);
    expect((await f.post('/v1/tx/graduate-start-round', { creator: f.stranger, cross: f.cross })).body.reason).toBe('NOT_THE_CREATOR');
    f.putCharter({ rounds: 1, active: true });
    expect((await f.post('/v1/tx/graduate-start-round', { creator: f.creator, cross: f.cross })).body.reason).toBe('ROUND_OPEN');
    f.putCharter({ rounds: 1, active: false, passed: true });
    expect((await f.post('/v1/tx/graduate-start-round', { creator: f.creator, cross: f.cross })).body.reason).toBe('ALREADY_PASSED');
    f.putCharter({ rounds: 3 });
    expect((await f.post('/v1/tx/graduate-start-round', { creator: f.creator, cross: f.cross })).body.reason).toBe('NO_ROUNDS_LEFT');
    f.putCharter({ rounds: 2 });
    expect((await f.post('/v1/tx/graduate-start-round', { creator: f.creator, cross: f.cross })).body.index).toBe(2);
    const live = await fixture({ state: CrossState.Cleared });
    expect((await live.post('/v1/tx/graduate-start-round', { creator: live.creator, cross: live.cross })).body.reason).toBe('CROSS_NOT_FINALIZED');
    const bare = await fixture({ charter: false });
    expect((await bare.post('/v1/tx/graduate-start-round', { creator: bare.creator, cross: bare.cross })).body.reason).toBe('NO_CHARTER');
  });

  it('locks a vote behind a venue by name or number: the window, the venue lock, the balance, a stake that grows', async () => {
    const f = await fixture({ rounds: 1, active: true });
    const round = await f.putRound();
    const ok = await f.post('/v1/tx/graduate-cast-vote', { voter: f.voter, cross: f.cross, venue: 'raydium_cpmm', amount: '100000' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toMatchObject({ round, venue: 'raydium_cpmm', venueNumber: 2, amount: '100000', lockedNow: '100000', unlocksAt: String(NOW + 4 * DAY) });
    const ix = programIxs(ok.body.transaction)[0]!;
    expect(startsWith(ix, CAST_VOTE_DISCRIMINATOR)).toBe(true);
    expect(getCastVoteInstructionDataDecoder().decode(ix.data!)).toMatchObject({ venue: 2, amount: 100_000n });
    expect(ix.accounts!.map((a) => a.address)).toEqual(expect.arrayContaining([f.voter, round, await ata(round, f.base, SPL), await voteAddress(round, f.voter)]));
    expect((await f.post('/v1/tx/graduate-cast-vote', { voter: f.voter, cross: f.cross, venue: 2, amount: '1' })).status).toBe(200);
    expect((await f.post('/v1/tx/graduate-cast-vote', { voter: f.voter, cross: f.cross, venue: 'unknown', amount: '1' })).status).toBe(400);
    expect((await f.post('/v1/tx/graduate-cast-vote', { voter: f.voter, cross: f.cross, venue: 4, amount: '1' })).status).toBe(400);
    expect((await f.post('/v1/tx/graduate-cast-vote', { voter: f.voter, cross: f.cross, venue: 'dlmm', amount: '0' })).body.reason).toBe('NOTHING_TO_DO');
    expect((await f.post('/v1/tx/graduate-cast-vote', { voter: f.voter, cross: f.cross, venue: 'dlmm', amount: '400001' })).body).toMatchObject({ reason: 'INSUFFICIENT_BALANCE', have: '400000' });
    // a stake can grow, not change venue
    f.chain.put(await voteAddress(round, f.voter), CROSS_GRADUATE_PROGRAM_ADDRESS, getVoteRecordEncoder().encode({ voter: f.voter, round, venue: 2, amount: 100_000n, bump: 1 }));
    const grow = await f.post('/v1/tx/graduate-cast-vote', { voter: f.voter, cross: f.cross, venue: 'raydium_cpmm', amount: '50' });
    expect(grow.body.lockedNow).toBe('100050');
    expect((await f.post('/v1/tx/graduate-cast-vote', { voter: f.voter, cross: f.cross, venue: 'dlmm', amount: '50' })).body.reason).toBe('VENUE_LOCKED');
    // the window
    await f.putRound({ closesTs: NOW });
    expect((await f.post('/v1/tx/graduate-cast-vote', { voter: f.voter, cross: f.cross, venue: 2, amount: '1' })).body.reason).toBe('NOT_VOTING');
    await f.putRound({ finalized: true, passed: false });
    expect((await f.post('/v1/tx/graduate-cast-vote', { voter: f.voter, cross: f.cross, venue: 2, amount: '1' })).body.reason).toBe('NOT_VOTING');
    // a round that was never started
    expect((await f.post('/v1/tx/graduate-cast-vote', { voter: f.voter, cross: f.cross, venue: 2, amount: '1', round: 2 })).body.reason).toBe('NO_SUCH_ROUND');
    const none_ = await fixture({ rounds: 0 });
    expect((await none_.post('/v1/tx/graduate-cast-vote', { voter: none_.voter, cross: none_.cross, venue: 2, amount: '1' })).body.reason).toBe('NO_ROUND');
  });

  it('lets only the named attester post the volume, and not after the round is finalized', async () => {
    const f = await fixture({ rounds: 1, active: true });
    await f.putRound({ attester: true, minVolume: 1_000n });
    const ok = await f.post('/v1/tx/graduate-post-volume', { attester: f.attester, cross: f.cross, volumeQuote: '1500' });
    expect(ok.status).toBe(200);
    const ix = programIxs(ok.body.transaction)[0]!;
    expect(startsWith(ix, POST_VOLUME_DISCRIMINATOR)).toBe(true);
    expect(getPostVolumeInstructionDataDecoder().decode(ix.data!).volumeQuote).toBe(1_500n);
    expect((await f.post('/v1/tx/graduate-post-volume', { attester: f.stranger, cross: f.cross, volumeQuote: '1' })).body).toMatchObject({ reason: 'NOT_THE_ATTESTER', attester: f.attester });
    await f.putRound({ attester: false });
    expect((await f.post('/v1/tx/graduate-post-volume', { attester: f.attester, cross: f.cross, volumeQuote: '1' })).body.reason).toBe('NOT_THE_ATTESTER');
    await f.putRound({ attester: true, finalized: true });
    expect((await f.post('/v1/tx/graduate-post-volume', { attester: f.attester, cross: f.cross, volumeQuote: '1' })).body.reason).toBe('NOT_VOTING');
  });

  it('finalizes after the window and says whether the round passes, with the shortfall when it does not', async () => {
    const f = await fixture({ rounds: 1, active: true, supply: 1_000_000n });
    const fin = () => f.post('/v1/tx/graduate-finalize-round', { payer: f.stranger, cross: f.cross });
    await f.putRound({ closesTs: NOW + 5 });
    expect((await fin()).body).toMatchObject({ reason: 'WINDOW_OPEN', secondsLeft: '5' });
    // 400,000 locked is exactly the 40% quorum of 1,000,000; 200,001 against 199,999 is a strict majority
    await f.putRound({ closesTs: NOW, lockedTotal: 400_000n, tallies: [200_001n, 199_999n, 0n, 0n] });
    const pass = await fin();
    expect(pass.status, JSON.stringify(pass.body)).toBe(200);
    expect(pass.body).toMatchObject({ willPass: true, winner: 'damm_v2' });
    expect(startsWith(programIxs(pass.body.transaction)[0]!, FINALIZE_ROUND_DISCRIMINATOR)).toBe(true);
    await f.putRound({ closesTs: NOW, lockedTotal: 399_999n, tallies: [399_999n, 0n, 0n, 0n] });
    expect((await fin()).body).toMatchObject({ willPass: false, winner: null, shortfall: { code: 'BELOW_QUORUM' } });
    await f.putRound({ closesTs: NOW, lockedTotal: 400_000n, tallies: [200_000n, 200_000n, 0n, 0n] });
    expect((await fin()).body.shortfall.code).toBe('NO_MAJORITY');
    await f.putRound({ closesTs: NOW, lockedTotal: 0n });
    expect((await fin()).body.shortfall.code).toBe('NO_VOTES');
    // the volume gate: no figure, a figure one atom short, the minimum
    await f.putRound({ closesTs: NOW, lockedTotal: 500_000n, tallies: [0n, 500_000n, 0n, 0n], minVolume: 1_000n, attester: true });
    expect((await fin()).body.shortfall.code).toBe('VOLUME_SHORT');
    await f.putRound({ closesTs: NOW, lockedTotal: 500_000n, tallies: [0n, 500_000n, 0n, 0n], minVolume: 1_000n, attester: true, volumeSet: true, volumeQuote: 999n });
    expect((await fin()).body.willPass).toBe(false);
    await f.putRound({ closesTs: NOW, lockedTotal: 500_000n, tallies: [0n, 500_000n, 0n, 0n], minVolume: 1_000n, attester: true, volumeSet: true, volumeQuote: 1_000n });
    expect((await fin()).body).toMatchObject({ willPass: true, winner: 'dlmm' });
    // a tie between equal tallies goes to the lowest venue number, as the program does, but only with a strict majority
    await f.putRound({ closesTs: NOW, lockedTotal: 500_000n, tallies: [0n, 0n, 500_000n, 0n] });
    expect((await fin()).body.winner).toBe('raydium_cpmm');
    // a quorum measured against supply that grew: 500,000 of 1,300,000 is 38.5%
    f.chain.setSupply(f.base, 1_300_000n);
    expect((await fin()).body).toMatchObject({ willPass: false, shortfall: { code: 'BELOW_QUORUM' } });
    await f.putRound({ closesTs: NOW, finalized: true });
    expect((await fin()).body.reason).toBe('NOT_VOTING');
  });

  it('publishes the outcome of a passed round once, and withdraws a vote after the window', async () => {
    const f = await fixture({ rounds: 1 });
    await f.putRound({ closesTs: NOW - 1, finalized: true, passed: true, winner: 3 });
    const pub = await f.post('/v1/tx/graduate-publish-outcome', { payer: f.stranger, cross: f.cross });
    expect(pub.status, JSON.stringify(pub.body)).toBe(200);
    expect(pub.body).toMatchObject({ outcome: await outcomeAddress(f.cross), venue: 'metadao_futarchy', venueNumber: 3 });
    expect(startsWith(programIxs(pub.body.transaction)[0]!, PUBLISH_OUTCOME_DISCRIMINATOR)).toBe(true);
    f.chain.put(await outcomeAddress(f.cross), CROSS_GRADUATE_PROGRAM_ADDRESS, getOutcomeEncoder().encode({ cross: f.cross, venue: 3, round: 0, publishedTs: BigInt(NOW), bump: 1 }));
    expect((await f.post('/v1/tx/graduate-publish-outcome', { payer: f.stranger, cross: f.cross })).body.reason).toBe('ALREADY_PUBLISHED');
    await f.putRound({ closesTs: NOW - 1, finalized: true, passed: false });
    expect((await f.post('/v1/tx/graduate-publish-outcome', { payer: f.stranger, cross: f.cross })).body.reason).toBe('NOT_PASSED');
    // withdraw
    const round = await f.putRound({ closesTs: NOW - 1, finalized: true });
    expect((await f.post('/v1/tx/graduate-withdraw-vote', { voter: f.voter, cross: f.cross })).body.reason).toBe('NO_VOTE');
    f.chain.put(await voteAddress(round, f.voter), CROSS_GRADUATE_PROGRAM_ADDRESS, getVoteRecordEncoder().encode({ voter: f.voter, round, venue: 1, amount: 4_000n, bump: 1 }));
    const w = await f.post('/v1/tx/graduate-withdraw-vote', { voter: f.voter, cross: f.cross });
    expect(w.status).toBe(200);
    expect(w.body.amount).toBe('4000');
    expect(startsWith(programIxs(w.body.transaction)[0]!, WITHDRAW_VOTE_DISCRIMINATOR)).toBe(true);
    await f.putRound({ closesTs: NOW + 1 });
    expect((await f.post('/v1/tx/graduate-withdraw-vote', { voter: f.voter, cross: f.cross })).body).toMatchObject({ reason: 'WINDOW_OPEN', secondsLeft: '1' });
    expect(decode(w.body.transaction).some((i) => i.programAddress === ATA_PROGRAM)).toBe(false);
  });

  it('reads the whole picture of a cross: not governed, governed without a charter, rounds with tallies, the outcome and the instruction that seeds it', async () => {
    const plain = await fixture({ governed: false });
    expect((await plain.get(`/v1/crosses/${plain.cross}/graduation`)).body).toMatchObject({ governed: false, applies: false });
    const bare = await fixture({ charter: false, state: CrossState.Live });
    expect((await bare.get(`/v1/crosses/${bare.cross}/graduation`)).body).toMatchObject({ governed: true, charter: null, seeding: { ready: false } });
    const f = await fixture({ rounds: 2 });
    await f.putRound({ index: 0, closesTs: NOW - 5 * DAY, finalized: true, passed: false, lockedTotal: 100_000n, tallies: [100_000n, 0n, 0n, 0n] });
    await f.putRound({ index: 1, closesTs: NOW + 2 * DAY, lockedTotal: 450_000n, tallies: [300_000n, 150_000n, 0n, 0n] });
    const g = await f.get(`/v1/crosses/${f.cross}/graduation`);
    expect(g.status).toBe(200);
    expect(g.body.charter).toMatchObject({ creator: f.creator, quorumBps: 4_000, roundsUsed: 2, roundsLeft: 1, active: false, passed: false });
    expect(g.body.supply).toBe('1000000');
    expect(g.body.rounds.map((r: { status: string }) => r.status)).toEqual(['failed', 'voting']);
    expect(g.body.rounds[1]).toMatchObject({ quorumNeeded: '400000', wouldPassNow: true, winner: 'damm_v2' });
    expect(g.body.rounds[1].tallies.map((t: { venue: string; locked: string }) => `${t.venue}:${t.locked}`)).toEqual(['damm_v2:300000', 'dlmm:150000', 'raydium_cpmm:0', 'metadao_futarchy:0']);
    expect(g.body.seeding).toMatchObject({ requiresOutcome: true, ready: false, instruction: null });
    f.chain.put(await outcomeAddress(f.cross), CROSS_GRADUATE_PROGRAM_ADDRESS, getOutcomeEncoder().encode({ cross: f.cross, venue: 1, round: 1, publishedTs: BigInt(NOW), bump: 1 }));
    expect((await f.get(`/v1/crosses/${f.cross}/graduation`)).body).toMatchObject({ outcome: { venue: 'dlmm', round: 1 }, seeding: { ready: true, instruction: 'open-dlmm-pair' } });
    const round = await roundAddress(f.cross, 1);
    f.chain.put(await voteAddress(round, f.voter), CROSS_GRADUATE_PROGRAM_ADDRESS, getVoteRecordEncoder().encode({ voter: f.voter, round, venue: 0, amount: 300_000n, bump: 1 }));
    const r = await f.get(`/v1/graduation/rounds/${round}?voter=${f.voter}`);
    expect(r.body).toMatchObject({ round, index: 1, finalized: false, vote: { venue: 'damm_v2', locked: '300000', canWithdraw: false } });
    expect((await f.get(`/v1/graduation/rounds/${round}?voter=${f.stranger}`)).body.vote).toEqual({ voter: f.stranger, locked: '0' });
    expect((await f.get(`/v1/graduation/rounds/${f.charter}`)).status).toBe(404);
  });
});
