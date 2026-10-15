// cross_backing over HTTP with accounts injected in memory: the release gate, the opt-in conditions (the halt state's authority, the watchdog as venue signer), the verdict on a
// statement (missing, stale, short, backed) computed exactly as the program computes it, and the decoded transactions. The program is not run here
// (tests/core/test/backing.test.ts runs it against the real halt machinery).
import { describe, expect, it } from 'vitest';
import { none, some } from '@solana/kit';
import {
  ATTEST_DISCRIMINATOR,
  CHECK_DISCRIMINATOR,
  CREATE_POLICY_DISCRIMINATOR,
  getAttestInstructionDataDecoder,
  getAttestationEncoder,
  getCreatePolicyInstructionDataDecoder,
  getPolicyEncoder,
} from '@opening-cross/cross-backing-client';
import { CROSS_BACKING_PROGRAM_ADDRESS, CROSS_CORE_PROGRAM_ADDRESS, backingAddresses, getHaltStateEncoder, watchdogAddress } from '@opening-cross/sdk';
import { registerBackingTx } from '../src/routes/backing-tx.js';
import { type Db } from '../src/routes/programs-support.js';
import { Chain, NOW, caller, database, decode, key, ready, server, startsWith } from './helpers/wave3d.js';

async function fixture(o: { venueSigner?: 'watchdog' | 'other' | 'none'; policy?: boolean; halted?: boolean; attestation?: { backingAtoms: bigint; postedTs: number } | null; supply?: bigint; withHalt?: boolean } = {}) {
  const chain = new Chain();
  const [authority, attester, mint, stranger, other] = await Promise.all([key(), key(), key(), key(), key()]);
  chain.mint(mint, { decimals: 6, supply: o.supply ?? 1_000_000n });
  chain.deploy('crossBacking');
  const a = await backingAddresses(mint);
  const watchdog = await watchdogAddress(mint);
  const putHalt = (p: { halted?: boolean; venueSigner?: 'watchdog' | 'other' | 'none' } = {}) =>
    chain.put(
      a.halt,
      CROSS_CORE_PROGRAM_ADDRESS,
      getHaltStateEncoder().encode({
        baseMint: mint, authority, venueSigner: (p.venueSigner ?? o.venueSigner ?? 'watchdog') === 'watchdog' ? some(watchdog) : (p.venueSigner ?? o.venueSigner) === 'other' ? some(other) : none(), halted: p.halted ?? o.halted ?? false, reason: p.halted || o.halted ? 2 : 0,
        corporateAction: false, sinceTs: 5n, sinceSlot: 5n, issuerUnpaused: false, breaker: none(), lastResumeCross: none(), lastResumePrice: 0n, lastResumeTs: 0n, bump: 255,
      } as never),
    );
  if (o.withHalt !== false) putHalt();
  const putPolicy = () => chain.put(a.policy, CROSS_BACKING_PROGRAM_ADDRESS, getPolicyEncoder().encode({ mint, attester, minCoverageBps: 10_000, maxAgeSecs: 3_600n, bump: 255 }));
  const putAttestation = (x: { backingAtoms: bigint; postedTs: number }) => chain.put(a.attestation, CROSS_BACKING_PROGRAM_ADDRESS, getAttestationEncoder().encode({ mint, backingAtoms: x.backingAtoms, postedTs: BigInt(x.postedTs), bump: 255 }));
  if (o.policy !== false) putPolicy();
  if (o.attestation) putAttestation(o.attestation);
  const app = server();
  registerBackingTx(app, { account: chain.account, lifetime: chain.lifetime, clock: () => NOW, gate: ready });
  return { chain, authority, attester, mint, stranger, other, a, watchdog, putHalt, putPolicy, putAttestation, app, ...caller(app) };
}
const programIxs = (tx: string) => decode(tx).filter((i) => i.programAddress === CROSS_BACKING_PROGRAM_ADDRESS);

describe('cross_backing', () => {
  it('refuses every route when the program is not on the cluster, and the reads say so', async () => {
    const f = await fixture();
    const app = server();
    const absent = new Chain();
    absent.mint(f.mint, { supply: 5n });
    registerBackingTx(app, { account: absent.account, lifetime: absent.lifetime, clock: () => NOW, db: (await database()).db as Db });
    const c = caller(app);
    for (const [route, body] of [
      ['backing-init-halt-state', { authority: f.authority, baseMint: f.mint }],
      ['backing-create-policy', { authority: f.authority, mint: f.mint, attester: f.attester, minCoverageBps: 10_000, maxAgeSecs: 3600 }],
      ['backing-attest', { attester: f.attester, mint: f.mint, backingAtoms: '1' }],
      ['backing-check', { mint: f.mint, payer: f.stranger }],
    ] as [string, Record<string, unknown>][]) {
      const r = await c.post(`/v1/tx/${route}`, body);
      expect(r.status, route).toBe(409);
      expect(r.body.reason, route).toBe('PROGRAM_NOT_DEPLOYED');
    }
    const read = await c.get(`/v1/assets/${f.mint}/backing`);
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ optedIn: false, supply: '5', release: { deployed: false } });
    expect((await c.get('/v1/backing/policies')).body).toMatchObject({ policies: [], release: { deployed: false } });
  }, 30_000);

  it('creates a halt state that names the watchdog, once; an existing one with another venue signer cannot use it', async () => {
    const f = await fixture({ withHalt: false, policy: false });
    const ok = await f.post('/v1/tx/backing-init-halt-state', { authority: f.authority, baseMint: f.mint });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toMatchObject({ halt: f.a.halt, watchdog: f.watchdog, next: 'backing-create-policy' });
    expect(programIxs(ok.body.transaction)).toHaveLength(0); // the instruction is cross_core's init_halt_state
    const core = decode(ok.body.transaction).filter((i) => i.programAddress === CROSS_CORE_PROGRAM_ADDRESS);
    expect(core).toHaveLength(1);
    expect(core[0]!.accounts!.map((x) => x.address)).toEqual(expect.arrayContaining([f.authority, f.a.halt, f.mint]));
    expect(Buffer.from(core[0]!.data!).includes(Buffer.from(await import('@solana/kit').then((k) => k.getAddressEncoder().encode(f.watchdog))))).toBe(true);
    f.putHalt({ venueSigner: 'other' });
    const clash = await f.post('/v1/tx/backing-init-halt-state', { authority: f.authority, baseMint: f.mint });
    expect(clash.status).toBe(409);
    expect(clash.body).toMatchObject({ reason: 'HALT_STATE_EXISTS', venueSigner: f.other, watchdog: f.watchdog });
    f.putHalt({ venueSigner: 'none' });
    expect((await f.post('/v1/tx/backing-init-halt-state', { authority: f.authority, baseMint: f.mint })).body.error).toMatch(/no venue signer/);
    f.putHalt({ venueSigner: 'watchdog' });
    expect((await f.post('/v1/tx/backing-init-halt-state', { authority: f.authority, baseMint: f.mint })).body.error).toMatch(/already has a halt state that names the watchdog/);
  });

  it('opts an asset in only for the halt state\'s authority, with the watchdog as venue signer, with valid terms, once', async () => {
    const f = await fixture({ policy: false });
    const ok = await f.post('/v1/tx/backing-create-policy', { authority: f.authority, mint: f.mint, attester: f.attester, minCoverageBps: 10_000, maxAgeSecs: 3600 });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toMatchObject({ policy: f.a.policy, watchdog: f.watchdog, halt: f.a.halt, requiredNow: '1000000' });
    const ix = programIxs(ok.body.transaction)[0]!;
    expect(startsWith(ix, CREATE_POLICY_DISCRIMINATOR)).toBe(true);
    expect(getCreatePolicyInstructionDataDecoder().decode(ix.data!)).toMatchObject({ attester: f.attester, minCoverageBps: 10_000, maxAgeSecs: 3600n });
    const body = (patch: Record<string, unknown>) => ({ authority: f.authority, mint: f.mint, attester: f.attester, minCoverageBps: 10_000, maxAgeSecs: 3600, ...patch });
    expect((await f.post('/v1/tx/backing-create-policy', body({ authority: f.stranger }))).body).toMatchObject({ reason: 'NOT_THE_AUTHORITY', authority: f.authority });
    for (const patch of [{ minCoverageBps: 99 }, { minCoverageBps: 20_001 }, { maxAgeSecs: 59 }, { maxAgeSecs: 30 * 86_400 + 1 }]) expect((await f.post('/v1/tx/backing-create-policy', body(patch))).body.reason, JSON.stringify(patch)).toBe('BAD_POLICY');
    expect((await f.post('/v1/tx/backing-create-policy', body({ minCoverageBps: 100, maxAgeSecs: 60 }))).status).toBe(200);
    expect((await f.post('/v1/tx/backing-create-policy', body({ minCoverageBps: 20_000, maxAgeSecs: 30 * 86_400 }))).status).toBe(200);
    f.putHalt({ venueSigner: 'other' });
    expect((await f.post('/v1/tx/backing-create-policy', body({}))).body).toMatchObject({ reason: 'WATCHDOG_NOT_VENUE_SIGNER', venueSigner: f.other });
    f.putPolicy();
    f.putHalt({ venueSigner: 'watchdog' });
    expect((await f.post('/v1/tx/backing-create-policy', body({}))).body.reason).toBe('ALREADY_EXISTS');
    const bare = await fixture({ withHalt: false, policy: false });
    expect((await bare.post('/v1/tx/backing-create-policy', { authority: bare.authority, mint: bare.mint, attester: bare.attester, minCoverageBps: 10_000, maxAgeSecs: 3600 })).body.reason).toBe('NO_HALT_STATE');
  });

  it('attests for the policy\'s attester only, and says whether the statement covers the supply now', async () => {
    const f = await fixture();
    const ok = await f.post('/v1/tx/backing-attest', { attester: f.attester, mint: f.mint, backingAtoms: '1000000' });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ coversNow: true, requiredNow: '1000000', supply: '1000000' });
    const ix = programIxs(ok.body.transaction)[0]!;
    expect(startsWith(ix, ATTEST_DISCRIMINATOR)).toBe(true);
    expect(getAttestInstructionDataDecoder().decode(ix.data!).backingAtoms).toBe(1_000_000n);
    expect((await f.post('/v1/tx/backing-attest', { attester: f.attester, mint: f.mint, backingAtoms: '999999' })).body.coversNow).toBe(false);
    expect((await f.post('/v1/tx/backing-attest', { attester: f.stranger, mint: f.mint, backingAtoms: '1' })).body).toMatchObject({ reason: 'NOT_THE_ATTESTER', attester: f.attester });
    const none_ = await fixture({ policy: false });
    expect((await none_.post('/v1/tx/backing-attest', { attester: none_.attester, mint: none_.mint, backingAtoms: '1' })).body.reason).toBe('NO_POLICY');
  });

  it('halts on anyone\'s call exactly when the program would: missing, stale one second past the age, one atom short; and refuses when backed', async () => {
    const check = (f: Awaited<ReturnType<typeof fixture>>) => f.post('/v1/tx/backing-check', { mint: f.mint, payer: f.stranger });
    // missing
    const missing = await fixture();
    const m = await check(missing);
    expect(m.status, JSON.stringify(m.body)).toBe(200);
    expect(m.body).toMatchObject({ verdict: 'Missing', willHalt: true });
    const ix = programIxs(m.body.transaction)[0]!;
    expect(startsWith(ix, CHECK_DISCRIMINATOR)).toBe(true);
    expect(ix.accounts!.map((x) => x.address)).toEqual(expect.arrayContaining([missing.a.policy, missing.mint, missing.a.attestation, missing.watchdog, missing.a.halt]));
    expect(m.body.signers).toEqual([missing.stranger]);
    // stale: at the age is fine, one second past is not (the program: 0 <= age <= max_age)
    const atAge = await fixture({ attestation: { backingAtoms: 1_000_000n, postedTs: NOW - 3_600 } });
    expect((await check(atAge)).body.reason).toBe('BACKED');
    const stale = await fixture({ attestation: { backingAtoms: 1_000_000n, postedTs: NOW - 3_601 } });
    expect((await check(stale)).body.verdict).toBe('Stale');
    // a statement dated in the future says nothing about now
    const future = await fixture({ attestation: { backingAtoms: 1_000_000n, postedTs: NOW + 1 } });
    expect((await check(future)).body.verdict).toBe('Stale');
    // short by one atom, then covered again by one more atom of backing
    const short = await fixture({ attestation: { backingAtoms: 999_999n, postedTs: NOW - 10 } });
    expect((await check(short)).body.verdict).toBe('Short');
    short.putAttestation({ backingAtoms: 1_000_000n, postedTs: NOW - 10 });
    expect((await check(short)).body.reason).toBe('BACKED');
    // one atom of new supply and it is short again (the live supply, not the supply at the statement)
    short.chain.setSupply(short.mint, 1_000_001n);
    expect((await check(short)).body.verdict).toBe('Short');
    // already halted: nothing to do
    short.putHalt({ halted: true });
    expect((await check(short)).body.reason).toBe('ALREADY_HALTED');
    const noPolicy = await fixture({ policy: false });
    expect((await check(noPolicy)).body.reason).toBe('NO_POLICY');
  });

  it('reads an asset: the policy, the statement, the live supply, the verdict now, the halt state', async () => {
    const f = await fixture({ attestation: { backingAtoms: 1_500_000n, postedTs: NOW - 600 } });
    const r = await f.get(`/v1/assets/${f.mint}/backing`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      optedIn: true,
      policy: { attester: f.attester, minCoverageBps: 10_000, maxAgeSecs: '3600' },
      attestation: { backingAtoms: '1500000', postedTs: String(NOW - 600), ageSecs: '600', freshUntil: String(NOW - 600 + 3600) },
      supply: '1000000',
      required: '1000000',
      coverageBps: '15000',
      verdict: 'Backed',
      haltsOnNextCheck: false,
      halt: { halted: false },
    });
    f.putAttestation({ backingAtoms: 1_500_000n, postedTs: NOW - 4_000 });
    expect((await f.get(`/v1/assets/${f.mint}/backing`)).body).toMatchObject({ verdict: 'Stale', haltsOnNextCheck: true });
    const noPolicy = await fixture({ policy: false });
    const none_ = await noPolicy.get(`/v1/assets/${noPolicy.mint}/backing`);
    expect(none_.body).toMatchObject({ optedIn: false, watchdog: noPolicy.watchdog });
    expect(none_.body.note).toMatch(/not opted in/);
    const bare = await fixture({ withHalt: false, policy: false });
    expect((await bare.get(`/v1/assets/${bare.mint}/backing`)).body.halt).toBeNull();
  });

  it('lists the opted-in assets from the index with their last statement', async () => {
    const f = await fixture();
    const { db, pg } = await database();
    const app = server();
    registerBackingTx(app, { account: f.chain.account, lifetime: f.chain.lifetime, clock: () => NOW, gate: ready, db: db as Db });
    await pg.query(`INSERT INTO backing_policies (policy, mint, attester, min_coverage_bps, max_age_secs, created_slot) VALUES ($1,$2,$3,10000,3600,1)`, [f.a.policy, f.mint, f.attester]);
    await pg.query(`INSERT INTO backing_attestations (mint, attester, backing_atoms, posted_ts, slot) VALUES ($1,$2,1500000,$3,2)`, [f.mint, f.attester, NOW - 5]);
    expect((await caller(app).get('/v1/backing/policies')).body.policies).toEqual([{ mint: f.mint, policy: f.a.policy, attester: f.attester, minCoverageBps: 10_000, maxAgeSecs: 3600, lastBackingAtoms: '1500000', lastPostedTs: NOW - 5 }]);
  }, 30_000);
});
