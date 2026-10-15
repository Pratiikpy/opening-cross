// A locked conviction ladder (ADR-0914, rows D5, D2) on the real lb_clmm binary: the ladder is made with Meteora's `initialize_position_by_operator`, whose `lock_release_point`
// DLMM enforces on every withdrawal, the owner's included. Until that time the depth cannot be pulled; at it, it can. This is the commitment the unlocked forms (a plain position,
// a limit order) do not give.
import { existsSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { generateKeyPairSigner } from '@solana/kit';
import { getSetComputeUnitLimitInstruction } from '@solana-program/compute-budget';
import { OrderSide } from '@opening-cross/sdk';
import { buildDlmmConvictionLadder, buildOpenDlmmPair, buildRebalanceLadder, decodeDlmmPosition } from '@opening-cross/adapters';
import { World } from '../src/world.js';
import { DLMM_FIXTURE } from '../src/harness.js';

// The chain runs are many transactions each; the default five seconds is for pure functions.
vi.setConfig({ testTimeout: 180_000 });

const cu = getSetComputeUnitLimitInstruction({ units: 1_400_000 });
const DAY = 86_400n;
const observed: Record<string, string> = {};

async function tryTx(w: World, ixs: Parameters<World['h']['send']>[0], who: Parameters<World['h']['send']>[1]): Promise<string> {
  try {
    await w.h.send(ixs, who);
    return 'ok';
  } catch (e) {
    const logs = (e as { logs?: string[] }).logs;
    return (logs ? logs.join(' ') : String(e)).match(/Error Code: (\w+)/)?.[1] ?? (logs ? logs.slice(-3).join(' ') : String(e)).slice(0, 300);
  }
}

async function clearedCross(w: World) {
  const cross = await w.newCross();
  const s = await w.trader(0n, 5_000_000_000n);
  const b = await w.trader(20_000_000_000n);
  const orders = [await w.place(cross, s, OrderSide.Sell, 1_200_000n, 2_000_000_000n), await w.place(cross, b, OrderSide.Buy, 1_300_000n, 2_000_000_000n)];
  const settled = await w.settle(cross);
  await w.claimAll(settled, orders);
  await w.finalize(w.view(cross.address));
  return w.view(cross.address);
}

describe.skipIf(!existsSync(DLMM_FIXTURE))('locked conviction ladder on the real DLMM', () => {
  it('cannot be withdrawn before its release time, by the owner or by a rebalance, and can after', async () => {
    const w = await World.create();
    const cross = await clearedCross(w);
    await w.h.fund(w.baseMint, w.admin, w.creator.address, 10_000_000_000n);
    // Meteora lets the operator make a locked position only while the pair is closed (it is for seeding a launch before it opens), so the pair is batch-opened.
    const now = w.h.svm.getClock().unixTimestamp;
    const open = await buildOpenDlmmPair({ cross, creator: w.creator, binStep: 10, baseFactor: 10_000, batch: { windowSecs: 300, activationPoint: now + 3_600n } });
    await w.h.send([cu, open.instruction], w.creator);
    const release = now + 30n * DAY;
    const base = await generateKeyPairSigner();
    const ladder = await buildDlmmConvictionLadder({ cross, creator: w.creator, position: base, activeId: open.activeId, bins: 20, baseAmount: 2_000_000_000n, shape: 'flat', lockUntil: release });
    observed.createLocked = await tryTx(w, [cu, ...ladder.instructions], w.creator);
    expect(observed.createLocked).toBe('ok');
    // The position is a PDA, not the base key, and carries the release time.
    expect(ladder.position).not.toBe(base.address);
    const acct = w.h.svm.getAccount(ladder.position);
    if (!acct.exists) throw new Error('locked position missing');
    const pos = decodeDlmmPosition(new Uint8Array(acct.data))!;
    expect(pos).toMatchObject({ lockReleasePoint: release, owner: w.creator.address, lowerBinId: ladder.lowerBinId, upperBinId: ladder.upperBinId });
    expect(pos.shares.some((s) => s > 0n)).toBe(true);

    // A day, a week, a month less a second: the owner's own withdrawal (the first step of a rebalance) is refused by DLMM.
    const withdrawal = async () => {
      const plan = await buildRebalanceLadder({ cross, owner: w.creator, position: ladder.position, lowerBinId: pos.lowerBinId, upperBinId: pos.upperBinId, newPosition: await generateKeyPairSigner(), activeId: open.activeId, bins: 20, baseAmount: 1_000_000_000n, claimFees: false });
      return tryTx(w, [cu, ...plan.withdraw], w.creator);
    };
    for (const at of [DAY, 7n * DAY, 30n * DAY - 1n]) {
      w.h.setTime(now + at);
      observed[`withdraw at +${at}s`] = await withdrawal();
      expect(observed[`withdraw at +${at}s`]).toBe('LiquidityLocked');
    }
    // At the release time it goes through, and the base is back in the wallet.
    w.h.setTime(release);
    const before = await w.h.balanceOf(w.creator.address, w.baseMint);
    observed.withdrawAtRelease = await withdrawal();
    expect(observed.withdrawAtRelease).toBe('ok');
    expect((await w.h.balanceOf(w.creator.address, w.baseMint)) - before > 1_999_999_000n).toBe(true);
    console.table(observed);
  });

  it('refuses a lock time that is not positive, and a lock once the pair is open; any wallet may lock a ladder of its own while the pair is closed', async () => {
    const w = await World.create();
    const cross = await clearedCross(w);
    await w.h.fund(w.baseMint, w.admin, w.creator.address, 10_000_000_000n);
    const now = w.h.svm.getClock().unixTimestamp;
    const open = await buildOpenDlmmPair({ cross, creator: w.creator, binStep: 10, baseFactor: 10_000, batch: { windowSecs: 300, activationPoint: now + 3_600n } });
    await w.h.send([cu, open.instruction], w.creator);
    const base = await generateKeyPairSigner();
    await expect(buildDlmmConvictionLadder({ cross, creator: w.creator, position: base, activeId: open.activeId, bins: 5, baseAmount: 1_000_000n, lockUntil: 0n })).rejects.toThrow(/unix time/);
    // Meteora lets anyone make a locked position while the pair is closed (it is for seeding a launch before it opens), not only the creator: a stranger locks liquidity of
    // their own, which is their risk and nobody else's. Once the pair has opened the same instruction is refused for everyone.
    const mallory = await w.trader(0n, 1_000_000_000n);
    await w.h.ata(mallory.address, w.quoteMint, w.admin);
    const theirs = await buildDlmmConvictionLadder({ cross, creator: mallory, position: await generateKeyPairSigner(), activeId: open.activeId, bins: 5, baseAmount: 1_000_000n, lockUntil: 9_999_999_999n });
    observed.strangerLocksWhileClosed = await tryTx(w, [cu, ...theirs.instructions], mallory);
    expect(observed.strangerLocksWhileClosed).toBe('ok');
    w.h.setTime(now + 3_700n);
    const late = await buildDlmmConvictionLadder({ cross, creator: w.creator, position: await generateKeyPairSigner(), activeId: open.activeId, bins: 5, baseAmount: 1_000_000n, lockUntil: 9_999_999_999n });
    observed.creatorLocksOnceOpen = await tryTx(w, [cu, ...late.instructions], w.creator);
    expect(observed.creatorLocksOnceOpen).toBe('UnauthorizedAccess');
    console.table(observed);
  });
});
