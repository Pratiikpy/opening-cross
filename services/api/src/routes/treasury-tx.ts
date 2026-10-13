// The treasury extension over HTTP (programs/treasury, ADR-0470 to ADR-0476): an unsigned transaction for every instruction, and the reads
// that show holders and the team where a treasury stands.
//
// The API never holds a key. Every transaction comes back unsigned with the named wallet as fee payer; every check the program would make
// that can be made from chain state is made first, so the caller reads a reason before signing instead of a program error after.
//
// The extension's instructions need the extended program, which is NOT deployed on devnet yet (docs/HUMAN_TASKS.md H27). Until then, a
// transaction for one of them is built correctly but the deployed program refuses it. `spend`, `redeem`, `trigger-liquidation`,
// `record-attested` and `record-lapse` exist in the deployed program.
//
// Transactions: POST /v1/treasuries/:address/tx/<action>, body below, answer { transaction, signers, ...facts }.
//   init-ext              { authority, params | preset: "flagship" + flagship inputs }   extend once: votes, NAV window, distributions, revenue rounds, disclosure, assignment, wind-down
//   propose               { proposer, kind: "spend"|"open-nav"|"close-nav", amount?, destination?, descHash? }   the proposal id is the treasury's next one
//   vote                  { voter, id, support, amount }                     locks `amount` coins until the vote is over
//   reclaim-vote          { voter, id }
//   execute-proposal      { executor, id }                                   destination is the one fixed when the proposal was made
//   nav-redeem            { holder, amount }                                 burn coins for their share of the vault while a NAV window is open
//   stake | unstake       { owner, amount }
//   deposit-distribution  { depositor, amount }                              anyone may add quote tokens for the stakers
//   claim-distribution    { owner }
//   pay-round             { payer, round, attestation? }                     the attestation defaults to the one the treasury's revenue credential and schema derive
//   mark-missed           { caller, round }
//   release-tranche       { authority, round, destination }
//   create-grant          { authority, beneficiary, total, lockupEnd, expiryTs, milestones: [{ bps, requiresAttestation }], credential, schema }   the grant id is the treasury's next one
//   release-milestone     { cranker, grant, index, beneficiary, attestation? }
//   expire-grant          { cranker, grant }
//   post-disclosure       { authority, hash }
//   request-disclosure    { holder }
//   record-assignment     { payer, attestation? }
//   sweep-unclaimed       { payer }                                          pays the recovery account fixed at extension
//   spend                 { authority, amount, destination, attestation? }   allowance spend (deployed)
//   record-attested | record-lapse | trigger-liquidation   { payer }          (deployed)
//   redeem                { holder, amount }                                 liquidation redemption (deployed)
// Reads:
//   GET /v1/treasuries/:address/ext                  the extension's terms and state, decoded, with what each term allows
//   GET /v1/treasuries/:address/proposals            every proposal with its tally and status
//   GET /v1/treasuries/:address/proposals/:id        one proposal, and `?voter=` the voter's record
//   GET /v1/treasuries/:address/positions/:owner     a staker's position and what they can claim now
//   GET /v1/treasuries/:address/grants               every team grant with what has vested and what is earned
//   GET /v1/treasuries/:address/rounds               every revenue round: its due time, the attested revenue, whether it was paid or missed
//   GET /v1/treasuries/:address/events?name=&limit=  the indexed events of the treasury (votes, distributions, grants, disclosures...)
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { type Address, createNoopSigner, isAddress } from '@solana/kit';
import { getMintDecoder, getTokenDecoder, TOKEN_2022_PROGRAM_ADDRESS } from '@solana-program/token-2022';
import {
  ProposalKind,
  TREASURY_DISCRIMINATOR,
  TREASURY_PROGRAM_ADDRESS,
  TreasuryState,
  type Treasury,
  type TreasuryContext,
  type TreasuryExt,
  associatedTokenAddress,
  assignmentAttestationAddress,
  buildClaimDistribution,
  buildCreateGrant,
  buildDepositDistribution,
  buildExecuteProposal,
  buildExpireGrant,
  buildInitExt,
  buildMarkMissed,
  buildNavRedeem,
  buildPayRound,
  buildPostDisclosure,
  buildPropose,
  buildReclaimVote,
  buildRecordAssignment,
  buildRecordAttested,
  buildRecordLapse,
  buildRedeem,
  buildReleaseMilestone,
  buildReleaseTranche,
  buildRequestDisclosure,
  buildSpend,
  buildStake,
  buildSweepUnclaimed,
  buildTriggerLiquidation,
  buildUnstake,
  buildVote,
  checkExtParams,
  claimableOf,
  decodeTreasuryExt,
  flagshipExtParams,
  getGrantDecoder,
  getPositionDecoder,
  getProposalDecoder,
  getRoundRecordDecoder,
  getTreasuryDecoder,
  getVoteRecordDecoder,
  grantAddress,
  milestoneAttestationAddress,
  navPayout,
  positionAddress,
  proposalAddress,
  proposalCap,
  proposalPasses,
  revenueAttestationAddress,
  roundRecordAddress,
  spendAttestationAddress,
  voteRecordAddress,
  findVaultPda,
  findCoinVaultPda,
  findDistVaultPda,
} from '@opening-cross/treasury-client';
import { type Lifetime, RequestError, compile } from '../tx.js';
import { addr, bool, hex32, i64, int, json, list, obj, only, opt, u64 } from './_inputs.js';

type ChainAccount = { data: Uint8Array; owner: Address };

export type TreasuryTxDeps = {
  db: pg.Pool;
  account: (a: Address) => Promise<ChainAccount | null>;
  lifetime: () => Promise<Lifetime>;
  /** Unix seconds; defaults to the wall clock. Tests inject one. */
  clock?: () => number;
};

const send = (reply: FastifyReply, v: unknown, status = 200) => reply.code(status).type('application/json').send(json(v));
const startsWith = (data: Uint8Array, prefix: ArrayLike<number>) => data.length >= prefix.length && Array.from(prefix).every((b, i) => data[i] === b);
const KIND_NAMES = ['spend', 'open-nav', 'close-nav'] as const;
const KIND_OF = { spend: ProposalKind.Spend, 'open-nav': ProposalKind.OpenNav, 'close-nav': ProposalKind.CloseNav } as const;
const PROPOSAL_STATUS = ['voting', 'failed', 'timelock', 'executable', 'expired', 'executed'] as const;
const EXEC_WINDOW_SECS = 14n * 86_400n;
/** Proposals, grants and rounds listed per request: the account is read for each, so this is bounded. */
const LIST_MAX = 100;
const ZERO = '11111111111111111111111111111111' as Address;

type Facts = {
  c: TreasuryContext;
  treasury: Treasury;
  ext: TreasuryExt | null;
  coinSupply: bigint;
  now: bigint;
};

export function registerTreasuryTx(app: FastifyInstance, d: TreasuryTxDeps): void {
  const now = () => BigInt(d.clock?.() ?? Math.floor(Date.now() / 1000));

  async function facts(a: Address): Promise<Facts> {
    const acct = await d.account(a);
    if (!acct || acct.owner !== TREASURY_PROGRAM_ADDRESS || !startsWith(acct.data, TREASURY_DISCRIMINATOR)) throw new RequestError(404, `no treasury of this program at ${a}`);
    const treasury = getTreasuryDecoder().decode(acct.data);
    const [coin, quote] = await Promise.all([d.account(treasury.coinMint), d.account(treasury.quoteMint)]);
    if (!coin || !quote) throw new RequestError(404, 'the treasury\'s coin or quote mint is not on this cluster');
    return {
      c: { treasury: a, coinMint: treasury.coinMint, quoteMint: treasury.quoteMint, coinTokenProgram: coin.owner, quoteTokenProgram: quote.owner },
      treasury,
      ext: decodeTreasuryExt(acct.data),
      coinSupply: getMintDecoder().decode(coin.data.subarray(0, 82)).supply,
      now: now(),
    };
  }
  const needExt = (f: Facts): TreasuryExt => {
    if (!f.ext) throw new RequestError(422, 'This treasury has not been extended: it has no votes, distributions, grants or revenue rounds. Its team sends init-ext first.', { reason: 'NOT_EXTENDED' });
    return f.ext;
  };
  const active = (f: Facts) => {
    if (f.treasury.state !== TreasuryState.Active) throw new RequestError(409, 'This treasury is liquidating: that action is closed. Holders can still redeem, unstake and reclaim their votes.', { reason: 'LIQUIDATING' });
  };
  const balanceOf = async (owner: Address, mint: Address, tokenProgram: Address): Promise<bigint> => {
    const acct = await d.account(await associatedTokenAddress(owner, mint, tokenProgram));
    return acct && acct.data.length >= 165 ? getTokenDecoder().decode(acct.data.subarray(0, 165)).amount : 0n;
  };
  const positionOf = async (f: Facts, owner: Address) => {
    const acct = await d.account(await positionAddress(f.c.treasury, owner));
    return acct ? getPositionDecoder().decode(acct.data) : null;
  };
  const proposalOf = async (f: Facts, id: bigint) => {
    const acct = await d.account(await proposalAddress(f.c.treasury, id));
    if (!acct) throw new RequestError(404, `treasury ${f.c.treasury} has no proposal ${id}`, { reason: 'NO_PROPOSAL' });
    return getProposalDecoder().decode(acct.data);
  };
  const circulating = (f: Facts, e: TreasuryExt) => (f.coinSupply > e.grantsUnreleased ? f.coinSupply - e.grantsUnreleased : 0n);
  const statusOf = (f: Facts, e: TreasuryExt, p: Awaited<ReturnType<typeof proposalOf>>): (typeof PROPOSAL_STATUS)[number] => {
    if (p.executed) return 'executed';
    if (f.now < p.voteEndTs) return 'voting';
    if (!proposalPasses(p.yes, p.no, circulating(f, e), e.quorumBps, e.thresholdBps)) return 'failed';
    if (f.now < p.executableTs) return 'timelock';
    return f.now > p.expiresTs ? 'expired' : 'executable';
  };

  /** Wraps a handler: reads the treasury, hands over the facts and the body, sends what comes back. */
  const route =
    (handler: (f: Facts, b: Record<string, unknown>) => Promise<{ payer: Address; instructions: Parameters<typeof compile>[1]; extra?: Record<string, unknown> }>) =>
    async (req: FastifyRequest, reply: FastifyReply) => {
      const f = await facts(addr((req.params as { address: string }).address, 'address'));
      const out = await handler(f, obj(req.body));
      return send(reply, { ...compile(out.payer, out.instructions, await d.lifetime()), ...out.extra });
    };
  const signer = (b: Record<string, unknown>, field: string) => {
    const a = addr(b[field], field);
    return { a, s: createNoopSigner(a) };
  };
  const amountOf = (b: Record<string, unknown>, field = 'amount') => {
    const v = u64(b[field], field);
    if (v === 0n) throw new RequestError(400, `${field} must be above zero`);
    return v;
  };

  // ---------------------------------------------------------------- extension
  app.post(
    '/v1/treasuries/:address/tx/init-ext',
    route(async (f, b) => {
      if (f.treasury.state !== TreasuryState.Active) throw new RequestError(409, 'A liquidating treasury cannot be extended.', { reason: 'LIQUIDATING' });
      if (f.ext) throw new RequestError(409, 'This treasury has been extended already; its terms are fixed.', { reason: 'ALREADY_EXTENDED' });
      const { a, s } = signer(b, 'authority');
      if (a !== f.treasury.authority) throw new RequestError(422, `Only the treasury's authority, ${f.treasury.authority}, can extend it.`, { reason: 'NOT_THE_AUTHORITY', authority: f.treasury.authority });
      const params = b.preset === 'flagship' ? parseFlagship(b) : parseExtParams(obj(b.params, 'params'));
      const issues = checkExtParams(params, f.now);
      const refused = issues.filter((i) => i.severity === 'refused');
      if (refused.length > 0) throw new RequestError(422, `The program would refuse these terms: ${refused.map((i) => `${i.field}: ${i.message}`).join(' ')}`, { reason: 'TERMS_INVALID', issues });
      return { payer: a, instructions: [await buildInitExt(f.c, s, params)], extra: { issues } };
    }),
  );

  // ---------------------------------------------------------------- holder votes
  app.post(
    '/v1/treasuries/:address/tx/propose',
    route(async (f, b) => {
      const e = needExt(f);
      active(f);
      if (e.votePeriodSecs === 0n) throw new RequestError(422, 'This treasury does not use holder votes.', { reason: 'DISABLED' });
      const { a, s } = signer(b, 'proposer');
      const kindName = String(b.kind);
      if (!(KIND_NAMES as readonly string[]).includes(kindName)) throw new RequestError(400, `kind must be one of ${KIND_NAMES.join(', ')}`);
      const kind = KIND_OF[kindName as keyof typeof KIND_OF];
      const amount = kind === ProposalKind.Spend ? amountOf(b) : 0n;
      if (kind !== ProposalKind.Spend && (b.amount !== undefined && String(b.amount) !== '0')) throw new RequestError(400, 'a NAV proposal carries no amount');
      const destination = kind === ProposalKind.Spend ? addr(b.destination, 'destination') : ZERO;
      if (kind !== ProposalKind.Spend && b.destination !== undefined && b.destination !== null) throw new RequestError(400, 'a NAV proposal carries no destination');
      if (kind !== ProposalKind.Spend && e.navPeriodSecs === 0n) throw new RequestError(422, 'This treasury has no NAV window.', { reason: 'DISABLED' });
      if (kind === ProposalKind.Spend) {
        const vault = await d.account((await findVaultPda({ treasury: f.c.treasury }))[0]);
        const held = vault && vault.data.length >= 165 ? getTokenDecoder().decode(vault.data.subarray(0, 165)).amount : 0n;
        if (amount > proposalCap(held, e.maxProposalBps)) throw new RequestError(422, `A proposal may spend at most ${proposalCap(held, e.maxProposalBps)} (${e.maxProposalBps / 100}% of the ${held} in the vault).`, { reason: 'OVER_PROPOSAL_CAP', cap: proposalCap(held, e.maxProposalBps) });
      }
      if (a !== f.treasury.authority) {
        const held = await balanceOf(a, f.c.coinMint, f.c.coinTokenProgram);
        const min = (f.coinSupply * BigInt(e.proposerMinBps)) / 10_000n;
        if (held === 0n || held < min) throw new RequestError(422, `A proposal needs a holding of at least ${min} coins (${e.proposerMinBps / 100}% of the supply); this wallet holds ${held}.`, { reason: 'NOT_A_HOLDER', held, needed: min });
      }
      const descHash = b.descHash === undefined || b.descHash === null ? new Uint8Array(32) : hex32(b.descHash, 'descHash');
      const id = e.proposalCount;
      return { payer: a, instructions: [await buildPropose(f.c, s, { id, kind, amount, destination, descHash })], extra: { id, proposal: await proposalAddress(f.c.treasury, id), voteEndsAt: f.now + e.votePeriodSecs } };
    }),
  );

  app.post(
    '/v1/treasuries/:address/tx/vote',
    route(async (f, b) => {
      const e = needExt(f);
      const { a, s } = signer(b, 'voter');
      const id = u64(b.id, 'id');
      const p = await proposalOf(f, id);
      if (f.now >= p.voteEndTs) throw new RequestError(409, `Voting on proposal ${id} ended at ${p.voteEndTs}.`, { reason: 'VOTING_CLOSED' });
      const amount = amountOf(b);
      const held = await balanceOf(a, f.c.coinMint, f.c.coinTokenProgram);
      if (held < amount) throw new RequestError(422, `This wallet holds ${held} coins; it cannot vote ${amount}.`, { reason: 'INSUFFICIENT_COINS', held });
      void e;
      return { payer: a, instructions: [await buildVote(f.c, s, id, bool(b.support, 'support'), amount)], extra: { proposal: await proposalAddress(f.c.treasury, id), voteEndsAt: p.voteEndTs } };
    }),
  );

  app.post(
    '/v1/treasuries/:address/tx/reclaim-vote',
    route(async (f, b) => {
      needExt(f);
      const { a, s } = signer(b, 'voter');
      const id = u64(b.id, 'id');
      const p = await proposalOf(f, id);
      if (f.now < p.voteEndTs) throw new RequestError(409, `Votes on proposal ${id} are locked until ${p.voteEndTs}.`, { reason: 'VOTING_OPEN', voteEndsAt: p.voteEndTs });
      const rec = await d.account(await voteRecordAddress(f.c.treasury, id, a));
      if (!rec) throw new RequestError(404, 'This wallet has no vote locked on that proposal (it never voted, or it has reclaimed already).', { reason: 'NO_VOTE' });
      return { payer: a, instructions: [await buildReclaimVote(f.c, s, id)] };
    }),
  );

  app.post(
    '/v1/treasuries/:address/tx/execute-proposal',
    route(async (f, b) => {
      const e = needExt(f);
      const { a, s } = signer(b, 'executor');
      const id = u64(b.id, 'id');
      const p = await proposalOf(f, id);
      const status = statusOf(f, e, p);
      if (status !== 'executable') throw new RequestError(409, `Proposal ${id} is ${status}, not executable.`, { reason: 'NOT_EXECUTABLE', status, executableAt: p.executableTs, expiresAt: p.expiresTs });
      return { payer: a, instructions: [await buildExecuteProposal(f.c, s, id, p.destination)], extra: { kind: KIND_NAMES[p.kind], amount: p.amount, destination: p.destination } };
    }),
  );

  app.post(
    '/v1/treasuries/:address/tx/nav-redeem',
    route(async (f, b) => {
      const e = needExt(f);
      const { a, s } = signer(b, 'holder');
      if (!e.navOpen) throw new RequestError(409, 'No NAV window is open. Holders vote one open, or a missed revenue round opens it.', { reason: 'NAV_CLOSED' });
      if (a === f.treasury.authority || e.insiders.includes(a)) throw new RequestError(422, 'The team and the insiders named at extension cannot redeem at NAV.', { reason: 'INSIDER_EXCLUDED' });
      const amount = amountOf(b);
      const held = await balanceOf(a, f.c.coinMint, f.c.coinTokenProgram);
      if (held < amount) throw new RequestError(422, `This wallet holds ${held} coins; it cannot redeem ${amount}.`, { reason: 'INSUFFICIENT_COINS', held });
      const vault = await d.account((await findVaultPda({ treasury: f.c.treasury }))[0]);
      const held$ = vault && vault.data.length >= 165 ? getTokenDecoder().decode(vault.data.subarray(0, 165)).amount : 0n;
      return { payer: a, instructions: await buildNavRedeem(f.c, s, amount), extra: { payout: navPayout(held$, amount, f.coinSupply), vault: held$, supply: f.coinSupply } };
    }),
  );

  // ---------------------------------------------------------------- distributions
  app.post(
    '/v1/treasuries/:address/tx/stake',
    route(async (f, b) => {
      needExt(f);
      active(f);
      const { a, s } = signer(b, 'owner');
      const amount = amountOf(b);
      const held = await balanceOf(a, f.c.coinMint, f.c.coinTokenProgram);
      if (held < amount) throw new RequestError(422, `This wallet holds ${held} coins; it cannot stake ${amount}.`, { reason: 'INSUFFICIENT_COINS', held });
      return { payer: a, instructions: [await buildStake(f.c, s, amount)] };
    }),
  );
  app.post(
    '/v1/treasuries/:address/tx/unstake',
    route(async (f, b) => {
      needExt(f);
      const { a, s } = signer(b, 'owner');
      const amount = amountOf(b);
      const pos = await positionOf(f, a);
      if (!pos || pos.amount < amount) throw new RequestError(422, `This wallet has ${pos?.amount ?? 0n} coins staked; it cannot unstake ${amount}.`, { reason: 'INSUFFICIENT_STAKE', staked: pos?.amount ?? 0n });
      return { payer: a, instructions: [await buildUnstake(f.c, s, amount)] };
    }),
  );
  app.post(
    '/v1/treasuries/:address/tx/deposit-distribution',
    route(async (f, b) => {
      needExt(f);
      active(f);
      const { a, s } = signer(b, 'depositor');
      const amount = amountOf(b);
      const held = await balanceOf(a, f.c.quoteMint, f.c.quoteTokenProgram);
      if (held < amount) throw new RequestError(422, `This wallet holds ${held} of the quote token; it cannot deposit ${amount}.`, { reason: 'INSUFFICIENT_QUOTE', held });
      return { payer: a, instructions: [await buildDepositDistribution(f.c, s, amount)] };
    }),
  );
  app.post(
    '/v1/treasuries/:address/tx/claim-distribution',
    route(async (f, b) => {
      const e = needExt(f);
      const { a, s } = signer(b, 'owner');
      const pos = await positionOf(f, a);
      if (!pos) throw new RequestError(404, 'This wallet has never staked in this treasury.', { reason: 'NO_POSITION' });
      const claimable = claimableOf(pos, e, f.now);
      if (claimable === 0n) throw new RequestError(409, 'Nothing to claim yet.', { reason: 'NOTHING_TO_CLAIM' });
      return { payer: a, instructions: await buildClaimDistribution(f.c, s), extra: { claimable } };
    }),
  );

  // ---------------------------------------------------------------- revenue rounds
  app.post(
    '/v1/treasuries/:address/tx/pay-round',
    route(async (f, b) => {
      const e = needExt(f);
      active(f);
      if (e.revShareBps === 0) throw new RequestError(422, 'This treasury has no revenue rounds.', { reason: 'DISABLED' });
      const { a, s } = signer(b, 'payer');
      const round = u64(b.round, 'round');
      const attestation = opt(b.attestation, (v) => addr(v, 'attestation')) ?? (await revenueAttestationAddress({ treasury: f.c.treasury, revCredential: e.revCredential, revSchema: e.revSchema }, round));
      const att = await d.account(attestation);
      if (!att) throw new RequestError(422, `Round ${round} has no revenue attestation yet (${attestation}). The attester signs one when the round is over.`, { reason: 'NOT_ATTESTED', attestation });
      return { payer: a, instructions: [await buildPayRound(f.c, s, round, attestation)], extra: { attestation } };
    }),
  );
  app.post(
    '/v1/treasuries/:address/tx/mark-missed',
    route(async (f, b) => {
      const e = needExt(f);
      const { a, s } = signer(b, 'caller');
      if (e.revShareBps === 0) throw new RequestError(422, 'This treasury has no revenue rounds.', { reason: 'DISABLED' });
      const round = u64(b.round, 'round');
      const dueAt = e.revStart + (round + 1n) * e.roundSecs + e.payGraceSecs;
      if (f.now <= dueAt) throw new RequestError(409, `Round ${round} can be marked missed after ${dueAt}.`, { reason: 'ROUND_NOT_LATE', dueAt });
      return { payer: a, instructions: [await buildMarkMissed(f.c, s, round)] };
    }),
  );
  app.post(
    '/v1/treasuries/:address/tx/release-tranche',
    route(async (f, b) => {
      needExt(f);
      active(f);
      const { a, s } = signer(b, 'authority');
      if (a !== f.treasury.authority) throw new RequestError(422, `Only the treasury's authority, ${f.treasury.authority}, can release a tranche.`, { reason: 'NOT_THE_AUTHORITY' });
      return { payer: a, instructions: [await buildReleaseTranche(f.c, s, u64(b.round, 'round'), addr(b.destination, 'destination'))] };
    }),
  );

  // ---------------------------------------------------------------- team grants
  app.post(
    '/v1/treasuries/:address/tx/create-grant',
    route(async (f, b) => {
      const e = needExt(f);
      active(f);
      const { a, s } = signer(b, 'authority');
      if (a !== f.treasury.authority) throw new RequestError(422, `Only the treasury's authority, ${f.treasury.authority}, can create a grant.`, { reason: 'NOT_THE_AUTHORITY' });
      const lockupEnd = i64(b.lockupEnd, 'lockupEnd');
      const expiryTs = i64(b.expiryTs, 'expiryTs');
      if (lockupEnd < f.now + e.minLockupSecs) throw new RequestError(422, `A grant locks for at least ${e.minLockupSecs} seconds: its lockup ends no earlier than ${f.now + e.minLockupSecs}.`, { reason: 'LOCKUP_TOO_SHORT', earliest: f.now + e.minLockupSecs });
      if (expiryTs <= lockupEnd) throw new RequestError(422, 'A grant expires after its lockup ends.', { reason: 'EXPIRY_BEFORE_LOCKUP' });
      const milestones = list(b.milestones, 'milestones', 4, (m, i) => {
        const r = obj(m, `milestones[${i}]`);
        return { bps: int(r.bps, `milestones[${i}].bps`, 10_000, 1), requiresAttestation: bool(r.requiresAttestation ?? false, `milestones[${i}].requiresAttestation`) };
      });
      if (milestones.length === 0) throw new RequestError(400, 'a grant has at least one milestone');
      if (milestones.reduce((n, m) => n + m.bps, 0) > 10_000) throw new RequestError(422, 'The milestones add up to at most 100% of the grant.', { reason: 'MILESTONES_OVER_100' });
      const total = amountOf(b, 'total');
      const held = await balanceOf(a, f.c.coinMint, f.c.coinTokenProgram);
      if (held < total) throw new RequestError(422, `The authority holds ${held} coins; it cannot escrow ${total} in a grant.`, { reason: 'INSUFFICIENT_COINS', held });
      const id = e.grantCount;
      const grant = await grantAddress(f.c.treasury, id);
      return {
        payer: a,
        instructions: [await buildCreateGrant(f.c, s, { id, beneficiary: addr(b.beneficiary, 'beneficiary'), total, lockupEnd, expiryTs, milestones, credential: addr(b.credential, 'credential'), schema: addr(b.schema, 'schema') })],
        extra: { id, grant },
      };
    }),
  );
  app.post(
    '/v1/treasuries/:address/tx/release-milestone',
    route(async (f, b) => {
      needExt(f);
      const { a, s } = signer(b, 'cranker');
      const grantAddr = addr(b.grant, 'grant');
      const acct = await d.account(grantAddr);
      if (!acct || acct.owner !== TREASURY_PROGRAM_ADDRESS) throw new RequestError(404, `no grant at ${grantAddr}`, { reason: 'NO_GRANT' });
      const g = getGrantDecoder().decode(acct.data);
      const index = int(b.index, 'index', 3);
      const m = g.milestones[index];
      if (!m || index >= g.milestoneCount) throw new RequestError(422, `The grant has ${g.milestoneCount} milestones.`, { reason: 'NO_MILESTONE' });
      if (m.released) throw new RequestError(409, 'That milestone has been released.', { reason: 'ALREADY_RELEASED' });
      if (f.now < g.lockupEnd) throw new RequestError(409, `The grant is locked until ${g.lockupEnd}.`, { reason: 'LOCKED', lockupEnd: g.lockupEnd });
      const attestation = m.requiresAttestation ? (opt(b.attestation, (v) => addr(v, 'attestation')) ?? (await milestoneAttestationAddress({ grant: grantAddr, credential: g.credential, schema: g.schema }, index))) : undefined;
      if (attestation && !(await d.account(attestation))) throw new RequestError(422, `Milestone ${index} needs its attestation (${attestation}); the attester has not signed it.`, { reason: 'NOT_ATTESTED', attestation });
      return { payer: a, instructions: await buildReleaseMilestone(f.c, s, g.id, index, g.beneficiary, attestation) };
    }),
  );
  app.post(
    '/v1/treasuries/:address/tx/expire-grant',
    route(async (f, b) => {
      needExt(f);
      const { a, s } = signer(b, 'cranker');
      const grantAddr = addr(b.grant, 'grant');
      const acct = await d.account(grantAddr);
      if (!acct || acct.owner !== TREASURY_PROGRAM_ADDRESS) throw new RequestError(404, `no grant at ${grantAddr}`, { reason: 'NO_GRANT' });
      const g = getGrantDecoder().decode(acct.data);
      if (g.burned) throw new RequestError(409, 'That grant has expired already.', { reason: 'ALREADY_EXPIRED' });
      if (f.now < g.expiryTs && f.treasury.state === TreasuryState.Active) throw new RequestError(409, `The grant expires at ${g.expiryTs}.`, { reason: 'NOT_EXPIRED', expiryTs: g.expiryTs });
      return { payer: a, instructions: [await buildExpireGrant(f.c, s, g.id)] };
    }),
  );

  // ---------------------------------------------------------------- disclosure, assignment, wind-down
  app.post(
    '/v1/treasuries/:address/tx/post-disclosure',
    route(async (f, b) => {
      const e = needExt(f);
      const { a, s } = signer(b, 'authority');
      if (e.disclosurePeriodSecs === 0n) throw new RequestError(422, 'This treasury has no disclosure feed.', { reason: 'DISABLED' });
      if (a !== f.treasury.authority) throw new RequestError(422, `Only the treasury's authority, ${f.treasury.authority}, can post a disclosure.`, { reason: 'NOT_THE_AUTHORITY' });
      return { payer: a, instructions: [buildPostDisclosure(f.c, s, hex32(b.hash, 'hash'))] };
    }),
  );
  app.post(
    '/v1/treasuries/:address/tx/request-disclosure',
    route(async (f, b) => {
      const e = needExt(f);
      const { a, s } = signer(b, 'holder');
      if (e.disclosurePeriodSecs === 0n) throw new RequestError(422, 'This treasury has no disclosure feed.', { reason: 'DISABLED' });
      const held = await balanceOf(a, f.c.coinMint, f.c.coinTokenProgram);
      const min = (f.coinSupply * BigInt(e.requestMinBps)) / 10_000n;
      if (held === 0n || held < min) throw new RequestError(422, `A request needs a holding of at least ${min} coins (${e.requestMinBps / 100}% of the supply); this wallet holds ${held}.`, { reason: 'NOT_A_HOLDER', held, needed: min });
      return { payer: a, instructions: [await buildRequestDisclosure(f.c, s)], extra: { deadlineIfOpened: f.now + e.disclosurePeriodSecs, alreadyOpen: e.openRequestTs > 0n } };
    }),
  );
  app.post(
    '/v1/treasuries/:address/tx/record-assignment',
    route(async (f, b) => {
      const e = needExt(f);
      if (!e.assignRequired) throw new RequestError(422, 'This treasury does not require an assignment.', { reason: 'DISABLED' });
      if (e.assigned) throw new RequestError(409, 'The assignment is recorded already.', { reason: 'ALREADY_ASSIGNED' });
      const payer = addr(b.payer, 'payer');
      const attestation = opt(b.attestation, (v) => addr(v, 'attestation')) ?? (await assignmentAttestationAddress({ treasury: f.c.treasury, assignCredential: e.assignCredential, assignSchema: e.assignSchema }));
      if (!(await d.account(attestation))) throw new RequestError(422, `Counsel has not issued the assignment attestation (${attestation}).`, { reason: 'NOT_ATTESTED', attestation });
      return { payer, instructions: [buildRecordAssignment(f.c, attestation)], extra: { attestation } };
    }),
  );
  app.post(
    '/v1/treasuries/:address/tx/sweep-unclaimed',
    route(async (f, b) => {
      const e = needExt(f);
      if (e.windowSecs === 0n) throw new RequestError(422, 'This treasury has no wind-down window.', { reason: 'DISABLED' });
      if (f.treasury.state !== TreasuryState.Liquidating) throw new RequestError(409, 'The sweep follows a liquidation.', { reason: 'NOT_LIQUIDATING' });
      if (e.swept) throw new RequestError(409, 'The unclaimed funds were swept already.', { reason: 'ALREADY_SWEPT' });
      const opens = e.windStart + e.windowSecs;
      if (f.now < opens) throw new RequestError(409, `Holders can redeem until ${opens}; the sweep opens then.`, { reason: 'WINDOW_OPEN', opensAt: opens });
      const payer = addr(b.payer, 'payer');
      return { payer, instructions: [await buildSweepUnclaimed(f.c, await associatedTokenAddress(e.recovery, f.c.quoteMint, f.c.quoteTokenProgram))], extra: { recovery: e.recovery } };
    }),
  );

  // ---------------------------------------------------------------- the first release's instructions
  app.post(
    '/v1/treasuries/:address/tx/spend',
    route(async (f, b) => {
      const { a, s } = signer(b, 'authority');
      if (a !== f.treasury.authority) throw new RequestError(422, `Only the treasury's authority, ${f.treasury.authority}, can spend.`, { reason: 'NOT_THE_AUTHORITY' });
      const attestation = opt(b.attestation, (v) => addr(v, 'attestation')) ?? (await spendAttestationAddress({ treasury: f.c.treasury, credential: f.treasury.credential, schema: f.treasury.schema }));
      return { payer: a, instructions: [await buildSpend(f.c, s, amountOf(b), attestation, addr(b.destination, 'destination'))], extra: { attestation } };
    }),
  );
  const attestedRoute = (build: (c: TreasuryContext, attestation: Address) => ReturnType<typeof buildRecordAttested>) =>
    route(async (f, b) => {
      const payer = addr(b.payer, 'payer');
      const attestation = await spendAttestationAddress({ treasury: f.c.treasury, credential: f.treasury.credential, schema: f.treasury.schema });
      return { payer, instructions: [build(f.c, attestation)], extra: { attestation } };
    });
  app.post('/v1/treasuries/:address/tx/record-attested', attestedRoute(buildRecordAttested));
  app.post('/v1/treasuries/:address/tx/record-lapse', attestedRoute(buildRecordLapse));
  app.post(
    '/v1/treasuries/:address/tx/trigger-liquidation',
    route(async (f, b) => {
      const payer = addr(b.payer, 'payer');
      if (f.treasury.lapsedSince.__option !== 'Some') throw new RequestError(409, 'The attestation has not lapsed, so there is nothing to liquidate.', { reason: 'NOT_LAPSED' });
      const at = BigInt(f.treasury.lapsedSince.value) + BigInt(f.treasury.graceSecs);
      if (f.now < at) throw new RequestError(409, `The grace period ends at ${at}.`, { reason: 'GRACE_RUNNING', endsAt: at });
      return { payer, instructions: [await buildTriggerLiquidation(f.c)] };
    }),
  );
  app.post(
    '/v1/treasuries/:address/tx/redeem',
    route(async (f, b) => {
      const { a, s } = signer(b, 'holder');
      if (f.treasury.state !== TreasuryState.Liquidating) throw new RequestError(409, 'Redemption at the liquidation snapshot opens when the treasury liquidates.', { reason: 'NOT_LIQUIDATING' });
      // After the wind-down window the leftover was swept to the recovery account and the program refuses every redemption (WoundDown).
      if (f.ext?.swept) throw new RequestError(409, 'The wind-down window is over and the unclaimed funds were swept to the recovery account: redemption is closed.', { reason: 'WOUND_DOWN', recovery: f.ext.recovery });
      const amount = amountOf(b);
      const held = await balanceOf(a, f.c.coinMint, f.c.coinTokenProgram);
      if (held < amount) throw new RequestError(422, `This wallet holds ${held} coins; it cannot redeem ${amount}.`, { reason: 'INSUFFICIENT_COINS', held });
      return { payer: a, instructions: await buildRedeem(f.c, s, amount), extra: { payout: navPayout(f.treasury.snapshotVault, amount, f.treasury.snapshotSupply) } };
    }),
  );

  // ---------------------------------------------------------------- reads
  app.get('/v1/treasuries/:address/ext', async (req, reply) => {
    const f = await facts(addr((req.params as { address: string }).address, 'address'));
    const e = f.ext;
    if (!e) return send(reply, { treasury: f.c.treasury, extended: false, note: 'This treasury was created by the first release and has not been extended: allowance spending, lapse and liquidation only.' });
    const vault = await d.account((await findVaultPda({ treasury: f.c.treasury }))[0]);
    const [coinVault, distVault] = await Promise.all([findCoinVaultPda({ treasury: f.c.treasury }), findDistVaultPda({ treasury: f.c.treasury })]);
    const read = async (a: Address) => {
      const acct = await d.account(a);
      return acct && acct.data.length >= 165 ? getTokenDecoder().decode(acct.data.subarray(0, 165)).amount : null;
    };
    const vaultBalance = vault && vault.data.length >= 165 ? getTokenDecoder().decode(vault.data.subarray(0, 165)).amount : 0n;
    const nextRound = e.revShareBps > 0 && f.now >= e.revStart ? (f.now - e.revStart) / e.roundSecs : null;
    return send(reply, {
      treasury: f.c.treasury,
      extended: true,
      state: f.treasury.state === TreasuryState.Active ? 'active' : 'liquidating',
      terms: {
        governance: e.votePeriodSecs > 0n ? { votePeriodSecs: e.votePeriodSecs, timelockSecs: e.timelockSecs, quorumBps: e.quorumBps, thresholdBps: e.thresholdBps, maxProposalBps: e.maxProposalBps, proposerMinBps: e.proposerMinBps } : null,
        nav: e.navPeriodSecs > 0n ? { periodSecs: e.navPeriodSecs, capBps: e.navCapBps, insiders: e.insiders.filter((x) => x !== ZERO) } : null,
        distributions: { streamSecs: e.streamSecs },
        revenue: e.revShareBps > 0 ? { shareBps: e.revShareBps, credential: e.revCredential, schema: e.revSchema, roundSecs: e.roundSecs, start: e.revStart, payGraceSecs: e.payGraceSecs, trancheMinRevenue: e.trancheMinRevenue, trancheAmount: e.trancheAmount } : null,
        grants: { minLockupSecs: e.minLockupSecs },
        disclosure: e.disclosurePeriodSecs > 0n ? { periodSecs: e.disclosurePeriodSecs, requestMinBps: e.requestMinBps } : null,
        assignment: e.assignRequired ? { credential: e.assignCredential, schema: e.assignSchema } : null,
        windDown: e.windowSecs > 0n ? { windowSecs: e.windowSecs, recovery: e.recovery } : null,
      },
      live: {
        proposals: e.proposalCount,
        votesLocked: e.votesLocked,
        totalStaked: e.totalStaked,
        grants: e.grantCount,
        grantsUnreleased: e.grantsUnreleased,
        navOpen: e.navOpen,
        navPeriod: e.navOpen ? { start: e.navPeriodStart, supplyAtStart: e.navPeriodSupply, burned: e.navBurned, endsAt: e.navPeriodStart + e.navPeriodSecs } : null,
        missedRounds: e.missedRounds,
        currentRound: nextRound,
        stream: e.streamAmount > 0n ? { remaining: e.streamAmount, end: e.streamEnd } : null,
        disclosures: e.disclosures,
        lastDisclosureAt: e.disclosures > 0 ? e.lastDisclosureTs : null,
        disclosureRequestOpenSince: e.openRequestTs > 0n ? e.openRequestTs : null,
        disclosureDeadline: e.openRequestTs > 0n ? e.openRequestTs + e.disclosurePeriodSecs : null,
        assigned: e.assignRequired ? e.assigned : null,
        windDown: e.windowSecs > 0n && e.windStart > 0n ? { start: e.windStart, sweepOpensAt: e.windStart + e.windowSecs, swept: e.swept } : null,
      },
      balances: { vault: vaultBalance, coinVault: await read(coinVault[0]), distVault: await read(distVault[0]), coinSupply: f.coinSupply },
    });
  });

  const proposalView = (f: Facts, e: TreasuryExt, p: Awaited<ReturnType<typeof proposalOf>>) => ({
    id: p.id,
    proposer: p.proposer,
    kind: KIND_NAMES[p.kind],
    amount: p.amount,
    destination: p.destination === ZERO ? null : p.destination,
    descHash: Buffer.from(p.descHash).toString('hex'),
    createdAt: p.createdTs,
    voteEndsAt: p.voteEndTs,
    executableAt: p.executableTs,
    expiresAt: p.expiresTs,
    yes: p.yes,
    no: p.no,
    quorumNeeded: (circulating(f, e) * BigInt(e.quorumBps) + 9_999n) / 10_000n,
    status: statusOf(f, e, p),
  });

  app.get('/v1/treasuries/:address/proposals', async (req, reply) => {
    const f = await facts(addr((req.params as { address: string }).address, 'address'));
    const e = needExt(f);
    const out = [];
    for (let id = e.proposalCount; id > 0n && out.length < LIST_MAX; id--) out.push(proposalView(f, e, await proposalOf(f, id - 1n)));
    return send(reply, { treasury: f.c.treasury, count: e.proposalCount, proposals: out });
  });
  app.get('/v1/treasuries/:address/proposals/:id', async (req, reply) => {
    const f = await facts(addr((req.params as { address: string }).address, 'address'));
    const e = needExt(f);
    const id = u64((req.params as { id: string }).id, 'id');
    const view = proposalView(f, e, await proposalOf(f, id));
    const voter = opt((req.query as { voter?: string }).voter, (v) => addr(v, 'voter'));
    let vote = null;
    if (voter) {
      const rec = await d.account(await voteRecordAddress(f.c.treasury, id, voter));
      vote = rec ? getVoteRecordDecoder().decode(rec.data) : null;
    }
    return send(reply, { ...view, vote: vote && { voter, yes: vote.yes, no: vote.no } });
  });

  app.get('/v1/treasuries/:address/positions/:owner', async (req, reply) => {
    const f = await facts(addr((req.params as { address: string }).address, 'address'));
    const e = needExt(f);
    const owner = addr((req.params as { owner: string }).owner, 'owner');
    const pos = await positionOf(f, owner);
    const held = await balanceOf(owner, f.c.coinMint, f.c.coinTokenProgram);
    return send(reply, { treasury: f.c.treasury, owner, held, staked: pos?.amount ?? 0n, claimable: pos ? claimableOf(pos, e, f.now) : 0n, totalStaked: e.totalStaked });
  });

  app.get('/v1/treasuries/:address/grants', async (req, reply) => {
    const f = await facts(addr((req.params as { address: string }).address, 'address'));
    const e = needExt(f);
    const out = [];
    for (let id = e.grantCount; id > 0n && out.length < LIST_MAX; id--) {
      const address = await grantAddress(f.c.treasury, id - 1n);
      const acct = await d.account(address);
      if (!acct) continue;
      const g = getGrantDecoder().decode(acct.data);
      const milestones = g.milestones.slice(0, g.milestoneCount).map((m, index) => ({ index, bps: m.bps, requiresAttestation: m.requiresAttestation, released: m.released, amount: (g.total * BigInt(m.bps)) / 10_000n }));
      out.push({ id: g.id, address, beneficiary: g.beneficiary, total: g.total, released: g.released, lockupEnd: g.lockupEnd, expiresAt: g.expiryTs, burned: g.burned, status: g.burned ? 'expired' : f.now < g.lockupEnd ? 'locked' : f.now >= g.expiryTs ? 'expirable' : 'releasing', milestones });
    }
    return send(reply, { treasury: f.c.treasury, count: e.grantCount, grants: out });
  });

  app.get('/v1/treasuries/:address/rounds', async (req, reply) => {
    const f = await facts(addr((req.params as { address: string }).address, 'address'));
    const e = needExt(f);
    if (e.revShareBps === 0) return send(reply, { treasury: f.c.treasury, rounds: [], note: 'This treasury has no revenue rounds.' });
    const current = f.now >= e.revStart ? (f.now - e.revStart) / e.roundSecs : -1n;
    const out = [];
    for (let round = current; round >= 0n && out.length < LIST_MAX; round--) {
      const rec = await d.account(await roundRecordAddress(f.c.treasury, round));
      const r = rec ? getRoundRecordDecoder().decode(rec.data) : null;
      const endsAt = e.revStart + (round + 1n) * e.roundSecs;
      const attestation = await revenueAttestationAddress({ treasury: f.c.treasury, revCredential: e.revCredential, revSchema: e.revSchema }, round);
      out.push({ round, endsAt, payDeadline: endsAt + e.payGraceSecs, status: r ? (r.missed ? 'missed' : 'paid') : f.now < endsAt ? 'open' : f.now <= endsAt + e.payGraceSecs ? 'awaiting-payment' : 'late', revenue: r?.revenue ?? null, due: r?.due ?? null, trancheReleased: r?.trancheReleased ?? null, attestation, attested: !!(await d.account(attestation)) });
    }
    return send(reply, { treasury: f.c.treasury, rounds: out });
  });

  app.get('/v1/treasuries/:address/events', async (req, reply) => {
    const treasury = addr((req.params as { address: string }).address, 'address');
    const q = req.query as { name?: string; limit?: string };
    const limit = q.limit === undefined ? 50 : Number(q.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new RequestError(400, 'limit must be an integer in [1, 200]');
    if (q.name !== undefined && !/^[A-Za-z]{1,40}$/.test(q.name)) throw new RequestError(400, 'name must be an event name such as Voted');
    const { rows } = await d.db.query('SELECT signature, seq, slot, extract(epoch FROM block_time)::bigint AS time, name, payload FROM treasury_events WHERE treasury = $1 AND ($2::text IS NULL OR name = $2) ORDER BY slot DESC, seq DESC LIMIT $3', [treasury, q.name ?? null, limit]);
    return send(reply, { treasury, events: rows });
  });
}

// ------------------------------------------------------------------ extension terms from JSON

const INSIDER_SLOTS = 4;
function parseExtParams(p: Record<string, unknown>) {
  const keys = ['votePeriodSecs', 'timelockSecs', 'quorumBps', 'thresholdBps', 'maxProposalBps', 'proposerMinBps', 'minLockupSecs', 'navPeriodSecs', 'navCapBps', 'insiders', 'streamSecs', 'revShareBps', 'revCredential', 'revSchema', 'roundSecs', 'revStart', 'payGraceSecs', 'trancheMinRevenue', 'trancheAmount', 'disclosurePeriodSecs', 'requestMinBps', 'assignRequired', 'assignCredential', 'assignSchema', 'windowSecs', 'recovery'];
  only(p, keys, 'params');
  const secs = (k: string) => (p[k] === undefined ? 0n : i64(p[k], `params.${k}`));
  const bps = (k: string) => (p[k] === undefined ? 0 : int(p[k], `params.${k}`, 10_000));
  const a = (k: string) => (p[k] === undefined || p[k] === null ? ZERO : addr(p[k], `params.${k}`));
  const insiders = p.insiders === undefined ? [] : list<Address>(p.insiders, 'params.insiders', INSIDER_SLOTS, (x, i) => addr(x, `params.insiders[${i}]`));
  return {
    votePeriodSecs: secs('votePeriodSecs'),
    timelockSecs: secs('timelockSecs'),
    quorumBps: bps('quorumBps'),
    thresholdBps: bps('thresholdBps'),
    maxProposalBps: bps('maxProposalBps'),
    proposerMinBps: bps('proposerMinBps'),
    minLockupSecs: secs('minLockupSecs'),
    navPeriodSecs: secs('navPeriodSecs'),
    navCapBps: bps('navCapBps'),
    insiders: [...insiders, ...Array.from({ length: INSIDER_SLOTS - insiders.length }, () => ZERO)],
    streamSecs: secs('streamSecs'),
    revShareBps: bps('revShareBps'),
    revCredential: a('revCredential'),
    revSchema: a('revSchema'),
    roundSecs: secs('roundSecs'),
    revStart: secs('revStart'),
    payGraceSecs: secs('payGraceSecs'),
    trancheMinRevenue: p.trancheMinRevenue === undefined ? 0n : u64(p.trancheMinRevenue, 'params.trancheMinRevenue'),
    trancheAmount: p.trancheAmount === undefined ? 0n : u64(p.trancheAmount, 'params.trancheAmount'),
    disclosurePeriodSecs: secs('disclosurePeriodSecs'),
    requestMinBps: bps('requestMinBps'),
    assignRequired: p.assignRequired === undefined ? false : bool(p.assignRequired, 'params.assignRequired'),
    assignCredential: a('assignCredential'),
    assignSchema: a('assignSchema'),
    windowSecs: secs('windowSecs'),
    recovery: a('recovery'),
  };
}

function parseFlagship(b: Record<string, unknown>) {
  only(b, ['authority', 'preset', 'revenueCredential', 'revenueSchema', 'assignmentCredential', 'assignmentSchema', 'revenueShareBps', 'revenueStart', 'recovery', 'insiders'], 'flagship preset');
  return flagshipExtParams({
    revenueCredential: addr(b.revenueCredential, 'revenueCredential'),
    revenueSchema: addr(b.revenueSchema, 'revenueSchema'),
    assignmentCredential: addr(b.assignmentCredential, 'assignmentCredential'),
    assignmentSchema: addr(b.assignmentSchema, 'assignmentSchema'),
    revenueShareBps: int(b.revenueShareBps, 'revenueShareBps', 10_000, 1),
    revenueStart: i64(b.revenueStart, 'revenueStart'),
    recovery: addr(b.recovery, 'recovery'),
    ...(b.insiders !== undefined && { insiders: list<Address>(b.insiders, 'insiders', INSIDER_SLOTS, (x, i) => addr(x, `insiders[${i}]`)) }),
  });
}

void isAddress;
void TOKEN_2022_PROGRAM_ADDRESS;
