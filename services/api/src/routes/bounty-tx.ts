// cross_bounty over HTTP (X10; ADR-0654): a pool committed for at least thirty days that pays automatically, once per invariant, to whoever shows a cross account that
// breaks one of eleven invariants, and by a named arbiter for what the chain cannot check. The sponsor can withdraw only after the expiry. Unsigned transactions
// and reads. The program is NOT deployed to devnet until the operations key is funded (docs/HUMAN_TASKS.md H27, H43).
//
//   POST /v1/tx/bounty-create           { sponsor, rewardMint, arbiter, expiresAt, rewards: [11 amounts], id? }
//   POST /v1/tx/bounty-fund             { funder, bounty, amount }                   anyone may add to the pool
//   POST /v1/tx/bounty-claim-invariant  { claimant, bounty, cross, invariant? }      pays the reward if the cross breaks the invariant; without `invariant`, the first broken one the bounty covers
//   POST /v1/tx/bounty-award            { arbiter, bounty, hunter, amount, evidence }  the arbiter, before the expiry; `evidence` is the report's hash (64 hex)
//   POST /v1/tx/bounty-withdraw         { sponsor, bounty, amount? }                 the sponsor, from the expiry on; default all of the pool
//   GET  /v1/bounties                   the index
//   GET  /v1/bounties/:address          the terms, the pool, what each invariant pays and whether it has paid
//   GET  /v1/bounties/:address/payouts  what was paid and to whom (the index)
//   GET  /v1/crosses/:address/invariants  which of the eleven invariants the cross account breaks right now (empty for an honest cross)
import type { FastifyInstance, FastifyReply } from 'fastify';
import { type Address, createNoopSigner } from '@solana/kit';
import {
  AWARD_DISCRIMINATOR,
  BOUNTY_DISCRIMINATOR,
  CLAIM_INVARIANT_DISCRIMINATOR,
  CREATE_BOUNTY_DISCRIMINATOR,
  FUND_DISCRIMINATOR,
  WITHDRAW_DISCRIMINATOR,
  findBountyPda,
  getBountyDecoder,
} from '@opening-cross/cross-bounty-client';
import {
  BOUNTY_INVARIANTS,
  BOUNTY_INVARIANT_NAMES,
  BOUNTY_MIN_COMMITMENT_SECS,
  CROSS_BOUNTY_PROGRAM_ADDRESS,
  TOKEN_2022_PROGRAM,
  ata,
  bountyAddresses,
  brokenInvariants,
  buildAward,
  buildClaimInvariant,
  buildCreateBounty,
  buildFundBounty,
  buildWithdrawBounty,
  checkBountyClaim,
  checkBountyTerms,
} from '@opening-cross/sdk';
import { type Lifetime, RequestError } from '../tx.js';
import { addr, hex32, i64, json, list, obj, only, opt, u64 } from './_inputs.js';
import { hasActiveTransferHook } from './meteora-tx.js';
import { type AccountReader, type Db, type ProgramRelease, building, failIf, mintOf, oneTx, programRelease, readAccount, readCross, releaseNote, requireNew, tokenBalance } from './programs-support.js';

export type BountyTxDeps = {
  account: AccountReader;
  lifetime: () => Promise<Lifetime>;
  db?: Db;
  clock?: () => number;
  gate?: ProgramRelease;
};

const send = (reply: FastifyReply, v: unknown, status = 200) => reply.code(status).type('application/json').send(json(v));
const MAX_ID_PROBES = 64;

export function registerBountyTx(app: FastifyInstance, d: BountyTxDeps): void {
  const now = () => BigInt(d.clock?.() ?? Math.floor(Date.now() / 1000));
  const gate = d.gate ?? programRelease({ account: d.account, ...(d.clock && { clock: d.clock }) });
  const need = (name: string, discriminator: Uint8Array) => requireNew(gate, 'crossBounty', { name, discriminator });
  const tx = async (payer: Address, ixs: Parameters<typeof oneTx>[1], what: string) => oneTx(payer, ixs, await d.lifetime(), what);

  async function readBounty(address: Address) {
    const { value } = await readAccount(d.account, address, { owner: CROSS_BOUNTY_PROGRAM_ADDRESS, disc: BOUNTY_DISCRIMINATOR as Uint8Array, decode: (b) => getBountyDecoder().decode(b), what: 'bounty', reason: 'NO_SUCH_BOUNTY' });
    if ((await findBountyPda({ sponsor: value.sponsor, id: value.id }))[0] !== address) throw new RequestError(404, `${address} is not a bounty at its own address`, { reason: 'NO_SUCH_BOUNTY' });
    const a = await bountyAddresses(value.sponsor, value.id, value.rewardMint, value.tokenProgram);
    return { data: value, vault: a.vault };
  }
  const invariantRows = (b: { rewards: readonly bigint[]; paidMask: number }) =>
    Array.from({ length: BOUNTY_INVARIANTS }, (_, i) => ({ invariant: i, name: BOUNTY_INVARIANT_NAMES[i], reward: b.rewards[i] ?? 0n, covered: (b.rewards[i] ?? 0n) > 0n, paid: (b.paidMask & (1 << i)) !== 0 }));

  app.post('/v1/tx/bounty-create', async (req, reply) => {
    const b = obj(req.body);
    only(b, ['sponsor', 'rewardMint', 'arbiter', 'expiresAt', 'rewards', 'id'], 'bounty-create');
    const sponsor = addr(b.sponsor, 'sponsor');
    const rewardMint = addr(b.rewardMint, 'rewardMint');
    const arbiter = addr(b.arbiter, 'arbiter');
    const expiresAt = i64(b.expiresAt, 'expiresAt');
    const rewards = list(b.rewards, 'rewards', BOUNTY_INVARIANTS + 8, (x, i) => u64(x, `rewards[${i}]`));
    const release = await need('create_bounty', CREATE_BOUNTY_DISCRIMINATOR as Uint8Array);
    failIf(checkBountyTerms(rewards, expiresAt, now()), 'The bounty terms are not valid');
    const m = await mintOf(d.account, rewardMint, 'rewardMint');
    if (m.tokenProgram === TOKEN_2022_PROGRAM && hasActiveTransferHook(m.data)) throw new RequestError(422, `The reward mint ${rewardMint} runs a transfer hook on every transfer. The pool is built here without hook accounts. Refused.`, { reason: 'MINT_HAS_TRANSFER_HOOK', mint: rewardMint });
    let id = opt(b.id, (v) => u64(v, 'id'));
    if (id === null) {
      for (let i = 0n; i < BigInt(MAX_ID_PROBES) && id === null; i++) if (!(await d.account((await findBountyPda({ sponsor, id: i }))[0]))) id = i;
      if (id === null) throw new RequestError(409, `The sponsor already has ${MAX_ID_PROBES} bounties from id 0; name an id.`, { reason: 'ID_RANGE_FULL' });
    } else if (await d.account((await findBountyPda({ sponsor, id }))[0])) {
      throw new RequestError(409, `The sponsor already has a bounty with id ${id}.`, { reason: 'ALREADY_EXISTS', id });
    }
    const built = await building(() => buildCreateBounty({ sponsor: createNoopSigner(sponsor), id: id!, rewardMint, tokenProgram: m.tokenProgram, arbiter, expiresAt, rewards, now: now() }));
    return send(reply, {
      ...(await tx(sponsor, [built.instruction], 'bounty creation')),
      bounty: built.bounty,
      vault: built.vault,
      id,
      pool: 'empty: fund it with bounty-fund',
      note: `The pool is committed until ${expiresAt}: the sponsor cannot withdraw before then (at least ${BOUNTY_MIN_COMMITMENT_SECS} seconds from creation). A reward larger than what the pool holds pays what is left.`,
      release,
    });
  });

  app.post('/v1/tx/bounty-fund', async (req, reply) => {
    const b = obj(req.body);
    only(b, ['funder', 'bounty', 'amount'], 'bounty-fund');
    const funder = addr(b.funder, 'funder');
    const amount = u64(b.amount, 'amount');
    const release = await need('fund', FUND_DISCRIMINATOR as Uint8Array);
    const address = addr(b.bounty, 'bounty');
    const bounty = await readBounty(address);
    const have = await tokenBalance(d.account, await ata(funder, bounty.data.rewardMint, bounty.data.tokenProgram));
    if (have === null || have < amount) throw new RequestError(422, `${funder} holds ${have ?? 0n} of the reward token; ${amount} was asked for.`, { reason: 'INSUFFICIENT_BALANCE', have: have ?? 0n, need: amount });
    const ix = await building(() => buildFundBounty({ funder: createNoopSigner(funder), bounty: address, vault: bounty.vault, rewardMint: bounty.data.rewardMint, tokenProgram: bounty.data.tokenProgram, amount }));
    return send(reply, { ...(await tx(funder, [ix], 'bounty funding')), bounty: address, vault: bounty.vault, amount, release });
  });

  app.post('/v1/tx/bounty-claim-invariant', async (req, reply) => {
    const b = obj(req.body);
    only(b, ['claimant', 'bounty', 'cross', 'invariant'], 'bounty-claim-invariant');
    const claimant = addr(b.claimant, 'claimant');
    const release = await need('claim_invariant', CLAIM_INVARIANT_DISCRIMINATOR as Uint8Array);
    const address = addr(b.bounty, 'bounty');
    const bounty = await readBounty(address);
    const cross = await readCross(d.account, addr(b.cross, 'cross'));
    const broken = brokenInvariants(cross.data);
    const claimable = broken.filter((i) => checkBountyClaim(bounty.data, i, now()).length === 0);
    let invariant = opt(b.invariant, (v) => {
      if (typeof v !== 'number' || !Number.isInteger(v)) throw new RequestError(400, 'invariant must be an integer from 0 to 10');
      return v;
    });
    const pre = invariant === null ? [] : checkBountyClaim(bounty.data, invariant, now());
    failIf(pre, 'The claim would be refused');
    if (invariant === null) {
      if (claimable.length === 0) throw new RequestError(422, broken.length === 0 ? 'This cross account breaks none of the eleven invariants, so there is nothing to claim.' : 'The cross breaks invariants this bounty does not pay or has already paid.', { reason: 'NO_VIOLATION', broken });
      invariant = claimable[0]!;
    } else if (!broken.includes(invariant)) {
      throw new RequestError(422, `This cross account does not break invariant ${invariant} (${BOUNTY_INVARIANT_NAMES[invariant]}).`, { reason: 'NO_VIOLATION', broken });
    }
    const held = (await tokenBalance(d.account, bounty.vault)) ?? 0n;
    if (held === 0n) throw new RequestError(409, 'The pool is empty.', { reason: 'POOL_EMPTY' });
    const reward = bounty.data.rewards[invariant]!;
    const ixs = await building(() => buildClaimInvariant({ claimant: createNoopSigner(claimant), bounty: address, vault: bounty.vault, rewardMint: bounty.data.rewardMint, tokenProgram: bounty.data.tokenProgram, cross: cross.address, invariant: invariant!, createDestination: true }));
    return send(reply, { ...(await tx(claimant, ixs, 'claim')), bounty: address, cross: cross.address, invariant, invariantName: BOUNTY_INVARIANT_NAMES[invariant], pays: reward < held ? reward : held, release });
  });

  app.post('/v1/tx/bounty-award', async (req, reply) => {
    const b = obj(req.body);
    only(b, ['arbiter', 'bounty', 'hunter', 'amount', 'evidence'], 'bounty-award');
    const arbiter = addr(b.arbiter, 'arbiter');
    const hunter = addr(b.hunter, 'hunter');
    const amount = u64(b.amount, 'amount');
    const evidence = hex32(b.evidence, 'evidence');
    const release = await need('award', AWARD_DISCRIMINATOR as Uint8Array);
    const address = addr(b.bounty, 'bounty');
    const bounty = await readBounty(address);
    if (bounty.data.arbiter !== arbiter) throw new RequestError(422, `${arbiter} is not this bounty's arbiter (${bounty.data.arbiter}).`, { reason: 'NOT_THE_ARBITER', arbiter: bounty.data.arbiter });
    if (now() >= bounty.data.expiresAt) throw new RequestError(409, 'The bounty has expired; the arbiter awards only before the expiry.', { reason: 'EXPIRED', expiresAt: bounty.data.expiresAt });
    const held = (await tokenBalance(d.account, bounty.vault)) ?? 0n;
    if (amount > held) throw new RequestError(422, `The pool holds ${held}; ${amount} was asked for.`, { reason: 'OVER_POOL', held });
    const ixs = await building(() => buildAward({ arbiter: createNoopSigner(arbiter), bounty: address, vault: bounty.vault, rewardMint: bounty.data.rewardMint, tokenProgram: bounty.data.tokenProgram, hunter, amount, evidence, createDestination: true }));
    return send(reply, { ...(await tx(arbiter, ixs, 'award')), bounty: address, hunter, amount, release });
  });

  app.post('/v1/tx/bounty-withdraw', async (req, reply) => {
    const b = obj(req.body);
    only(b, ['sponsor', 'bounty', 'amount'], 'bounty-withdraw');
    const sponsor = addr(b.sponsor, 'sponsor');
    const release = await need('withdraw', WITHDRAW_DISCRIMINATOR as Uint8Array);
    const address = addr(b.bounty, 'bounty');
    const bounty = await readBounty(address);
    if (bounty.data.sponsor !== sponsor) throw new RequestError(422, `${sponsor} is not this bounty's sponsor (${bounty.data.sponsor}).`, { reason: 'NOT_THE_SPONSOR', sponsor: bounty.data.sponsor });
    if (now() < bounty.data.expiresAt) throw new RequestError(409, `The pool is committed until ${bounty.data.expiresAt}.`, { reason: 'STILL_COMMITTED', expiresAt: bounty.data.expiresAt, secondsLeft: bounty.data.expiresAt - now() });
    const held = (await tokenBalance(d.account, bounty.vault)) ?? 0n;
    const amount = opt(b.amount, (v) => u64(v, 'amount')) ?? held;
    if (amount === 0n) throw new RequestError(409, 'The pool is empty.', { reason: 'POOL_EMPTY' });
    if (amount > held) throw new RequestError(422, `The pool holds ${held}; ${amount} was asked for.`, { reason: 'OVER_POOL', held });
    const ix = await building(() => buildWithdrawBounty({ sponsor: createNoopSigner(sponsor), bounty: address, vault: bounty.vault, rewardMint: bounty.data.rewardMint, tokenProgram: bounty.data.tokenProgram, amount, expiresAt: bounty.data.expiresAt, now: now() }));
    return send(reply, { ...(await tx(sponsor, [ix], 'withdrawal')), bounty: address, amount, release });
  });

  // ---------------------------------------------------------------- reads
  app.get('/v1/bounties/:address', async (req, reply) => {
    const address = addr((req.params as { address: string }).address, 'address');
    const release = await releaseNote(gate, 'crossBounty');
    if (release.deployed === false) throw new RequestError(404, `bounty ${address} not found: ${release.note}`, { reason: 'PROGRAM_NOT_DEPLOYED', release });
    const bounty = await readBounty(address);
    const pool = await tokenBalance(d.account, bounty.vault);
    const t = now();
    return send(reply, {
      bounty: address,
      sponsor: bounty.data.sponsor,
      id: bounty.data.id,
      arbiter: bounty.data.arbiter,
      rewardMint: bounty.data.rewardMint,
      tokenProgram: bounty.data.tokenProgram,
      vault: bounty.vault,
      pool,
      expiresAt: bounty.data.expiresAt,
      status: t >= bounty.data.expiresAt ? 'expired' : pool === 0n ? 'empty' : 'open',
      secondsLeft: t >= bounty.data.expiresAt ? 0n : bounty.data.expiresAt - t,
      paidMask: bounty.data.paidMask,
      awarded: bounty.data.awarded,
      invariants: invariantRows(bounty.data),
      release,
    });
  });

  app.get('/v1/bounties', async (req, reply) => {
    const q = req.query as { sponsor?: string; limit?: string };
    const sponsor = q.sponsor === undefined ? null : addr(q.sponsor, 'sponsor');
    const limit = q.limit === undefined ? 50 : Math.min(200, Math.max(1, Number.parseInt(q.limit, 10) || 50));
    const release = await releaseNote(gate, 'crossBounty');
    const rows = d.db ? (await d.db.query(`SELECT * FROM bounties WHERE ($1::text IS NULL OR sponsor = $1) ORDER BY created_slot DESC LIMIT $2`, [sponsor, limit])).rows : [];
    const t = Number(now());
    return send(reply, {
      bounties: rows.map((r) => ({ bounty: r.address, sponsor: r.sponsor, arbiter: r.arbiter, rewardMint: r.reward_mint, expiresAt: Number(r.expires_at), status: t >= Number(r.expires_at) ? 'expired' : 'open', rewards: r.rewards, funded: String(r.funded), paid: String(r.paid), awarded: String(r.awarded), withdrawn: String(r.withdrawn), paidMask: Number(r.paid_mask) })),
      release,
      ...(release.deployed === false && { note: release.note }),
    });
  });

  app.get('/v1/bounties/:address/payouts', async (req, reply) => {
    const address = addr((req.params as { address: string }).address, 'address');
    const release = await releaseNote(gate, 'crossBounty');
    const rows = d.db ? (await d.db.query(`SELECT kind, invariant, cross_address, recipient, amount, evidence, slot FROM bounty_payouts WHERE bounty = $1 ORDER BY slot DESC LIMIT 200`, [address])).rows : [];
    return send(reply, { bounty: address, payouts: rows.map((r) => ({ kind: r.kind, invariant: r.invariant === null ? null : Number(r.invariant), invariantName: r.invariant === null ? null : BOUNTY_INVARIANT_NAMES[Number(r.invariant)], cross: r.cross_address, recipient: r.recipient, amount: String(r.amount), evidence: r.evidence, slot: String(r.slot) })), release });
  });

  app.get('/v1/crosses/:address/invariants', async (req, reply) => {
    const cross = await readCross(d.account, addr((req.params as { address: string }).address, 'address'));
    const broken = brokenInvariants(cross.data);
    return send(reply, {
      cross: cross.address,
      checked: BOUNTY_INVARIANTS,
      broken: broken.map((i) => ({ invariant: i, name: BOUNTY_INVARIANT_NAMES[i] })),
      honest: broken.length === 0,
      note: 'These are the eleven account-level invariants cross_core promises never to break (programs/cross_bounty). Eleven invariants are not a proof of correctness; an empty list means none of them fires on this account right now.',
    });
  });
}
