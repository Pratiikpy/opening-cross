// cross_conviction over HTTP with accounts injected in memory: the release gate, the refusals that come before a transaction (balance, lock time, who holds the lock,
// what was already done) and every built transaction decoded back to its instructions. The program is not run here (tests/core/test/conviction.test.ts runs it).
import { describe, expect, it } from 'vitest';
import { type Address } from '@solana/kit';
import {
  CLAIM_BADGE_DISCRIMINATOR,
  CLOSE_LOCK_DISCRIMINATOR,
  INIT_BADGE_DISCRIMINATOR,
  LOCK_TOKENS_DISCRIMINATOR,
  UNLOCK_DISCRIMINATOR,
  findLockPda,
  getLockEncoder,
  getLockTokensInstructionDataDecoder,
} from '@opening-cross/cross-conviction-client';
import { CROSS_CONVICTION_PROGRAM_ADDRESS, ata, convictionAddresses, convictionBadgeAddresses } from '@opening-cross/sdk';
import { registerConvictionTx } from '../src/routes/conviction-tx.js';
import { type Db } from '../src/routes/programs-support.js';
import { Chain, NOW, SPL, caller, database, decode, key, ready, server, startsWith } from './helpers/wave3d.js';

const DAY = 86_400;

async function fixture(lock: Partial<{ amount: bigint; lockedAt: number; unlockTs: number; withdrawn: boolean; badgeClaimed: boolean; holder: Address }> = {}) {
  const chain = new Chain();
  const [holder, mint, stranger] = await Promise.all([key(), key(), key()]);
  chain.mint(mint, { decimals: 6, supply: 1_000_000_000_000n });
  chain.deploy('crossConviction');
  await chain.token(holder, mint, 500_000_000n);
  const lockAddress = (await findLockPda({ holder, mint, nonce: 0n }))[0];
  const put = (o: typeof lock = {}) =>
    chain.put(
      lockAddress,
      CROSS_CONVICTION_PROGRAM_ADDRESS,
      getLockEncoder().encode({ holder: o.holder ?? holder, mint, nonce: 0n, amount: o.amount ?? 100_000_000n, decimals: 6, lockedAt: BigInt(o.lockedAt ?? NOW - 40 * DAY), unlockTs: BigInt(o.unlockTs ?? NOW - 10 * DAY), withdrawn: o.withdrawn ?? false, badgeClaimed: o.badgeClaimed ?? false, bump: 1 }),
    );
  put({ ...lock });
  const app = server();
  registerConvictionTx(app, { account: chain.account, lifetime: chain.lifetime, clock: () => NOW, gate: ready });
  return { chain, holder, mint, stranger, lockAddress, put, app, ...caller(app) };
}
const programIxs = (tx: string) => decode(tx).filter((i) => i.programAddress === CROSS_CONVICTION_PROGRAM_ADDRESS);

describe('cross_conviction', () => {
  it('refuses every route when the program is not on the cluster, and the reads say so', async () => {
    const f = await fixture();
    const app = server();
    const absent = new Chain();
    registerConvictionTx(app, { account: absent.account, lifetime: absent.lifetime, clock: () => NOW, db: (await database()).db as Db });
    const c = caller(app);
    for (const [route, body] of [
      ['conviction-lock', { holder: f.holder, mint: f.mint, amount: '1', unlockTs: NOW + 2 * DAY }],
      ['conviction-unlock', { holder: f.holder, lock: f.lockAddress }],
      ['conviction-claim-badge', { holder: f.holder, lock: f.lockAddress }],
      ['conviction-close-lock', { holder: f.holder, lock: f.lockAddress }],
    ] as [string, Record<string, unknown>][]) {
      const r = await c.post(`/v1/tx/${route}`, body);
      expect(r.status, route).toBe(409);
      expect(r.body.reason, route).toBe('PROGRAM_NOT_DEPLOYED');
    }
    expect((await c.get(`/v1/conviction/locks/${f.lockAddress}`)).body.reason).toBe('PROGRAM_NOT_DEPLOYED');
    const mine = await c.get(`/v1/owners/${f.holder}/conviction`);
    expect(mine.status).toBe(200);
    expect(mine.body).toMatchObject({ locks: [], badges: [], release: { deployed: false } });
  }, 30_000);

  it('locks tokens: the first free nonce, the amount and the unlock time in the instruction, the token-days promised', async () => {
    const f = await fixture();
    const r = await f.post('/v1/tx/conviction-lock', { holder: f.holder, mint: f.mint, amount: '100000000', unlockTs: NOW + 30 * DAY });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const a = await convictionAddresses(f.holder, f.mint, 1n, SPL); // nonce 0 is taken in the fixture
    expect(r.body).toMatchObject({ nonce: '1', lock: a.lock, vault: a.vault, lockedFor: String(30 * DAY), tokenDays: '3000' });
    expect(r.body.signers).toEqual([f.holder]);
    const ix = programIxs(r.body.transaction)[0]!;
    expect(startsWith(ix, LOCK_TOKENS_DISCRIMINATOR)).toBe(true);
    expect(getLockTokensInstructionDataDecoder().decode(ix.data!)).toMatchObject({ nonce: 1n, amount: 100_000_000n, unlockTs: BigInt(NOW + 30 * DAY) });
    expect(ix.accounts!.map((x) => x.address)).toEqual(expect.arrayContaining([f.holder, f.mint, await ata(f.holder, f.mint, SPL), a.lock, a.vault]));
  });

  it('refuses a lock under a day or over four years, a zero amount, a balance it cannot cover, a used nonce and a missing token account', async () => {
    const f = await fixture();
    const lock = (patch: Record<string, unknown>) => f.post('/v1/tx/conviction-lock', { holder: f.holder, mint: f.mint, amount: '1000', unlockTs: NOW + 2 * DAY, ...patch });
    expect((await lock({ unlockTs: NOW + DAY - 1 })).body).toMatchObject({ reason: 'BAD_UNLOCK_TIME' });
    expect((await lock({ unlockTs: NOW + DAY })).status).toBe(200);
    expect((await lock({ unlockTs: NOW + 4 * 365 * DAY })).status).toBe(200);
    expect((await lock({ unlockTs: NOW + 4 * 365 * DAY + 1 })).body.reason).toBe('BAD_UNLOCK_TIME');
    expect((await lock({ amount: '0' })).body.reason).toBe('NOTHING_TO_LOCK');
    expect((await lock({ amount: '500000001' })).body).toMatchObject({ reason: 'INSUFFICIENT_BALANCE', have: '500000000' });
    expect((await lock({ nonce: '0' })).body.reason).toBe('NONCE_USED');
    expect((await f.post('/v1/tx/conviction-lock', { holder: f.stranger, mint: f.mint, amount: '1', unlockTs: NOW + 2 * DAY })).body.reason).toBe('NO_TOKEN_ACCOUNT');
    expect((await lock({ mint: await key() })).body.reason).toBe('MINT_NOT_FOUND');
    expect((await lock({ amount: 'x' })).status).toBe(400);
    expect((await lock({ unlockTs: 'tomorrow' })).status).toBe(400);
    expect((await lock({ extra: true })).status).toBe(400);
  });

  it('unlocks only after the time, only for the holder, only once; the destination account is created first', async () => {
    const f = await fixture({ unlockTs: NOW + 5 * DAY });
    const early = await f.post('/v1/tx/conviction-unlock', { holder: f.holder, lock: f.lockAddress });
    expect(early.status).toBe(409);
    expect(early.body).toMatchObject({ reason: 'STILL_LOCKED', unlockTs: String(NOW + 5 * DAY), secondsLeft: String(5 * DAY) });
    f.put({ unlockTs: NOW });
    const ok = await f.post('/v1/tx/conviction-unlock', { holder: f.holder, lock: f.lockAddress });
    expect(ok.status).toBe(200);
    const ixs = decode(ok.body.transaction);
    expect(ixs.some((i) => i.programAddress === 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL')).toBe(true);
    expect(startsWith(programIxs(ok.body.transaction)[0]!, UNLOCK_DISCRIMINATOR)).toBe(true);
    expect((await f.post('/v1/tx/conviction-unlock', { holder: f.stranger, lock: f.lockAddress })).body).toMatchObject({ reason: 'NOT_THE_HOLDER', holder: f.holder });
    f.put({ unlockTs: NOW, withdrawn: true });
    expect((await f.post('/v1/tx/conviction-unlock', { holder: f.holder, lock: f.lockAddress })).body.reason).toBe('ALREADY_WITHDRAWN');
    expect((await f.post('/v1/tx/conviction-unlock', { holder: f.holder, lock: f.mint })).status).toBe(404);
  });

  it('claims the badge: init_badge, the holder\'s badge account, claim_badge; once; not before the time; not for a lock too small', async () => {
    const f = await fixture({ amount: 100_000_000n, lockedAt: NOW - 30 * DAY, unlockTs: NOW });
    const ok = await f.post('/v1/tx/conviction-claim-badge', { holder: f.holder, lock: f.lockAddress });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const b = await convictionBadgeAddresses(f.holder, f.mint);
    expect(ok.body).toMatchObject({ tokenDays: '3000', badgeMint: b.badgeMint, holderBadge: b.holderBadge, soulbound: true });
    const ixs = decode(ok.body.transaction);
    expect(ixs.map((i) => (startsWith(i, INIT_BADGE_DISCRIMINATOR) ? 'init' : startsWith(i, CLAIM_BADGE_DISCRIMINATOR) ? 'claim' : i.programAddress === 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL' ? 'ata' : '?'))).toEqual(['init', 'ata', 'claim']);
    f.put({ badgeClaimed: true, lockedAt: NOW - 30 * DAY, unlockTs: NOW });
    expect((await f.post('/v1/tx/conviction-claim-badge', { holder: f.holder, lock: f.lockAddress })).body.reason).toBe('BADGE_ALREADY_CLAIMED');
    f.put({ lockedAt: NOW - 30 * DAY, unlockTs: NOW + 1 });
    expect((await f.post('/v1/tx/conviction-claim-badge', { holder: f.holder, lock: f.lockAddress })).body.reason).toBe('STILL_LOCKED');
    f.put({ amount: 1n, lockedAt: NOW - DAY, unlockTs: NOW });
    expect((await f.post('/v1/tx/conviction-claim-badge', { holder: f.holder, lock: f.lockAddress })).body.reason).toBe('TOO_SMALL_FOR_A_BADGE');
    expect((await f.post('/v1/tx/conviction-claim-badge', { holder: f.stranger, lock: f.lockAddress })).body.reason).toBe('NOT_THE_HOLDER');
  });

  it('closes a lock only when the tokens are back and the badge is claimed', async () => {
    const f = await fixture();
    expect((await f.post('/v1/tx/conviction-close-lock', { holder: f.holder, lock: f.lockAddress })).body).toMatchObject({ reason: 'LOCK_STILL_NEEDED', withdrawn: false, badgeClaimed: false });
    f.put({ withdrawn: true });
    expect((await f.post('/v1/tx/conviction-close-lock', { holder: f.holder, lock: f.lockAddress })).status).toBe(409);
    f.put({ withdrawn: true, badgeClaimed: true });
    const ok = await f.post('/v1/tx/conviction-close-lock', { holder: f.holder, lock: f.lockAddress });
    expect(ok.status).toBe(200);
    expect(startsWith(programIxs(ok.body.transaction)[0]!, CLOSE_LOCK_DISCRIMINATOR)).toBe(true);
  });

  it('reads one lock from chain and the holder\'s locks and badges from the index', async () => {
    const f = await fixture({ unlockTs: NOW + 5 * DAY });
    const one = await f.get(`/v1/conviction/locks/${f.lockAddress}`);
    expect(one.body).toMatchObject({ state: 'locked', secondsLeft: String(5 * DAY), amount: '100000000', canClaimBadge: false, closable: false });
    f.put({ unlockTs: NOW - 1 });
    expect((await f.get(`/v1/conviction/locks/${f.lockAddress}`)).body).toMatchObject({ state: 'unlockable', canClaimBadge: true });
    const { db, pg } = await database();
    const app = server();
    registerConvictionTx(app, { account: f.chain.account, lifetime: f.chain.lifetime, clock: () => NOW, gate: ready, db: db as Db });
    const c = caller(app);
    await pg.query(`INSERT INTO conviction_locks (lock, holder, mint, amount, locked_at, unlock_ts, unlocked, badge_claimed, token_days, created_slot, updated_slot) VALUES ($1,$2,$3,100,1,$4,true,true,3000,1,1), ($5,$2,$3,50,1,$6,false,false,null,2,2)`, [f.lockAddress, f.holder, f.mint, NOW - 5, f.stranger, NOW + 5]);
    const b = await convictionBadgeAddresses(f.holder, f.mint);
    await pg.query(`INSERT INTO conviction_badges (holder, mint, badge_mint, slot) VALUES ($1,$2,$3,1)`, [f.holder, f.mint, b.badgeMint]);
    f.chain.tokenAt(b.holderBadge, f.holder, b.badgeMint, 3000n, 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb' as Address);
    const mine = await c.get(`/v1/owners/${f.holder}/conviction`);
    expect(mine.body.locks.map((l: { state: string }) => l.state)).toEqual(['locked', 'unlocked']);
    expect(mine.body.badges).toEqual([{ mint: f.mint, badgeMint: b.badgeMint, tokenDays: '3000' }]);
    const mint = await c.get(`/v1/conviction/mints/${f.mint}`);
    expect(mint.body).toMatchObject({ locks: 2, holders: 1, locked: '50', tokenDaysClaimed: '3000' });
  }, 30_000);
});
