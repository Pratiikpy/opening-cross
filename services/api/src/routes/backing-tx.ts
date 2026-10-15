// cross_backing over HTTP (F6; ADR-0655): an opted-in asset is halted on chain, on anyone's call, when its attested backing is missing, stale or below the issuer's
// committed coverage of the live supply. Unsigned transactions and reads. The program is NOT deployed to devnet until the operations key is funded
// (docs/HUMAN_TASKS.md H27, H43).
//
//   POST /v1/tx/backing-init-halt-state  { authority, baseMint }                                       a halt state that names the watchdog as its venue signer (fixed at creation)
//   POST /v1/tx/backing-create-policy    { authority, mint, attester, minCoverageBps, maxAgeSecs }     the halt state's authority opts the asset in; the terms are permanent
//   POST /v1/tx/backing-attest           { attester, mint, backingAtoms }                               the policy's attester states the backing, in the mint's own atoms; the time is the chain's
//   POST /v1/tx/backing-check            { mint, payer }                                                anyone: halts the asset if its backing cannot be verified right now
//   GET  /v1/assets/:mint/backing        the policy, the last statement, the live supply, the verdict now and the halt state
//   GET  /v1/backing/policies            the index of opted-in assets
//
// A fresh statement does not lift a halt. Only a printing resume cross does (ADR-0455), so the first price after a halt is a one-price auction.
import type { FastifyInstance, FastifyReply } from 'fastify';
import { type Address, createNoopSigner } from '@solana/kit';
import {
  ATTEST_DISCRIMINATOR,
  ATTESTATION_DISCRIMINATOR,
  CHECK_DISCRIMINATOR,
  CREATE_POLICY_DISCRIMINATOR,
  POLICY_DISCRIMINATOR,
  getAttestationDecoder,
  getPolicyDecoder,
} from '@opening-cross/cross-backing-client';
import { CROSS_CORE_PROGRAM_ADDRESS, HALT_STATE_DISCRIMINATOR, HaltReason, getHaltStateDecoder } from '@opening-cross/cross-core-client';
import {
  BACKING_MAX_AGE_SECS,
  BACKING_MIN_AGE_SECS,
  CROSS_BACKING_PROGRAM_ADDRESS,
  backingAddresses,
  backingRequired,
  backingVerdict,
  buildAttestBacking,
  buildCheckBacking,
  buildCreateBackingPolicy,
  buildInitHaltStateWithWatchdog,
  checkBackingPolicy,
  watchdogAddress,
} from '@opening-cross/sdk';
import { type Lifetime, RequestError } from '../tx.js';
import { addr, i64, int, json, obj, only, u64 } from './_inputs.js';
import { type AccountReader, type Db, type ProgramRelease, building, failIf, mintOf, mintSupply, oneTx, programRelease, readAccount, releaseNote, requireNew } from './programs-support.js';

export type BackingTxDeps = {
  account: AccountReader;
  lifetime: () => Promise<Lifetime>;
  db?: Db;
  clock?: () => number;
  gate?: ProgramRelease;
};

const send = (reply: FastifyReply, v: unknown, status = 200) => reply.code(status).type('application/json').send(json(v));
const REASON = ['none', 'issuer pause', 'venue halt', 'circuit breaker', 'corporate action'];

export function registerBackingTx(app: FastifyInstance, d: BackingTxDeps): void {
  const now = () => BigInt(d.clock?.() ?? Math.floor(Date.now() / 1000));
  const gate = d.gate ?? programRelease({ account: d.account, ...(d.clock && { clock: d.clock }) });
  const need = (name: string, discriminator: Uint8Array) => requireNew(gate, 'crossBacking', { name, discriminator });
  const tx = async (payer: Address, ixs: Parameters<typeof oneTx>[1], what: string) => oneTx(payer, ixs, await d.lifetime(), what);

  async function readPolicy(mint: Address) {
    const a = await backingAddresses(mint);
    const { value } = await readAccount(d.account, a.policy, { owner: CROSS_BACKING_PROGRAM_ADDRESS, disc: POLICY_DISCRIMINATOR as Uint8Array, decode: (b) => getPolicyDecoder().decode(b), what: 'backing policy', reason: 'NO_POLICY' });
    return { policy: value, addresses: a };
  }
  async function readAttestation(mint: Address, attestation: Address) {
    const raw = await d.account(attestation);
    if (!raw || raw.owner !== CROSS_BACKING_PROGRAM_ADDRESS || !(ATTESTATION_DISCRIMINATOR as Uint8Array).every((x, i) => raw.data[i] === x)) return null;
    const a = getAttestationDecoder().decode(raw.data);
    return a.mint === mint ? a : null;
  }
  async function readHalt(halt: Address) {
    const raw = await d.account(halt);
    if (!raw || raw.owner !== CROSS_CORE_PROGRAM_ADDRESS || !(HALT_STATE_DISCRIMINATOR as Uint8Array).every((x, i) => raw.data[i] === x)) return null;
    return getHaltStateDecoder().decode(raw.data);
  }

  app.post('/v1/tx/backing-init-halt-state', async (req, reply) => {
    const b = obj(req.body);
    only(b, ['authority', 'baseMint'], 'backing-init-halt-state');
    const authority = addr(b.authority, 'authority');
    const baseMint = addr(b.baseMint, 'baseMint');
    const release = await need('create_policy', CREATE_POLICY_DISCRIMINATOR as Uint8Array);
    await mintOf(d.account, baseMint, 'baseMint');
    const a = await backingAddresses(baseMint);
    const existing = await readHalt(a.halt);
    if (existing) {
      const named = existing.venueSigner.__option === 'Some' ? existing.venueSigner.value : null;
      throw new RequestError(409, named === a.watchdog ? 'This asset already has a halt state that names the watchdog; create the policy.' : `This asset already has a halt state${named ? ` with the venue signer ${named}` : ' with no venue signer'}. The venue signer is fixed at creation, so the watchdog cannot be added to it.`, { reason: 'HALT_STATE_EXISTS', venueSigner: named, watchdog: a.watchdog });
    }
    const built = await building(() => buildInitHaltStateWithWatchdog({ authority: createNoopSigner(authority), baseMint }));
    return send(reply, { ...(await tx(authority, [built.instruction], 'halt state')), halt: built.halt, watchdog: built.watchdog, next: 'backing-create-policy', release });
  });

  app.post('/v1/tx/backing-create-policy', async (req, reply) => {
    const b = obj(req.body);
    only(b, ['authority', 'mint', 'attester', 'minCoverageBps', 'maxAgeSecs'], 'backing-create-policy');
    const authority = addr(b.authority, 'authority');
    const mint = addr(b.mint, 'mint');
    const attester = addr(b.attester, 'attester');
    const minCoverageBps = int(b.minCoverageBps, 'minCoverageBps', 0xffff);
    const maxAgeSecs = i64(b.maxAgeSecs, 'maxAgeSecs');
    const release = await need('create_policy', CREATE_POLICY_DISCRIMINATOR as Uint8Array);
    failIf(checkBackingPolicy(minCoverageBps, maxAgeSecs), 'The policy is not valid');
    await mintOf(d.account, mint);
    const a = await backingAddresses(mint);
    const halt = await readHalt(a.halt);
    if (!halt) throw new RequestError(409, 'This asset has no halt state. Create one that names the watchdog as its venue signer first (backing-init-halt-state).', { reason: 'NO_HALT_STATE', watchdog: a.watchdog });
    if (halt.authority !== authority) throw new RequestError(422, `${authority} is not the authority of this asset's halt state (${halt.authority}); only the authority can opt it in.`, { reason: 'NOT_THE_AUTHORITY', authority: halt.authority });
    const named = halt.venueSigner.__option === 'Some' ? halt.venueSigner.value : null;
    if (named !== a.watchdog) throw new RequestError(422, `The halt state's venue signer is ${named ?? 'not set'}, not this program's watchdog ${a.watchdog}. The venue signer is fixed at creation, so this asset cannot use the watchdog.`, { reason: 'WATCHDOG_NOT_VENUE_SIGNER', venueSigner: named, watchdog: a.watchdog });
    if (await d.account(a.policy)) throw new RequestError(409, 'This asset already has a backing policy; a policy is permanent.', { reason: 'ALREADY_EXISTS', policy: a.policy });
    const built = await building(() => buildCreateBackingPolicy({ authority: createNoopSigner(authority), mint, attester, minCoverageBps, maxAgeSecs }));
    const supply = await mintSupply(d.account, mint);
    return send(reply, {
      ...(await tx(authority, [built.instruction], 'policy')),
      policy: built.policy,
      attestation: built.attestation,
      watchdog: built.watchdog,
      halt: built.halt,
      requiredNow: supply === null ? null : backingRequired(supply, minCoverageBps),
      note: `Permanent: the asset is halted on anyone's call whenever the attester's statement is missing, older than ${maxAgeSecs} seconds (a statement may be fresh for ${BACKING_MIN_AGE_SECS} to ${BACKING_MAX_AGE_SECS} seconds) or below ${minCoverageBps / 100}% of the live supply. The first statement has to be posted before anyone calls check.`,
      release,
    });
  });

  app.post('/v1/tx/backing-attest', async (req, reply) => {
    const b = obj(req.body);
    only(b, ['attester', 'mint', 'backingAtoms'], 'backing-attest');
    const attester = addr(b.attester, 'attester');
    const mint = addr(b.mint, 'mint');
    const backingAtoms = u64(b.backingAtoms, 'backingAtoms');
    const release = await need('attest', ATTEST_DISCRIMINATOR as Uint8Array);
    const { policy } = await readPolicy(mint);
    if (policy.attester !== attester) throw new RequestError(422, `${attester} is not the attester of this asset's policy (${policy.attester}).`, { reason: 'NOT_THE_ATTESTER', attester: policy.attester });
    const ix = await building(() => buildAttestBacking({ attester: createNoopSigner(attester), mint, backingAtoms }));
    const supply = await mintSupply(d.account, mint);
    return send(reply, {
      ...(await tx(attester, [ix], 'attestation')),
      mint,
      backingAtoms,
      supply,
      coversNow: supply === null ? null : backingVerdict({ attestation: { backingAtoms, postedTs: now() }, supply, now: now(), minCoverageBps: policy.minCoverageBps, maxAgeSecs: policy.maxAgeSecs }) === 'Backed',
      requiredNow: supply === null ? null : backingRequired(supply, policy.minCoverageBps),
      release,
    });
  });

  app.post('/v1/tx/backing-check', async (req, reply) => {
    const b = obj(req.body);
    only(b, ['mint', 'payer'], 'backing-check');
    const mint = addr(b.mint, 'mint');
    const payer = addr(b.payer, 'payer');
    const release = await need('check', CHECK_DISCRIMINATOR as Uint8Array);
    const { policy, addresses } = await readPolicy(mint);
    const supply = await mintSupply(d.account, mint);
    if (supply === null) throw new RequestError(404, `mint ${mint} not found on chain`, { reason: 'MINT_NOT_FOUND' });
    const att = await readAttestation(mint, addresses.attestation);
    const verdict = backingVerdict({ attestation: att, supply, now: now(), minCoverageBps: policy.minCoverageBps, maxAgeSecs: policy.maxAgeSecs });
    if (verdict === 'Backed') throw new RequestError(409, 'The backing is fresh and covers the live supply: there is nothing to halt, and the program would refuse with Backed.', { reason: 'BACKED', verdict });
    const halt = await readHalt(addresses.halt);
    if (halt?.halted) throw new RequestError(409, `The asset is already halted (${REASON[halt.reason] ?? halt.reason} since ${halt.sinceTs}). Only a printing resume cross lifts the halt.`, { reason: 'ALREADY_HALTED', since: halt.sinceTs });
    const ix = await building(() => buildCheckBacking({ mint }));
    return send(reply, { ...(await tx(payer, [ix], 'check')), mint, verdict, willHalt: true, release });
  });

  app.get('/v1/assets/:mint/backing', async (req, reply) => {
    const mint = addr((req.params as { mint: string }).mint, 'mint');
    const release = await releaseNote(gate, 'crossBacking');
    const a = await backingAddresses(mint);
    const supply = await mintSupply(d.account, mint);
    const halt = await readHalt(a.halt);
    const watchdog = await watchdogAddress(mint);
    if (release.deployed === false) {
      return send(reply, { mint, optedIn: false, policy: null, attestation: null, supply, watchdog, halt: halt ? { halted: halt.halted, reason: REASON[halt.reason] ?? String(halt.reason) } : null, release, note: release.note });
    }
    const p = await readPolicy(mint).catch((e) => (e instanceof RequestError && e.detail?.reason === 'NO_POLICY' ? null : Promise.reject(e)));
    if (!p) return send(reply, { mint, optedIn: false, policy: null, attestation: null, supply, watchdog, halt: halt ? { halted: halt.halted, reason: REASON[halt.reason] ?? String(halt.reason) } : null, release, note: 'This asset has not opted in to a backing policy.' });
    const att = await readAttestation(mint, a.attestation);
    const t = now();
    const verdict = supply === null ? null : backingVerdict({ attestation: att, supply, now: t, minCoverageBps: p.policy.minCoverageBps, maxAgeSecs: p.policy.maxAgeSecs });
    return send(reply, {
      mint,
      optedIn: true,
      policy: { address: a.policy, attester: p.policy.attester, minCoverageBps: p.policy.minCoverageBps, maxAgeSecs: p.policy.maxAgeSecs },
      attestation: att ? { backingAtoms: att.backingAtoms, postedTs: att.postedTs, ageSecs: t - att.postedTs, freshUntil: att.postedTs + p.policy.maxAgeSecs } : null,
      supply,
      required: supply === null ? null : backingRequired(supply, p.policy.minCoverageBps),
      coverageBps: att && supply !== null && supply > 0n ? (att.backingAtoms * 10_000n) / supply : null,
      verdict,
      haltsOnNextCheck: verdict !== null && verdict !== 'Backed',
      watchdog,
      halt: halt ? { halted: halt.halted, reason: REASON[halt.reason] ?? String(halt.reason), sinceTs: halt.sinceTs, resumedBy: halt.lastResumeCross.__option === 'Some' ? halt.lastResumeCross.value : null } : null,
      haltReasons: { issuerPause: HaltReason.IssuerPause },
      release,
    });
  });

  app.get('/v1/backing/policies', async (req, reply) => {
    const release = await releaseNote(gate, 'crossBacking');
    const limit = (req.query as { limit?: string }).limit === undefined ? 100 : Math.min(500, Math.max(1, Number.parseInt((req.query as { limit: string }).limit, 10) || 100));
    const rows = d.db
      ? (await d.db.query(`SELECT p.*, a.backing_atoms, a.posted_ts FROM backing_policies p LEFT JOIN backing_attestations a ON a.mint = p.mint ORDER BY p.created_slot DESC LIMIT $1`, [limit])).rows
      : [];
    return send(reply, {
      policies: rows.map((r) => ({ mint: r.mint, policy: r.policy, attester: r.attester, minCoverageBps: Number(r.min_coverage_bps), maxAgeSecs: Number(r.max_age_secs), lastBackingAtoms: r.backing_atoms === null ? null : String(r.backing_atoms), lastPostedTs: r.posted_ts === null ? null : Number(r.posted_ts) })),
      release,
      ...(release.deployed === false && { note: release.note }),
    });
  });
}
