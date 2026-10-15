// cross_graduate over HTTP (D10, Z0; ADR-0656): graduation by holder vote. A cross whose creator set the governed-graduation rule (flag 32) before its first order
// opens a pool only on the venue holders chose: a charter fixes the terms, rounds lock votes behind a venue, finalize_round decides, publish_outcome writes the
// account cross_settle reads. Unsigned transactions and reads. The program, and the gate in cross_settle's seeding instructions, are NOT deployed to devnet until
// the operations key is funded (docs/HUMAN_TASKS.md H27, H43).
//
//   POST /v1/tx/graduate-init-charter    { creator, cross, quorumBps, windowSecs, minVolume?, volumeAttester? }
//   POST /v1/tx/graduate-start-round     { creator, cross }
//   POST /v1/tx/graduate-cast-vote       { voter, cross, venue, amount, round? }      venue: "damm_v2" | "dlmm" | "raydium_cpmm" | "metadao_futarchy" (or 0 to 3); locks tokens until the window ends
//   POST /v1/tx/graduate-post-volume     { attester, cross, volumeQuote, round? }     the charter's attester
//   POST /v1/tx/graduate-finalize-round  { payer, cross, round? }                     anyone, after the window
//   POST /v1/tx/graduate-publish-outcome { payer, cross, round? }                     anyone, once a round passed
//   POST /v1/tx/graduate-withdraw-vote   { voter, cross, round? }                     after the window: the locked tokens back
//   GET  /v1/crosses/:address/graduation the charter, every round with its tally, the verdict now, the outcome and what the seeding instructions need
//   GET  /v1/graduation/rounds/:round?voter=  one round by its address, with the voter's lock
//
// `round` is the round's index (0 to 2); without it the latest round is meant.
import type { FastifyInstance, FastifyReply } from 'fastify';
import { type Address, createNoopSigner } from '@solana/kit';
import {
  CAST_VOTE_DISCRIMINATOR,
  CHARTER_DISCRIMINATOR,
  FINALIZE_ROUND_DISCRIMINATOR,
  INIT_CHARTER_DISCRIMINATOR,
  OUTCOME_DISCRIMINATOR,
  POST_VOLUME_DISCRIMINATOR,
  PUBLISH_OUTCOME_DISCRIMINATOR,
  ROUND_DISCRIMINATOR,
  START_ROUND_DISCRIMINATOR,
  VOTE_RECORD_DISCRIMINATOR,
  WITHDRAW_VOTE_DISCRIMINATOR,
  getCharterDecoder,
  getOutcomeDecoder,
  getRoundDecoder,
  getVoteRecordDecoder,
} from '@opening-cross/cross-graduate-client';
import {
  CROSS_GRADUATE_PROGRAM_ADDRESS,
  CrossState,
  GRADUATE_MAX_ROUNDS,
  GRADUATE_VENUES,
  SPL_TOKEN_PROGRAM,
  TOKEN_2022_PROGRAM,
  ata,
  buildCastVote,
  buildFinalizeRound,
  buildInitCharter,
  buildPostVolume,
  buildPublishOutcome,
  buildStartRound,
  buildWithdrawVote,
  charterAddress,
  checkCharterCross,
  checkCharterTerms,
  checkVote,
  decideRound,
  isGoverned,
  outcomeAddress,
  roundAddress,
  roundShortfall,
  venueNumber,
  voteAddress,
} from '@opening-cross/sdk';
import { type Lifetime, RequestError } from '../tx.js';
import { addr, i64, int, json, obj, only, opt, u64 } from './_inputs.js';
import { hasActiveTransferHook } from './meteora-tx.js';
import { type AccountReader, type Db, type ProgramRelease, building, failIf, mintOf, mintSupply, oneTx, programRelease, readAccount, readCross, releaseNote, requireNew, tokenBalance } from './programs-support.js';

export type GraduateTxDeps = {
  account: AccountReader;
  lifetime: () => Promise<Lifetime>;
  db?: Db;
  clock?: () => number;
  gate?: ProgramRelease;
};

const send = (reply: FastifyReply, v: unknown, status = 200) => reply.code(status).type('application/json').send(json(v));

function venueArg(v: unknown): number {
  const n = typeof v === 'string' ? venueNumber(v) : typeof v === 'number' && Number.isInteger(v) ? v : null;
  if (n === null || n < 0 || n >= GRADUATE_VENUES.length) throw new RequestError(400, `venue must be one of ${GRADUATE_VENUES.join(', ')} (or a number from 0 to ${GRADUATE_VENUES.length - 1})`);
  return n;
}

export function registerGraduateTx(app: FastifyInstance, d: GraduateTxDeps): void {
  const now = () => BigInt(d.clock?.() ?? Math.floor(Date.now() / 1000));
  const gate = d.gate ?? programRelease({ account: d.account, ...(d.clock && { clock: d.clock }) });
  const need = (name: string, discriminator: Uint8Array) => requireNew(gate, 'crossGraduate', { name, discriminator });
  const tx = async (payer: Address, ixs: Parameters<typeof oneTx>[1], what: string) => oneTx(payer, ixs, await d.lifetime(), what);

  async function readCharter(cross: Address) {
    const { value } = await readAccount(d.account, await charterAddress(cross), { owner: CROSS_GRADUATE_PROGRAM_ADDRESS, disc: CHARTER_DISCRIMINATOR as Uint8Array, decode: (b) => getCharterDecoder().decode(b), what: 'graduation charter', reason: 'NO_CHARTER' });
    return value;
  }
  async function readRoundAt(address: Address) {
    const { value } = await readAccount(d.account, address, { owner: CROSS_GRADUATE_PROGRAM_ADDRESS, disc: ROUND_DISCRIMINATOR as Uint8Array, decode: (b) => getRoundDecoder().decode(b), what: 'graduation round', reason: 'NO_SUCH_ROUND' });
    return value;
  }
  /** The charter and the round the request means (the latest unless `round` is given). */
  async function target(cross: Address, round: unknown) {
    const charter = await readCharter(cross).catch((e) => {
      if (e instanceof RequestError && e.detail?.reason === 'NO_CHARTER') throw new RequestError(409, 'This cross has no graduation charter: the creator sets one before the first order (graduate-init-charter).', { reason: 'NO_CHARTER' });
      throw e;
    });
    if (charter.rounds === 0) throw new RequestError(409, 'No round has been started: the creator starts one once the cross is finalized (graduate-start-round).', { reason: 'NO_ROUND' });
    const index = round === undefined || round === null ? charter.rounds - 1 : int(round, 'round', GRADUATE_MAX_ROUNDS - 1);
    if (index >= charter.rounds) throw new RequestError(404, `The charter has started ${charter.rounds} round(s); there is no round ${index}.`, { reason: 'NO_SUCH_ROUND', rounds: charter.rounds });
    const address = await roundAddress(cross, index);
    return { charter, index, address, round: await readRoundAt(address) };
  }
  const tallyJson = (t: readonly bigint[]) => GRADUATE_VENUES.map((venue, i) => ({ venue, venueNumber: i, locked: t[i] ?? 0n }));
  const volumeOf = (r: { volumeSet: boolean; volumeQuote: bigint }) => (r.volumeSet ? r.volumeQuote : null);

  app.post('/v1/tx/graduate-init-charter', async (req, reply) => {
    const b = obj(req.body);
    only(b, ['creator', 'cross', 'quorumBps', 'windowSecs', 'minVolume', 'volumeAttester'], 'graduate-init-charter');
    const creator = addr(b.creator, 'creator');
    const crossAddr = addr(b.cross, 'cross');
    const terms = { quorumBps: int(b.quorumBps, 'quorumBps', 0xffff), windowSecs: i64(b.windowSecs, 'windowSecs'), minVolume: opt(b.minVolume, (v) => u64(v, 'minVolume')) ?? 0n, volumeAttester: opt(b.volumeAttester, (v) => addr(v, 'volumeAttester')) };
    const release = await need('init_charter', INIT_CHARTER_DISCRIMINATOR as Uint8Array);
    failIf(checkCharterTerms(terms), 'The charter terms are not valid');
    const cross = await readCross(d.account, crossAddr);
    failIf(checkCharterCross({ creator, cross }), 'The charter cannot be set');
    if (await d.account(await charterAddress(crossAddr))) throw new RequestError(409, 'This cross already has a charter; its terms never change.', { reason: 'ALREADY_EXISTS' });
    const built = await building(() => buildInitCharter({ creator: createNoopSigner(creator), cross: crossAddr, ...terms }));
    return send(reply, {
      ...(await tx(creator, [built.instruction], 'charter')),
      charter: built.charter,
      terms: { ...terms, venues: GRADUATE_VENUES },
      note: 'The terms never change. Organic volume is an attested figure: a charter with an attester is as honest as that attester, and one without has no volume gate. Quorum is measured against the live supply when a round is finalized.',
      release,
    });
  });

  app.post('/v1/tx/graduate-start-round', async (req, reply) => {
    const b = obj(req.body);
    only(b, ['creator', 'cross'], 'graduate-start-round');
    const creator = addr(b.creator, 'creator');
    const crossAddr = addr(b.cross, 'cross');
    const release = await need('start_round', START_ROUND_DISCRIMINATOR as Uint8Array);
    const cross = await readCross(d.account, crossAddr);
    const charter = await readCharter(crossAddr).catch((e) => {
      if (e instanceof RequestError && e.detail?.reason === 'NO_CHARTER') throw new RequestError(409, 'This cross has no graduation charter.', { reason: 'NO_CHARTER' });
      throw e;
    });
    if (charter.creator !== creator) throw new RequestError(422, `${creator} is not the creator of this charter (${charter.creator}).`, { reason: 'NOT_THE_CREATOR', creator: charter.creator });
    if (charter.passed) throw new RequestError(409, 'A round already passed; the venue is chosen.', { reason: 'ALREADY_PASSED' });
    if (charter.active) throw new RequestError(409, 'A round is open or waiting to be finalized.', { reason: 'ROUND_OPEN' });
    if (charter.rounds >= GRADUATE_MAX_ROUNDS) throw new RequestError(409, `All ${GRADUATE_MAX_ROUNDS} rounds were used.`, { reason: 'NO_ROUNDS_LEFT' });
    if (cross.data.state !== CrossState.Finalized || !cross.data.baseBound) throw new RequestError(409, 'The cross must be finalized and its token must exist before holders can vote.', { reason: 'CROSS_NOT_FINALIZED', state: CrossState[cross.data.state], baseBound: cross.data.baseBound });
    const built = await building(() => buildStartRound({ creator: createNoopSigner(creator), cross: crossAddr, baseMint: cross.data.baseMint, baseTokenProgram: cross.data.baseTokenProgram, index: charter.rounds }));
    return send(reply, {
      ...(await tx(creator, [built.instruction], 'round start')),
      round: built.round,
      index: charter.rounds,
      escrow: built.escrow,
      closesAt: now() + charter.windowSecs,
      note: 'Quorum is measured against the live supply. An issuer that still holds a mint authority can raise the supply while the round is open, which is a veto by dilution: check that the mint authority is gone before asking holders to vote.',
      release,
    });
  });

  app.post('/v1/tx/graduate-cast-vote', async (req, reply) => {
    const b = obj(req.body);
    only(b, ['voter', 'cross', 'venue', 'amount', 'round'], 'graduate-cast-vote');
    const voter = addr(b.voter, 'voter');
    const venue = venueArg(b.venue);
    const amount = u64(b.amount, 'amount');
    const release = await need('cast_vote', CAST_VOTE_DISCRIMINATOR as Uint8Array);
    const t = await target(addr(b.cross, 'cross'), b.round);
    const voteAcct = await d.account(await voteAddress(t.address, voter));
    const existing = voteAcct && (VOTE_RECORD_DISCRIMINATOR as Uint8Array).every((x, i) => voteAcct.data[i] === x) ? getVoteRecordDecoder().decode(voteAcct.data) : null;
    failIf(checkVote({ round: t.round, venue, amount, now: now(), existingVenue: existing ? existing.venue : null }), 'The vote would be refused');
    const m = await mintOf(d.account, t.round.baseMint, 'baseMint');
    if (m.tokenProgram === TOKEN_2022_PROGRAM && hasActiveTransferHook(m.data)) throw new RequestError(422, 'The token runs a transfer hook on every transfer. The vote is built here without hook accounts. Refused.', { reason: 'MINT_HAS_TRANSFER_HOOK', mint: t.round.baseMint });
    const have = await tokenBalance(d.account, await ata(voter, t.round.baseMint, t.round.baseTokenProgram));
    if (have === null || have < amount) throw new RequestError(422, `${voter} holds ${have ?? 0n} of the token; ${amount} was asked for.`, { reason: 'INSUFFICIENT_BALANCE', have: have ?? 0n, need: amount });
    const ix = await building(() => buildCastVote({ voter: createNoopSigner(voter), round: t.address, baseMint: t.round.baseMint, baseTokenProgram: t.round.baseTokenProgram, venue, amount }));
    return send(reply, {
      ...(await tx(voter, [ix], 'vote')),
      round: t.address,
      venue: GRADUATE_VENUES[venue],
      venueNumber: venue,
      amount,
      lockedNow: (existing?.amount ?? 0n) + amount,
      unlocksAt: t.round.closesTs,
      note: `The tokens are locked in the round's escrow until ${t.round.closesTs} and cannot be sold or moved before. A wallet can add to its stake but not change venue.`,
      release,
    });
  });

  app.post('/v1/tx/graduate-post-volume', async (req, reply) => {
    const b = obj(req.body);
    only(b, ['attester', 'cross', 'volumeQuote', 'round'], 'graduate-post-volume');
    const attester = addr(b.attester, 'attester');
    const volumeQuote = u64(b.volumeQuote, 'volumeQuote');
    const release = await need('post_volume', POST_VOLUME_DISCRIMINATOR as Uint8Array);
    const t = await target(addr(b.cross, 'cross'), b.round);
    if (t.round.finalized) throw new RequestError(409, 'The round is finalized.', { reason: 'NOT_VOTING' });
    const named = t.round.volumeAttester.__option === 'Some' ? t.round.volumeAttester.value : null;
    if (named !== attester) throw new RequestError(422, `${attester} is not this charter's volume attester${named ? ` (${named})` : ' (it names none)'}.`, { reason: 'NOT_THE_ATTESTER', attester: named });
    return send(reply, { ...(await tx(attester, [buildPostVolume({ attester: createNoopSigner(attester), round: t.address, volumeQuote })], 'volume')), round: t.address, volumeQuote, release });
  });

  app.post('/v1/tx/graduate-finalize-round', async (req, reply) => {
    const b = obj(req.body);
    only(b, ['payer', 'cross', 'round'], 'graduate-finalize-round');
    const payer = addr(b.payer, 'payer');
    const crossAddr = addr(b.cross, 'cross');
    const release = await need('finalize_round', FINALIZE_ROUND_DISCRIMINATOR as Uint8Array);
    const t = await target(crossAddr, b.round);
    if (t.round.finalized) throw new RequestError(409, 'The round is already finalized.', { reason: 'NOT_VOTING' });
    if (now() < t.round.closesTs) throw new RequestError(409, `The voting window is open until ${t.round.closesTs}.`, { reason: 'WINDOW_OPEN', closesTs: t.round.closesTs, secondsLeft: t.round.closesTs - now() });
    const supply = await mintSupply(d.account, t.round.baseMint);
    const facts = supply === null ? null : { lockedTotal: t.round.lockedTotal, supply, quorumBps: t.round.quorumBps, tallies: t.round.tallies, minVolume: t.round.minVolume, volume: volumeOf(t.round) };
    const winner = facts ? decideRound(facts) : null;
    const ix = await building(() => buildFinalizeRound({ cross: crossAddr, round: t.address, baseMint: t.round.baseMint }));
    return send(reply, {
      ...(await tx(payer, [ix], 'finalize')),
      round: t.address,
      willPass: facts ? winner !== null : null,
      winner: winner === null ? null : GRADUATE_VENUES[winner],
      ...(facts && winner === null && { shortfall: roundShortfall(facts) }),
      release,
    });
  });

  app.post('/v1/tx/graduate-publish-outcome', async (req, reply) => {
    const b = obj(req.body);
    only(b, ['payer', 'cross', 'round'], 'graduate-publish-outcome');
    const payer = addr(b.payer, 'payer');
    const crossAddr = addr(b.cross, 'cross');
    const release = await need('publish_outcome', PUBLISH_OUTCOME_DISCRIMINATOR as Uint8Array);
    const t = await target(crossAddr, b.round);
    if (!t.round.finalized || !t.round.passed) throw new RequestError(409, t.round.finalized ? 'The round did not pass, so there is no outcome to publish.' : 'The round is not finalized yet.', { reason: 'NOT_PASSED', finalized: t.round.finalized });
    const out = await outcomeAddress(crossAddr);
    if (await d.account(out)) throw new RequestError(409, 'The outcome is already published.', { reason: 'ALREADY_PUBLISHED', outcome: out });
    const built = await building(() => buildPublishOutcome({ payer: createNoopSigner(payer), cross: crossAddr, round: t.address }));
    return send(reply, { ...(await tx(payer, [built.instruction], 'outcome')), outcome: built.outcome, venue: GRADUATE_VENUES[t.round.winner], venueNumber: t.round.winner, release });
  });

  app.post('/v1/tx/graduate-withdraw-vote', async (req, reply) => {
    const b = obj(req.body);
    only(b, ['voter', 'cross', 'round'], 'graduate-withdraw-vote');
    const voter = addr(b.voter, 'voter');
    const release = await need('withdraw_vote', WITHDRAW_VOTE_DISCRIMINATOR as Uint8Array);
    const t = await target(addr(b.cross, 'cross'), b.round);
    if (now() < t.round.closesTs) throw new RequestError(409, `The tokens stay locked until the window closes at ${t.round.closesTs}.`, { reason: 'WINDOW_OPEN', closesTs: t.round.closesTs, secondsLeft: t.round.closesTs - now() });
    const v = await d.account(await voteAddress(t.address, voter));
    if (!v || !(VOTE_RECORD_DISCRIMINATOR as Uint8Array).every((x, i) => v.data[i] === x)) throw new RequestError(404, `${voter} has no locked vote in this round (it may have been withdrawn).`, { reason: 'NO_VOTE' });
    const record = getVoteRecordDecoder().decode(v.data);
    const ix = await building(() => buildWithdrawVote({ voter: createNoopSigner(voter), round: t.address, baseMint: t.round.baseMint, baseTokenProgram: t.round.baseTokenProgram }));
    return send(reply, { ...(await tx(voter, [ix], 'vote withdrawal')), round: t.address, amount: record.amount, release });
  });

  // ---------------------------------------------------------------- reads
  app.get('/v1/crosses/:address/graduation', async (req, reply) => {
    const crossAddr = addr((req.params as { address: string }).address, 'address');
    const release = await releaseNote(gate, 'crossGraduate');
    const cross = await readCross(d.account, crossAddr);
    const governed = isGoverned(cross.ext);
    const outcome = await outcomeAddress(crossAddr);
    const base = { cross: crossAddr, governed, release, outcomeAccount: outcome, venues: GRADUATE_VENUES };
    if (!governed) return send(reply, { ...base, applies: false, note: 'This cross did not set the governed-graduation rule, so it is seeded without a vote.' });
    if (release.deployed === false) return send(reply, { ...base, applies: true, charter: null, rounds: [], outcome: null, seeding: { requiresOutcome: true, ready: false }, note: `This cross is governed, but ${release.note} Until cross_graduate is on the cluster no vote can run and no pool can open.` });
    const charterAcct = await readCharter(crossAddr).catch((e) => (e instanceof RequestError && e.detail?.reason === 'NO_CHARTER' ? null : Promise.reject(e)));
    if (!charterAcct) return send(reply, { ...base, applies: true, charter: null, rounds: [], outcome: null, seeding: { requiresOutcome: true, ready: false }, note: cross.data.ordersTotal === 0 && cross.data.state === CrossState.Live ? 'The creator has not set a charter yet; it must be set before the first order.' : 'This cross is governed but has no charter, so no vote can run and no pool can open.' });
    const t = now();
    const supply = await mintSupply(d.account, cross.data.baseMint).catch(() => null);
    const rounds = [];
    for (let i = 0; i < charterAcct.rounds; i++) {
      const address = await roundAddress(crossAddr, i);
      const r = await readRoundAt(address).catch(() => null);
      if (!r) continue;
      const facts = supply === null ? null : { lockedTotal: r.lockedTotal, supply, quorumBps: r.quorumBps, tallies: r.tallies, minVolume: r.minVolume, volume: volumeOf(r) };
      const winnerNow = facts ? decideRound(facts) : null;
      rounds.push({
        round: address,
        index: i,
        opensTs: r.opensTs,
        closesTs: r.closesTs,
        status: r.finalized ? (r.passed ? 'passed' : 'failed') : t >= r.closesTs ? 'awaiting-finalize' : 'voting',
        quorumBps: r.quorumBps,
        lockedTotal: r.lockedTotal,
        quorumNeeded: supply === null ? null : (supply * BigInt(r.quorumBps) + 9_999n) / 10_000n,
        tallies: tallyJson(r.tallies),
        volume: { required: r.minVolume, posted: volumeOf(r), attester: r.volumeAttester.__option === 'Some' ? r.volumeAttester.value : null },
        winner: r.finalized ? (r.passed ? GRADUATE_VENUES[r.winner] : null) : winnerNow === null ? null : GRADUATE_VENUES[winnerNow],
        wouldPassNow: r.finalized ? r.passed : facts ? winnerNow !== null : null,
        ...(!r.finalized && facts && winnerNow === null && { shortfall: roundShortfall(facts) }),
      });
    }
    const outRaw = await d.account(outcome);
    const out = outRaw && outRaw.owner === CROSS_GRADUATE_PROGRAM_ADDRESS && (OUTCOME_DISCRIMINATOR as Uint8Array).every((x, i) => outRaw.data[i] === x) ? getOutcomeDecoder().decode(outRaw.data) : null;
    return send(reply, {
      ...base,
      applies: true,
      charter: { address: await charterAddress(crossAddr), creator: charterAcct.creator, quorumBps: charterAcct.quorumBps, windowSecs: charterAcct.windowSecs, minVolume: charterAcct.minVolume, volumeAttester: charterAcct.volumeAttester.__option === 'Some' ? charterAcct.volumeAttester.value : null, roundsUsed: charterAcct.rounds, roundsLeft: GRADUATE_MAX_ROUNDS - charterAcct.rounds, active: charterAcct.active, passed: charterAcct.passed },
      supply,
      rounds,
      outcome: out ? { account: outcome, venue: GRADUATE_VENUES[out.venue], venueNumber: out.venue, round: out.round, publishedTs: out.publishedTs } : null,
      seeding: {
        requiresOutcome: true,
        ready: out !== null,
        outcome,
        instruction: out ? { damm_v2: 'seed-damm-v2', dlmm: 'open-dlmm-pair', raydium_cpmm: 'seed-raydium-cpmm', metadao_futarchy: 'seed-futarchy-dao' }[GRADUATE_VENUES[out.venue]!] : null,
      },
      mintAuthority: supply === null ? null : 'check the token with GET /v1/tokens/:mint/safety before asking holders to vote: a mint authority can raise the supply and with it the quorum',
    });
  });

  app.get('/v1/graduation/rounds/:round', async (req, reply) => {
    const address = addr((req.params as { round: string }).round, 'round');
    const release = await releaseNote(gate, 'crossGraduate');
    if (release.deployed === false) throw new RequestError(404, `round ${address} not found: ${release.note}`, { reason: 'PROGRAM_NOT_DEPLOYED', release });
    const r = await readRoundAt(address);
    const who = (req.query as { voter?: string }).voter;
    let vote = null;
    if (who !== undefined) {
      const voter = addr(who, 'voter');
      const v = await d.account(await voteAddress(address, voter));
      const rec = v && (VOTE_RECORD_DISCRIMINATOR as Uint8Array).every((x, i) => v.data[i] === x) ? getVoteRecordDecoder().decode(v.data) : null;
      vote = rec ? { voter, venue: GRADUATE_VENUES[rec.venue], venueNumber: rec.venue, locked: rec.amount, unlocksAt: r.closesTs, canWithdraw: now() >= r.closesTs } : { voter, locked: 0n };
    }
    return send(reply, { round: address, cross: r.cross, index: r.index, baseMint: r.baseMint, opensTs: r.opensTs, closesTs: r.closesTs, finalized: r.finalized, passed: r.passed, winner: r.finalized && r.passed ? GRADUATE_VENUES[r.winner] : null, lockedTotal: r.lockedTotal, tallies: tallyJson(r.tallies), ...(vote && { vote }), release });
  });
}
