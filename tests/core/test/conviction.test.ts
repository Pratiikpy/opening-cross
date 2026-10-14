// Conviction (S7; ADR-0651): tokens locked with no early exit, and a soulbound badge that measures token-days held locked.
import { describe, expect, it } from 'vitest';
import { type Address, type KeyPairSigner } from '@solana/kit';
import {
  TOKEN_2022_PROGRAM_ADDRESS,
  findAssociatedTokenPda,
  getBurnInstruction,
  getCreateAssociatedTokenIdempotentInstruction,
  getTransferCheckedInstruction,
} from '@solana-program/token-2022';
import {
  findBadgeAuthorityPda,
  findBadgeMintPda,
  findLockPda,
  getClaimBadgeInstruction,
  getCloseLockInstruction,
  getInitBadgeInstruction,
  getLockDecoder,
  getLockTokensInstruction,
  getUnlockInstruction,
} from '@opening-cross/cross-conviction-client';
import { World } from '../src/world.js';
import { T0 } from '../src/harness.js';

const TOKEN = 1_000_000n;
const DAY = 86_400n;

async function setup() {
  const w = await World.create();
  const holder = await w.trader(0n, 1_000n * TOKEN);
  return { w, holder };
}

async function atas(owner: Address, mint: Address) {
  return (await findAssociatedTokenPda({ owner, mint, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS }))[0];
}

async function lockIx(w: World, holder: KeyPairSigner, nonce: bigint, amount: bigint, unlockTs: bigint) {
  const [lock] = await findLockPda({ holder: holder.address, mint: w.baseMint, nonce });
  const vault = await atas(lock, w.baseMint);
  return {
    lock,
    vault,
    ix: getLockTokensInstruction({
      holder,
      mint: w.baseMint,
      holderToken: await atas(holder.address, w.baseMint),
      lock,
      vault,
      tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
      nonce,
      amount,
      unlockTs,
    }),
  };
}

const unlockIx = async (w: World, holder: KeyPairSigner, lock: Address, vault: Address) =>
  getUnlockInstruction({ holder, lock, mint: w.baseMint, vault, holderToken: await atas(holder.address, w.baseMint), tokenProgram: TOKEN_2022_PROGRAM_ADDRESS });

async function badgeAddresses(w: World, holder: Address) {
  const [badgeMint] = await findBadgeMintPda({ holder, mint: w.baseMint });
  const [badgeAuthority] = await findBadgeAuthorityPda();
  return { badgeMint, badgeAuthority, holderBadge: await atas(holder, badgeMint) };
}

async function claimIxs(w: World, holder: KeyPairSigner, lock: Address) {
  const { badgeMint, badgeAuthority, holderBadge } = await badgeAddresses(w, holder.address);
  return [
    getInitBadgeInstruction({ payer: holder, holder: holder.address, mint: w.baseMint, badgeMint, badgeAuthority }),
    getCreateAssociatedTokenIdempotentInstruction({ payer: holder, ata: holderBadge, owner: holder.address, mint: badgeMint, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS }),
    getClaimBadgeInstruction({ holder, lock, mint: w.baseMint, badgeMint, badgeAuthority, holderBadge }),
  ];
}

describe('locking has no early exit', () => {
  it('the vault holds the tokens, nobody can take them early, and the holder gets exactly them back at the end', async () => {
    const { w, holder } = await setup();
    const { lock, vault, ix } = await lockIx(w, holder, 0n, 300n * TOKEN, T0 + 30n * DAY);
    const before = await w.h.balanceOf(holder.address, w.baseMint);
    await w.h.send([ix], holder);
    expect(w.h.balance(vault)).toBe(300n * TOKEN);
    expect(await w.h.balanceOf(holder.address, w.baseMint)).toBe(before - 300n * TOKEN);

    // Early: the holder cannot, a stranger cannot, and a direct token transfer out of the vault cannot.
    expect(await w.h.fail([await unlockIx(w, holder, lock, vault)], holder)).toContain('StillLocked');
    const stranger = await w.h.wallet();
    expect(await w.h.fail([await unlockIx(w, stranger, lock, vault)], stranger)).toBeTruthy();
    const direct = getTransferCheckedInstruction({ source: vault, mint: w.baseMint, destination: await atas(holder.address, w.baseMint), authority: holder, amount: 1n, decimals: 6 }, { programAddress: TOKEN_2022_PROGRAM_ADDRESS });
    expect(await w.h.fail([direct], holder)).toBeTruthy();
    w.h.setTime(T0 + 30n * DAY - 1n);
    expect(await w.h.fail([await unlockIx(w, holder, lock, vault)], holder)).toContain('StillLocked');
    expect(w.h.balance(vault)).toBe(300n * TOKEN);

    // At the unlock time, and not before, the holder takes everything back; the vault is closed.
    w.h.setTime(T0 + 30n * DAY);
    await w.h.send([await unlockIx(w, holder, lock, vault)], holder);
    expect(await w.h.balanceOf(holder.address, w.baseMint)).toBe(before);
    expect(w.h.exists(vault)).toBe(false);
    expect(await w.h.fail([await unlockIx(w, holder, lock, vault)], holder)).toBeTruthy();
    expect(getLockDecoder().decode((w.h.svm.getAccount(lock) as { data: Uint8Array }).data).withdrawn).toBe(true);
  });

  it('refuses a zero amount, a lock under a day, one over four years, and a reused nonce', async () => {
    const { w, holder } = await setup();
    expect(await w.h.fail([(await lockIx(w, holder, 0n, 0n, T0 + 30n * DAY)).ix], holder)).toContain('NothingToLock');
    expect(await w.h.fail([(await lockIx(w, holder, 0n, TOKEN, T0 + DAY - 1n)).ix], holder)).toContain('BadUnlockTime');
    expect(await w.h.fail([(await lockIx(w, holder, 0n, TOKEN, T0 + 4n * 365n * DAY + 1n)).ix], holder)).toContain('BadUnlockTime');
    await w.h.send([(await lockIx(w, holder, 0n, TOKEN, T0 + DAY)).ix], holder);
    await w.h.send([(await lockIx(w, holder, 1n, TOKEN, T0 + 4n * 365n * DAY)).ix], holder);
    expect(await w.h.fail([(await lockIx(w, holder, 0n, TOKEN, T0 + DAY)).ix], holder)).toBeTruthy();
  });

  it("one holder cannot touch another's lock", async () => {
    const { w, holder } = await setup();
    const other = await w.trader(0n, 100n * TOKEN);
    const { lock, vault, ix } = await lockIx(w, holder, 0n, 100n * TOKEN, T0 + DAY);
    await w.h.send([ix], holder);
    w.h.setTime(T0 + DAY);
    const steal = getUnlockInstruction({ holder: other, lock, mint: w.baseMint, vault, holderToken: await atas(other.address, w.baseMint), tokenProgram: TOKEN_2022_PROGRAM_ADDRESS });
    expect(await w.h.fail([steal], other)).toContain('Unauthorized');
    expect(w.h.balance(vault)).toBe(100n * TOKEN);
  });
});

describe('the badge measures token-days and cannot be moved', () => {
  it('mints floor(amount x seconds / (86,400 x 10^decimals)) once per lock, after the lock has run', async () => {
    const { w, holder } = await setup();
    const { lock, ix } = await lockIx(w, holder, 0n, 100n * TOKEN, T0 + 30n * DAY);
    await w.h.send([ix], holder);
    expect(await w.h.fail(await claimIxs(w, holder, lock), holder)).toContain('StillLocked');
    w.h.setTime(T0 + 30n * DAY);
    const stranger = await w.h.wallet();
    const { badgeMint: bm, badgeAuthority: ba, holderBadge: hb } = await badgeAddresses(w, holder.address);
    const thief = getClaimBadgeInstruction({ holder: stranger, lock, mint: w.baseMint, badgeMint: bm, badgeAuthority: ba, holderBadge: hb });
    expect(await w.h.fail((await claimIxs(w, holder, lock)).slice(0, 2).concat([thief]), stranger)).toBeTruthy();
    await w.h.send(await claimIxs(w, holder, lock), holder);
    const { badgeMint, holderBadge } = await badgeAddresses(w, holder.address);
    expect(w.h.balance(holderBadge)).toBe(3_000n);
    expect(w.h.mintInfo(badgeMint).decimals).toBe(0);
    expect(w.h.mintInfo(badgeMint).supply).toBe(3_000n);
    // A second claim for the same lock is refused, and the idempotent setup in front of it is harmless.
    expect(await w.h.fail(await claimIxs(w, holder, lock), holder)).toContain('BadgeAlreadyClaimed');
    expect(w.h.balance(holderBadge)).toBe(3_000n);
  });

  it('badges add up across locks and the lock needs both exits before it can be closed', async () => {
    const { w, holder } = await setup();
    const a = await lockIx(w, holder, 0n, 100n * TOKEN, T0 + 10n * DAY);
    const b = await lockIx(w, holder, 1n, 50n * TOKEN, T0 + 20n * DAY);
    await w.h.send([a.ix], holder);
    await w.h.send([b.ix], holder);
    w.h.setTime(T0 + 20n * DAY);
    await w.h.send(await claimIxs(w, holder, a.lock), holder);
    await w.h.send(await claimIxs(w, holder, b.lock), holder);
    const { holderBadge } = await badgeAddresses(w, holder.address);
    expect(w.h.balance(holderBadge)).toBe(1_000n + 1_000n);
    expect(await w.h.fail([getCloseLockInstruction({ holder, lock: a.lock })], holder)).toContain('LockStillNeeded');
    await w.h.send([await unlockIx(w, holder, a.lock, a.vault)], holder);
    const rentBefore = w.h.svm.getBalance(holder.address) ?? 0n;
    await w.h.send([getCloseLockInstruction({ holder, lock: a.lock })], holder);
    expect(w.h.exists(a.lock)).toBe(false);
    expect(w.h.svm.getBalance(holder.address) ?? 0n).toBeGreaterThan(rentBefore);
    // The other lock is still needed until its tokens come back.
    expect(await w.h.fail([getCloseLockInstruction({ holder, lock: b.lock })], holder)).toContain('LockStillNeeded');
  });

  it('a badge is soulbound: the token program refuses to move it, and only its holder can burn it', async () => {
    const { w, holder } = await setup();
    const { lock, ix } = await lockIx(w, holder, 0n, 100n * TOKEN, T0 + 10n * DAY);
    await w.h.send([ix], holder);
    w.h.setTime(T0 + 10n * DAY);
    await w.h.send(await claimIxs(w, holder, lock), holder);
    const { badgeMint, holderBadge } = await badgeAddresses(w, holder.address);
    const friend = await w.h.wallet();
    const friendBadge = await atas(friend.address, badgeMint);
    await w.h.send([getCreateAssociatedTokenIdempotentInstruction({ payer: friend, ata: friendBadge, owner: friend.address, mint: badgeMint, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS })], friend);
    const send = getTransferCheckedInstruction({ source: holderBadge, mint: badgeMint, destination: friendBadge, authority: holder, amount: 1n, decimals: 0 }, { programAddress: TOKEN_2022_PROGRAM_ADDRESS });
    expect(await w.h.fail([send], holder)).toContain('Transfer is disabled for this mint');
    expect(w.h.balance(friendBadge)).toBe(0n);
    // A stranger cannot burn it; its holder can.
    const burnBy = (who: KeyPairSigner) => getBurnInstruction({ account: holderBadge, mint: badgeMint, authority: who, amount: 1n }, { programAddress: TOKEN_2022_PROGRAM_ADDRESS });
    expect(await w.h.fail([burnBy(friend)], friend)).toBeTruthy();
    await w.h.send([burnBy(holder)], holder);
    expect(w.h.balance(holderBadge)).toBe(999n);
  });

  it('a lock too small to earn one token-day gets no badge but still comes back', async () => {
    const { w, holder } = await setup();
    const { lock, vault, ix } = await lockIx(w, holder, 0n, 999_999n, T0 + DAY);
    await w.h.send([ix], holder);
    w.h.setTime(T0 + DAY);
    expect(await w.h.fail(await claimIxs(w, holder, lock), holder)).toContain('TooSmallForABadge');
    await w.h.send([await unlockIx(w, holder, lock, vault)], holder);
    expect(w.h.exists(vault)).toBe(false);
  });

  it('a badge mint for one token is not usable as the badge for another', async () => {
    const { w, holder } = await setup();
    const { lock, ix } = await lockIx(w, holder, 0n, 100n * TOKEN, T0 + 10n * DAY);
    await w.h.send([ix], holder);
    w.h.setTime(T0 + 10n * DAY);
    // The badge mint of a different token (the quote mint) in place of this token's.
    const [otherBadge] = await findBadgeMintPda({ holder: holder.address, mint: w.quoteMint });
    const [badgeAuthority] = await findBadgeAuthorityPda();
    const holderBadge = await atas(holder.address, otherBadge);
    const ixs = [
      getInitBadgeInstruction({ payer: holder, holder: holder.address, mint: w.quoteMint, badgeMint: otherBadge, badgeAuthority }),
      getCreateAssociatedTokenIdempotentInstruction({ payer: holder, ata: holderBadge, owner: holder.address, mint: otherBadge, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS }),
      getClaimBadgeInstruction({ holder, lock, mint: w.baseMint, badgeMint: otherBadge, badgeAuthority, holderBadge }),
    ];
    expect(await w.h.fail(ixs, holder)).toBeTruthy();
  });
});
