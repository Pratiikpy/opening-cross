// cross_bounty over HTTP with accounts injected in memory: the release gate, the terms the program refuses, the claim logic (which invariants a cross account breaks, which the
// bounty covers and has paid), the arbiter's award and the sponsor's withdrawal after the expiry. The program is not run here (tests/core/test/bounty.test.ts runs it, with the
// invariants checked against 300 randomized honest crosses).
import { describe, expect, it } from 'vitest';
import {
  AWARD_DISCRIMINATOR,
  CLAIM_INVARIANT_DISCRIMINATOR,
  CREATE_BOUNTY_DISCRIMINATOR,
  FUND_DISCRIMINATOR,
  WITHDRAW_DISCRIMINATOR,
  findBountyPda,
  getAwardInstructionDataDecoder,
  getBountyEncoder,
  getClaimInvariantInstructionDataDecoder,
  getCreateBountyInstructionDataDecoder,
} from '@opening-cross/cross-bounty-client';
import { BOUNTY_INVARIANT_NAMES, CROSS_BOUNTY_PROGRAM_ADDRESS, CrossState, ata, bountyAddresses } from '@opening-cross/sdk';
import { registerBountyTx } from '../src/routes/bounty-tx.js';
import { type Db } from '../src/routes/programs-support.js';
import { Chain, NOW, SPL, caller, database, decode, key, ready, server, startsWith } from './helpers/wave3d.js';

const DAY = 86_400;
const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const REWARDS = [10n, 20n, 30n, 0n, 50n, 60n, 70n, 80n, 90n, 100n, 110n];

async function fixture(o: { expiresAt?: number; paidMask?: number; pool?: bigint } = {}) {
  const chain = new Chain();
  const [sponsor, arbiter, hunter, rewardMint, quote, stranger] = await Promise.all([key(), key(), key(), key(), key(), key()]);
  chain.mint(rewardMint, { decimals: 6 });
  chain.mint(quote, { decimals: 6 });
  chain.deploy('crossBounty');
  const bounty = (await findBountyPda({ sponsor, id: 0n }))[0];
  const { vault } = await bountyAddresses(sponsor, 0n, rewardMint, SPL);
  const put = (p: { expiresAt?: number; paidMask?: number } = {}) =>
    chain.put(bounty, CROSS_BOUNTY_PROGRAM_ADDRESS, getBountyEncoder().encode({ sponsor, id: 0n, arbiter, rewardMint, tokenProgram: SPL, expiresAt: BigInt(p.expiresAt ?? o.expiresAt ?? NOW + 60 * DAY), rewards: REWARDS, paidMask: p.paidMask ?? o.paidMask ?? 0, awarded: 0n, bump: 1 }));
  put();
  chain.tokenAt(vault, bounty, rewardMint, o.pool ?? 1_000n);
  await chain.token(sponsor, rewardMint, 5_000n);
  await chain.token(stranger, rewardMint, 700n);
  const app = server();
  registerBountyTx(app, { account: chain.account, lifetime: chain.lifetime, clock: () => NOW, gate: ready });
  return { chain, sponsor, arbiter, hunter, rewardMint, quote, stranger, bounty, vault, put, app, ...caller(app) };
}
const programIxs = (tx: string) => decode(tx).filter((i) => i.programAddress === CROSS_BOUNTY_PROGRAM_ADDRESS);

describe('cross_bounty', () => {
  it('refuses every route when the program is not on the cluster, and the reads say so', async () => {
    const f = await fixture();
    const app = server();
    const absent = new Chain();
    registerBountyTx(app, { account: absent.account, lifetime: absent.lifetime, clock: () => NOW, db: (await database()).db as Db });
    const c = caller(app);
    const cross = f.bounty;
    for (const [route, body] of [
      ['bounty-create', { sponsor: f.sponsor, rewardMint: f.rewardMint, arbiter: f.arbiter, expiresAt: NOW + 60 * DAY, rewards: REWARDS.map(String) }],
      ['bounty-fund', { funder: f.sponsor, bounty: f.bounty, amount: '1' }],
      ['bounty-claim-invariant', { claimant: f.hunter, bounty: f.bounty, cross }],
      ['bounty-award', { arbiter: f.arbiter, bounty: f.bounty, hunter: f.hunter, amount: '1', evidence: '00'.repeat(32) }],
      ['bounty-withdraw', { sponsor: f.sponsor, bounty: f.bounty }],
    ] as [string, Record<string, unknown>][]) {
      const r = await c.post(`/v1/tx/${route}`, body);
      expect(r.status, route).toBe(409);
      expect(r.body.reason, route).toBe('PROGRAM_NOT_DEPLOYED');
    }
    expect((await c.get(`/v1/bounties/${f.bounty}`)).body.reason).toBe('PROGRAM_NOT_DEPLOYED');
    expect((await c.get('/v1/bounties')).body).toMatchObject({ bounties: [], release: { deployed: false } });
  }, 30_000);

  it('creates a bounty: eleven rewards, a pool committed for thirty days, the next free id', async () => {
    const f = await fixture();
    const ok = await f.post('/v1/tx/bounty-create', { sponsor: f.sponsor, rewardMint: f.rewardMint, arbiter: f.arbiter, expiresAt: NOW + 30 * DAY, rewards: REWARDS.map(String) });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const a = await bountyAddresses(f.sponsor, 1n, f.rewardMint, SPL);
    expect(ok.body).toMatchObject({ bounty: a.bounty, vault: a.vault, id: '1' });
    const ix = programIxs(ok.body.transaction)[0]!;
    expect(startsWith(ix, CREATE_BOUNTY_DISCRIMINATOR)).toBe(true);
    expect(getCreateBountyInstructionDataDecoder().decode(ix.data!)).toMatchObject({ id: 1n, arbiter: f.arbiter, expiresAt: BigInt(NOW + 30 * DAY), rewards: REWARDS });
    const bad = (patch: Record<string, unknown>) => f.post('/v1/tx/bounty-create', { sponsor: f.sponsor, rewardMint: f.rewardMint, arbiter: f.arbiter, expiresAt: NOW + 30 * DAY, rewards: REWARDS.map(String), ...patch });
    expect((await bad({ expiresAt: NOW + 30 * DAY - 1 })).body.reason).toBe('COMMITMENT_TOO_SHORT');
    expect((await bad({ rewards: ['1', '2'] })).body.reason).toBe('BAD_REWARDS');
    expect((await bad({ id: 0 })).body.reason).toBe('ALREADY_EXISTS');
    expect((await bad({ rewards: ['x'] })).status).toBe(400);
    expect((await bad({ rewardMint: await key() })).body.reason).toBe('MINT_NOT_FOUND');
  });

  it('funds from anyone with a balance', async () => {
    const f = await fixture();
    const ok = await f.post('/v1/tx/bounty-fund', { funder: f.stranger, bounty: f.bounty, amount: '700' });
    expect(ok.status).toBe(200);
    expect(startsWith(programIxs(ok.body.transaction)[0]!, FUND_DISCRIMINATOR)).toBe(true);
    expect((await f.post('/v1/tx/bounty-fund', { funder: f.stranger, bounty: f.bounty, amount: '701' })).body).toMatchObject({ reason: 'INSUFFICIENT_BALANCE', have: '700' });
    expect((await f.post('/v1/tx/bounty-fund', { funder: f.stranger, bounty: f.bounty, amount: '0' })).body.reason).toBe('NOTHING_TO_DO');
  });

  it('pays a claim only for an invariant the cross account breaks, the bounty covers, has not paid and has the pool for', async () => {
    const f = await fixture();
    // invariant 0: more orders open than were ever placed
    const broken = await f.chain.cross({ creator: f.sponsor, id: 5n, quoteMint: f.quote, ordersTotal: 1, ordersOpen: 3 });
    const ok = await f.post('/v1/tx/bounty-claim-invariant', { claimant: f.hunter, bounty: f.bounty, cross: broken, invariant: 0 });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toMatchObject({ invariant: 0, invariantName: BOUNTY_INVARIANT_NAMES[0], pays: '10' });
    const ixs = decode(ok.body.transaction);
    expect(ixs.some((i) => i.programAddress === ATA_PROGRAM)).toBe(true); // the claimant's reward account
    const claim = programIxs(ok.body.transaction)[0]!;
    expect(startsWith(claim, CLAIM_INVARIANT_DISCRIMINATOR)).toBe(true);
    expect(getClaimInvariantInstructionDataDecoder().decode(claim.data!).invariant).toBe(0);
    expect(claim.accounts!.map((a) => a.address)).toEqual(expect.arrayContaining([f.hunter, f.bounty, broken, f.vault, await ata(f.hunter, f.rewardMint, SPL)]));
    // without an invariant: the first broken one the bounty covers
    expect((await f.post('/v1/tx/bounty-claim-invariant', { claimant: f.hunter, bounty: f.bounty, cross: broken })).body.invariant).toBe(0);
    // an honest cross breaks nothing
    const honest = await f.chain.cross({ creator: f.sponsor, id: 6n, quoteMint: f.quote, ordersTotal: 3, ordersOpen: 1 });
    expect((await f.post('/v1/tx/bounty-claim-invariant', { claimant: f.hunter, bounty: f.bounty, cross: honest })).body.reason).toBe('NO_VIOLATION');
    expect((await f.post('/v1/tx/bounty-claim-invariant', { claimant: f.hunter, bounty: f.bounty, cross: honest, invariant: 0 })).body).toMatchObject({ reason: 'NO_VIOLATION', broken: [] });
    // the cross breaks invariant 0 but the claim names 2
    expect((await f.post('/v1/tx/bounty-claim-invariant', { claimant: f.hunter, bounty: f.bounty, cross: broken, invariant: 2 })).body.reason).toBe('NO_VIOLATION');
    // not covered (invariant 3 pays nothing), unknown, already paid, expired, empty pool
    const noPrint = await f.chain.cross({ creator: f.sponsor, id: 7n, quoteMint: f.quote, state: CrossState.NoPrint });
    expect((await f.post('/v1/tx/bounty-claim-invariant', { claimant: f.hunter, bounty: f.bounty, cross: noPrint, invariant: 3 })).body.reason).toBe('NOT_COVERED');
    expect((await f.post('/v1/tx/bounty-claim-invariant', { claimant: f.hunter, bounty: f.bounty, cross: noPrint, invariant: 11 })).body.reason).toBe('UNKNOWN_INVARIANT');
    expect((await f.post('/v1/tx/bounty-claim-invariant', { claimant: f.hunter, bounty: f.bounty, cross: noPrint })).body.invariant).toBe(2);
    f.put({ paidMask: 1 << 2 });
    expect((await f.post('/v1/tx/bounty-claim-invariant', { claimant: f.hunter, bounty: f.bounty, cross: noPrint, invariant: 2 })).body.reason).toBe('ALREADY_PAID');
    expect((await f.post('/v1/tx/bounty-claim-invariant', { claimant: f.hunter, bounty: f.bounty, cross: noPrint })).body.reason).toBe('NO_VIOLATION');
    f.put({ paidMask: 0, expiresAt: NOW });
    expect((await f.post('/v1/tx/bounty-claim-invariant', { claimant: f.hunter, bounty: f.bounty, cross: noPrint, invariant: 2 })).body.reason).toBe('EXPIRED');
    f.put();
    f.chain.tokenAt(f.vault, f.bounty, f.rewardMint, 0n);
    expect((await f.post('/v1/tx/bounty-claim-invariant', { claimant: f.hunter, bounty: f.bounty, cross: noPrint, invariant: 2 })).body.reason).toBe('POOL_EMPTY');
    // a reward larger than the pool pays what the pool holds
    f.chain.tokenAt(f.vault, f.bounty, f.rewardMint, 25n);
    expect((await f.post('/v1/tx/bounty-claim-invariant', { claimant: f.hunter, bounty: f.bounty, cross: noPrint, invariant: 2 })).body.pays).toBe('25');
    // the bounty's own account is not a cross
    expect((await f.post('/v1/tx/bounty-claim-invariant', { claimant: f.hunter, bounty: f.bounty, cross: f.bounty })).status).toBe(404);
  });

  it('awards by the arbiter before the expiry, capped by the pool', async () => {
    const f = await fixture();
    const ok = await f.post('/v1/tx/bounty-award', { arbiter: f.arbiter, bounty: f.bounty, hunter: f.hunter, amount: '300', evidence: 'ab'.repeat(32) });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const ix = programIxs(ok.body.transaction)[0]!;
    expect(startsWith(ix, AWARD_DISCRIMINATOR)).toBe(true);
    expect(getAwardInstructionDataDecoder().decode(ix.data!)).toMatchObject({ amount: 300n });
    expect(Buffer.from(getAwardInstructionDataDecoder().decode(ix.data!).evidence).toString('hex')).toBe('ab'.repeat(32));
    expect((await f.post('/v1/tx/bounty-award', { arbiter: f.sponsor, bounty: f.bounty, hunter: f.hunter, amount: '1', evidence: 'ab'.repeat(32) })).body).toMatchObject({ reason: 'NOT_THE_ARBITER', arbiter: f.arbiter });
    expect((await f.post('/v1/tx/bounty-award', { arbiter: f.arbiter, bounty: f.bounty, hunter: f.hunter, amount: '1001', evidence: 'ab'.repeat(32) })).body.reason).toBe('OVER_POOL');
    expect((await f.post('/v1/tx/bounty-award', { arbiter: f.arbiter, bounty: f.bounty, hunter: f.hunter, amount: '0', evidence: 'ab'.repeat(32) })).body.reason).toBe('NOTHING_TO_DO');
    expect((await f.post('/v1/tx/bounty-award', { arbiter: f.arbiter, bounty: f.bounty, hunter: f.hunter, amount: '1', evidence: 'ab' })).status).toBe(400);
    f.put({ expiresAt: NOW });
    expect((await f.post('/v1/tx/bounty-award', { arbiter: f.arbiter, bounty: f.bounty, hunter: f.hunter, amount: '1', evidence: 'ab'.repeat(32) })).body.reason).toBe('EXPIRED');
  });

  it('lets the sponsor withdraw only from the expiry on, and nobody else ever', async () => {
    const f = await fixture();
    const early = await f.post('/v1/tx/bounty-withdraw', { sponsor: f.sponsor, bounty: f.bounty });
    expect(early.status).toBe(409);
    expect(early.body).toMatchObject({ reason: 'STILL_COMMITTED', expiresAt: String(NOW + 60 * DAY), secondsLeft: String(60 * DAY) });
    f.put({ expiresAt: NOW - 1 });
    const ok = await f.post('/v1/tx/bounty-withdraw', { sponsor: f.sponsor, bounty: f.bounty });
    expect(ok.status).toBe(200);
    expect(ok.body.amount).toBe('1000');
    expect(startsWith(programIxs(ok.body.transaction)[0]!, WITHDRAW_DISCRIMINATOR)).toBe(true);
    expect((await f.post('/v1/tx/bounty-withdraw', { sponsor: f.stranger, bounty: f.bounty })).body).toMatchObject({ reason: 'NOT_THE_SPONSOR', sponsor: f.sponsor });
    expect((await f.post('/v1/tx/bounty-withdraw', { sponsor: f.sponsor, bounty: f.bounty, amount: '1001' })).body.reason).toBe('OVER_POOL');
    f.chain.tokenAt(f.vault, f.bounty, f.rewardMint, 0n);
    expect((await f.post('/v1/tx/bounty-withdraw', { sponsor: f.sponsor, bounty: f.bounty })).body.reason).toBe('POOL_EMPTY');
  });

  it('reads a bounty and the invariants a cross breaks, from chain; and the index and the payouts', async () => {
    const f = await fixture({ paidMask: 1 << 1 });
    const r = await f.get(`/v1/bounties/${f.bounty}`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ bounty: f.bounty, sponsor: f.sponsor, pool: '1000', status: 'open', paidMask: 2 });
    expect(r.body.invariants).toHaveLength(11);
    expect(r.body.invariants[1]).toMatchObject({ invariant: 1, reward: '20', covered: true, paid: true });
    expect(r.body.invariants[3]).toMatchObject({ covered: false, paid: false });
    f.put({ expiresAt: NOW - 1 });
    expect((await f.get(`/v1/bounties/${f.bounty}`)).body.status).toBe('expired');
    f.chain.tokenAt(f.vault, f.bounty, f.rewardMint, 0n);
    f.put();
    expect((await f.get(`/v1/bounties/${f.bounty}`)).body.status).toBe('empty');
    const broken = await f.chain.cross({ creator: f.sponsor, id: 5n, quoteMint: f.quote, ordersTotal: 1, ordersOpen: 3 });
    expect((await f.get(`/v1/crosses/${broken}/invariants`)).body).toMatchObject({ honest: false, broken: [{ invariant: 0, name: BOUNTY_INVARIANT_NAMES[0] }] });
    const honest = await f.chain.cross({ creator: f.sponsor, id: 6n, quoteMint: f.quote });
    expect((await f.get(`/v1/crosses/${honest}/invariants`)).body).toMatchObject({ honest: true, broken: [], checked: 11 });
    expect((await f.get(`/v1/bounties/${f.vault}`)).status).toBe(404);
    const { db, pg } = await database();
    const app = server();
    registerBountyTx(app, { account: f.chain.account, lifetime: f.chain.lifetime, clock: () => NOW, gate: ready, db: db as Db });
    const c = caller(app);
    await pg.query(`INSERT INTO bounties (address, sponsor, arbiter, reward_mint, expires_at, rewards, funded, paid, paid_mask, created_slot, updated_slot) VALUES ($1,$2,$3,$4,$5,$6,1000,10,1,1,1)`, [f.bounty, f.sponsor, f.arbiter, f.rewardMint, NOW + 5, JSON.stringify(REWARDS.map(String))]);
    await pg.query(`INSERT INTO bounty_payouts (bounty, seq_key, kind, invariant, cross_address, recipient, amount, slot) VALUES ($1,'s:0','invariant',0,$2,$3,10,5), ($1,'s:1','award',null,null,$3,300,6)`, [f.bounty, broken, f.hunter]);
    expect((await c.get(`/v1/bounties?sponsor=${f.sponsor}`)).body.bounties[0]).toMatchObject({ bounty: f.bounty, status: 'open', paid: '10', paidMask: 1 });
    const payouts = (await c.get(`/v1/bounties/${f.bounty}/payouts`)).body.payouts;
    expect(payouts.map((p: { kind: string }) => p.kind)).toEqual(['award', 'invariant']);
    expect(payouts[1]).toMatchObject({ invariant: 0, invariantName: BOUNTY_INVARIANT_NAMES[0], cross: broken, amount: '10' });
  }, 30_000);
});
