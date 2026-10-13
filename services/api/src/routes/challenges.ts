// Issuer neutrality, read from chain (ADR-0702; the transactions are in rules-tx.ts): who the arbiter is, and the state of a cross's challenge window
// with every challenge that is still open, each with the second it can be closed by anyone if the arbiter stays silent.
//
// GET /v1/arbiter                                  who rules on insider challenges (named by the protocol admin, docs/HUMAN_TASKS.md H28), or that no one is named yet
// GET /v1/crosses/:address/challenge-state         the declared insiders, the bond, the challenge window, and every open challenge with its deadline
//
// The index route GET /v1/crosses/:address/challenges (rules-read.ts) lists every challenge ever filed with its outcome. A challenge account is closed when it is ruled on or
// expires, so this route can only show the open ones; a challenge missing here is in the index with the outcome.
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Address } from '@solana/kit';
import {
  ARBITER_DEADLINE_SECS,
  ARBITER_REGISTRY_DISCRIMINATOR,
  CHALLENGE_DEPOSIT_LAMPORTS,
  CHALLENGE_DISCRIMINATOR,
  CROSS_CORE_PROGRAM_ADDRESS,
  CROSS_DISCRIMINATOR,
  CrossState,
  ChallengeStatus,
  arbiterRegistryAddress,
  challengeAddress,
  getArbiterRegistryDecoder,
  getChallengeDecoder,
  readRuledCross,
} from '@opening-cross/sdk';
import { RequestError } from '../tx.js';
import { addr, json } from './_inputs.js';

type ChainAccount = { data: Uint8Array; owner: Address };
export type ChallengesDeps = {
  account: (a: Address) => Promise<ChainAccount | null>;
  /** Unix seconds; defaults to the wall clock. Tests inject one. */
  clock?: () => number;
};

const send = (reply: FastifyReply, v: unknown, status = 200) => reply.code(status).type('application/json').send(json(v));
const starts = (data: Uint8Array, prefix: ArrayLike<number>) => data.length >= prefix.length && Array.from(prefix).every((b, i) => data[i] === b);

export function registerChallenges(app: FastifyInstance, d: ChallengesDeps): void {
  const now = () => BigInt(d.clock?.() ?? Math.floor(Date.now() / 1000));

  app.get('/v1/arbiter', async (_req, reply) => {
    const registry = await arbiterRegistryAddress();
    const acct = await d.account(registry);
    if (!acct || acct.owner !== CROSS_CORE_PROGRAM_ADDRESS || !starts(acct.data, ARBITER_REGISTRY_DISCRIMINATOR)) {
      return send(reply, { registry, arbiter: null, named: false, note: 'No arbiter has been named yet (docs/HUMAN_TASKS.md H28). Until one is, a challenge cannot be ruled on; after the deadline anyone may close it and the challenger gets the deposit back.', deadlineSecs: ARBITER_DEADLINE_SECS });
    }
    return send(reply, { registry, arbiter: getArbiterRegistryDecoder().decode(acct.data).arbiter, named: true, deadlineSecs: ARBITER_DEADLINE_SECS });
  });

  app.get('/v1/crosses/:address/challenge-state', async (req, reply) => {
    const a = addr((req.params as { address: string }).address, 'address');
    const acct = await d.account(a);
    if (!acct) throw new RequestError(404, `cross ${a} not found on chain`);
    if (acct.owner !== CROSS_CORE_PROGRAM_ADDRESS || !starts(acct.data, CROSS_DISCRIMINATOR)) throw new RequestError(404, `${a} is not an Opening Cross account`);
    const cross = readRuledCross(a, acct.data);
    const x = cross.ext;
    if (!x || (x.neutrality.insiderCount === 0 && x.neutrality.bondQuote === 0n)) {
      return send(reply, { cross: a, applies: false, note: 'This cross declared no insiders and posted no bond, so it has no challenge window.' });
    }
    const arbiterAcct = await d.account(await arbiterRegistryAddress());
    const arbiter = arbiterAcct && starts(arbiterAcct.data, ARBITER_REGISTRY_DISCRIMINATOR) ? getArbiterRegistryDecoder().decode(arbiterAcct.data).arbiter : null;
    const cleared = cross.data.state === CrossState.Cleared || cross.data.state === CrossState.Finalized;
    const clearedTs = cleared ? x.clearing.clearedTs : null;
    const closesAt = clearedTs === null || x.neutrality.bondQuote === 0n ? null : clearedTs + BigInt(x.neutrality.challengeSecs);
    const t = now();
    const challenges = [];
    for (let id = 0; id < x.neutralState.challenges; id++) {
      const address = await challengeAddress(a, id);
      const c = await d.account(address);
      if (!c || c.owner !== CROSS_CORE_PROGRAM_ADDRESS || !starts(c.data, CHALLENGE_DISCRIMINATOR)) continue; // closed: ruled on or expired
      const ch = getChallengeDecoder().decode(c.data);
      if (ch.status !== ChallengeStatus.Open) continue;
      const expirableAt = ch.filedTs + ARBITER_DEADLINE_SECS;
      challenges.push({ id, address, challenger: ch.challenger, subject: ch.subject, evidence: Buffer.from(ch.evidence).toString('hex'), deposit: ch.deposit, filedTs: ch.filedTs, expirableAt, expirable: t >= expirableAt });
    }
    return send(reply, {
      cross: a,
      applies: true,
      state: CrossState[cross.data.state],
      insiders: x.neutrality.insiders.slice(0, x.neutrality.insiderCount),
      bond: { posted: x.neutrality.bondQuote, held: x.neutralState.bondHeld, slashed: x.neutralState.slashed },
      window: { clearedAt: clearedTs, closesAt, open: cross.data.state === CrossState.Cleared && closesAt !== null && t < closesAt },
      filed: x.neutralState.challenges,
      open: x.neutralState.openChallenges,
      challenges,
      arbiter,
      arbiterNamed: arbiter !== null,
      arbiterDeadlineSecs: ARBITER_DEADLINE_SECS,
      depositLamports: CHALLENGE_DEPOSIT_LAMPORTS,
      finalizeBlocked: x.neutralState.openChallenges > 0 ? 'open challenges' : closesAt !== null && t < closesAt ? 'challenge window' : null,
      note: arbiter === null ? 'No arbiter is named, so an open challenge can only end by expiring after the deadline.' : undefined,
    });
  });
}
