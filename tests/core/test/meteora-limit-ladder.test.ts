// The conviction ladder as DLMM limit orders (ADR-0914, rows D5, D2) on the real lb_clmm binary: the issuer's unsold base stands as ask orders above P*, a buyer's
// swap fills the rungs it crosses at their bin prices, and cancelling returns the unfilled base and pays the quote the fills earned. Compared with the position form
// only where the numbers say something.
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import BN from 'bn.js';
import { AnchorProvider, BorshAccountsCoder, Program, Wallet } from '@coral-xyz/anchor';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { generateKeyPairSigner } from '@solana/kit';
import { getSetComputeUnitLimitInstruction } from '@solana-program/compute-budget';
import { TOKEN_2022_PROGRAM_ADDRESS } from '@solana-program/token-2022';
import { OrderSide, ata } from '@opening-cross/sdk';
import {
  DLMM_PROGRAM_ADDRESS,
  MAX_LIMIT_ORDER_BINS,
  binArrayAddress,
  binPriceQ64,
  buildCancelLimitLadder,
  buildCloseLimitLadder,
  buildOpenDlmmPair,
  buildPlaceLimitLadder,
  limitLadderArrayIndexes,
  planLimitLadder,
} from '@opening-cross/adapters';
import { World } from '../src/world.js';
import { DLMM_FIXTURE, fromLegacy } from '../src/harness.js';

const idl = JSON.parse(readFileSync(fileURLToPath(new URL('../../../idls/lb_clmm.json', import.meta.url)), 'utf8'));
const coder = new BorshAccountsCoder(idl);
const program = new Program(idl, new AnchorProvider(new Connection('http://127.0.0.1:1'), new Wallet(Keypair.generate()), {}));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const m = program.methods as any;
const cu = getSetComputeUnitLimitInstruction({ units: 1_400_000 });
const T22 = new PublicKey(TOKEN_2022_PROGRAM_ADDRESS);
const PID = new PublicKey(DLMM_PROGRAM_ADDRESS);
const MEMO = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
const observed: Record<string, string> = {};

async function tryTx(w: World, ixs: Parameters<World['h']['send']>[0], who: Parameters<World['h']['send']>[1]): Promise<string> {
  try {
    await w.h.send(ixs, who);
    return 'ok';
  } catch (e) {
    const logs = (e as { logs?: string[] }).logs;
    return (logs ? logs.join(' ') : String(e)).match(/Error Code: (\w+)/)?.[1] ?? (logs ? logs.slice(-2).join(' ') : String(e)).slice(0, 200);
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

describe('limit-order ladder arithmetic', () => {
  it('plans rungs that add up exactly, above the active bin, in the shape asked for', () => {
    for (const shape of ['flat', 'taper', 'wall'] as const) {
      for (const [count, amount] of [[1, 7n], [6, 3_000_000_000n], [7, 1_000_000_007n], [70, 10n ** 12n + 3n]] as const) {
        const rungs = planLimitLadder({ activeId: -250, count, baseAmount: amount, shape, spacing: 2, firstOffset: 3 });
        expect(rungs).toHaveLength(count);
        expect(rungs.reduce((n, r) => n + r.amount, 0n)).toBe(amount);
        expect(rungs.map((r) => r.binId)).toEqual(Array.from({ length: count }, (_, i) => -250 + 3 + i * 2));
        expect(rungs.every((r) => r.amount > 0n)).toBe(true);
        if (count > 3 && shape === 'taper') expect(rungs[1]!.amount > rungs[count - 1]!.amount).toBe(true);
        if (count > 3 && shape === 'wall') expect(rungs[count - 1]!.amount > rungs[1]!.amount).toBe(true);
      }
    }
    expect(() => planLimitLadder({ activeId: 0, count: 0, baseAmount: 10n })).toThrow(/rungs/);
    expect(() => planLimitLadder({ activeId: 0, count: MAX_LIMIT_ORDER_BINS + 1, baseAmount: 1000n })).toThrow(/rungs/);
    expect(() => planLimitLadder({ activeId: 0, count: 3, baseAmount: 2n })).toThrow(/one atom per rung/);
    expect(() => planLimitLadder({ activeId: 0, count: 3, baseAmount: 9n, firstOffset: 0 })).toThrow(/at least one bin above/);
    expect(() => planLimitLadder({ activeId: 0, count: 3, baseAmount: 9n, spacing: 0 })).toThrow(/spacing/);
    // The arrays a ladder needs span from the active bin's array to the last rung's, across the negative side too.
    expect(limitLadderArrayIndexes(-3, planLimitLadder({ activeId: -3, count: 3, baseAmount: 9n, spacing: 70 }))).toEqual([-1, 0, 1]);
  });
});

describe.skipIf(!existsSync(DLMM_FIXTURE))('limit-order ladder on the real DLMM', () => {
  it('places asks above P*, fills the rungs a buyer crosses at their bin prices, and cancels back the rest', async () => {
    const w = await World.create();
    const cross = await clearedCross(w);
    const pStar = cross.data.clearing.__option === 'Some' ? cross.data.clearing.value.price : 0n;
    await w.h.fund(w.baseMint, w.admin, w.creator.address, 10_000_000_000n);
    const open = await buildOpenDlmmPair({ cross, creator: w.creator, binStep: 10, baseFactor: 10_000 });
    await w.h.send([cu, open.instruction], w.creator);
    const pairAcct = w.h.svm.getAccount(open.addresses.lbPair);
    if (!pairAcct.exists) throw new Error('pair missing');
    expect(coder.decode('LbPair', Buffer.from(pairAcct.data)).active_id).toBe(open.activeId);

    const rungs = planLimitLadder({ activeId: open.activeId, count: 6, baseAmount: 3_000_000_000n, shape: 'flat' });
    const order = await generateKeyPairSigner();
    const baseBefore = await w.h.balanceOf(w.creator.address, w.baseMint);
    const placed = await buildPlaceLimitLadder({ cross, owner: w.creator, limitOrder: order, activeId: open.activeId, rungs });
    await w.h.send([cu, ...placed.instructions], w.creator);
    // The base left the issuer's wallet and sits in the pair's X reserve; none of it is quote.
    expect(baseBefore - (await w.h.balanceOf(w.creator.address, w.baseMint))).toBe(3_000_000_000n);
    const tokenAmount = (addr: string) => {
      const a = w.h.svm.getAccount(addr as never);
      if (!a.exists) throw new Error('missing');
      return Buffer.from(a.data).readBigUInt64LE(64);
    };
    expect(tokenAmount(open.addresses.reserveX)).toBe(3_000_000_000n);
    expect(tokenAmount(open.addresses.reserveY)).toBe(0n);
    const lo = w.h.svm.getAccount(order.address);
    if (!lo.exists) throw new Error('limit order missing');
    const loState = coder.decode('LimitOrder', Buffer.from(lo.data));
    expect(loState.bin_count).toBe(6);
    expect(loState.owner.toBase58()).toBe(w.creator.address);

    // A buyer swaps quote for base over the ladder's bin arrays.
    const lbPair = new PublicKey(open.addresses.lbPair);
    const arrays = placed.binArrays.map((a) => ({ pubkey: new PublicKey(a), isSigner: false, isWritable: true }));
    const buyer = await w.trader(5_000_000_000n, 0n);
    await w.h.ata(buyer.address, w.baseMint, w.admin);
    const quoteIn = 1_600_000_000n;
    const swap = await m
      .swap2(new BN(quoteIn.toString()), new BN(0), { slices: [] })
      .accounts({
        lbPair, binArrayBitmapExtension: PID, reserveX: new PublicKey(open.addresses.reserveX), reserveY: new PublicKey(open.addresses.reserveY),
        userTokenIn: new PublicKey(await ata(buyer.address, w.quoteMint, TOKEN_2022_PROGRAM_ADDRESS)), userTokenOut: new PublicKey(await ata(buyer.address, w.baseMint, TOKEN_2022_PROGRAM_ADDRESS)),
        tokenXMint: new PublicKey(w.baseMint), tokenYMint: new PublicKey(w.quoteMint), oracle: new PublicKey(open.addresses.oracle), hostFeeIn: PID,
        user: new PublicKey(buyer.address), tokenXProgram: T22, tokenYProgram: T22, memoProgram: MEMO,
      } as never)
      .remainingAccounts(arrays)
      .instruction();
    await w.h.send([cu, fromLegacy(swap, { [buyer.address]: buyer })], buyer);
    const bought = await w.h.balanceOf(buyer.address, w.baseMint);
    const spent = quoteIn - (await w.h.balanceOf(buyer.address, w.quoteMint)) + 5_000_000_000n - quoteIn;
    expect(bought > 0n && bought < 3_000_000_000n).toBe(true);
    // The buyer paid at least the first rung's bin price per base atom and no more than the last rung's, plus the pair's fee.
    const firstPrice = Number(binPriceQ64(rungs[0]!.binId, 10)) / 2 ** 64;
    const lastPrice = Number(binPriceQ64(rungs[5]!.binId, 10)) / 2 ** 64;
    const paid = Number(quoteIn) / Number(bought);
    console.table({ clearing_price: Number(pStar) / 1e6, first_rung: firstPrice, last_rung: lastPrice, avg_paid: paid, bought: Number(bought), spent: Number(quoteIn) });
    expect(paid >= firstPrice * 0.9999).toBe(true);
    expect(paid <= lastPrice * 1.03).toBe(true);
    void spent;

    // The issuer cancels the rungs. First what the program says about a stranger, an early close, and each kind of rung right after placement.
    const mallory = await w.trader(0n, 0n);
    await w.h.ata(mallory.address, w.baseMint, w.admin);
    observed.strangerCancels = await tryTx(w, [await buildCancelLimitLadder({ cross, owner: mallory, limitOrder: order.address, binIds: rungs.map((r) => r.binId) })], mallory);
    expect(observed.strangerCancels).toBe('InvalidLimitOrderOwner');
    // `close_limit_order_if_empty` does nothing while the order still holds a rung (it succeeds and the account stays).
    observed.closeWhileFull = await tryTx(w, [buildCloseLimitLadder({ cross, owner: w.creator, limitOrder: order.address, rentReceiver: w.creator.address })], w.creator);
    expect(observed.closeWhileFull).toBe('ok');
    expect(w.h.exists(order.address)).toBe(true);
    const cancelRungs = (i: number[]) => buildCancelLimitLadder({ cross, owner: w.creator, limitOrder: order.address, binIds: i.map((k) => rungs[k]!.binId) });
    // A rung nobody has touched, and a rung only partly filled, cannot be cancelled yet; a rung a buyer filled completely can (it holds only quote).
    observed.cancelUntouchedNow = await tryTx(w, [cu, await cancelRungs([5])], w.creator);
    observed.cancelPartialNow = await tryTx(w, [cu, await cancelRungs([2])], w.creator);
    expect([observed.cancelUntouchedNow, observed.cancelPartialNow]).toEqual(['LiquidityLocked', 'LiquidityLocked']);
    const quoteBeforeFilled = await w.h.balanceOf(w.creator.address, w.quoteMint);
    await w.h.send([cu, await cancelRungs([0])], w.creator);
    const rung0Quote = (await w.h.balanceOf(w.creator.address, w.quoteMint)) - quoteBeforeFilled;
    // The first rung sold all 500,000,000 base at its bin price; the maker was paid that value plus a share of the pair's fee (at most the whole 0.1% fee).
    const rung0Value = (500_000_000n * binPriceQ64(rungs[0]!.binId, 10)) >> 64n;
    expect(rung0Quote >= rung0Value && rung0Quote <= (rung0Value * 1001n) / 1000n).toBe(true);
    observed.rung0Paid = `${rung0Quote} vs ${rung0Value} at the bin price`;

    // After the lock the rest can be cancelled: the unfilled base returns and the quote the fills earned is paid in.
    w.h.svm.warpToSlot(w.h.svm.getClock().slot + 1_000n);
    w.h.setTime(w.h.svm.getClock().unixTimestamp + 3_600n);
    const baseMid = await w.h.balanceOf(w.creator.address, w.baseMint);
    const quoteMid = await w.h.balanceOf(w.creator.address, w.quoteMint);
    await w.h.send([cu, await cancelRungs([1, 2, 3, 4, 5])], w.creator);
    const baseBack = (await w.h.balanceOf(w.creator.address, w.baseMint)) - baseMid;
    const quoteEarned = rung0Quote + (await w.h.balanceOf(w.creator.address, w.quoteMint)) - quoteMid;
    // Conservation of the base: what came back plus what the buyer got is the whole 3,000,000,000.
    expect(baseBack + bought).toBe(3_000_000_000n);
    // The issuer earned the buyer's spend: at least all of it less the pair's fee, and never more than the buyer paid.
    expect(quoteEarned <= quoteIn && quoteEarned >= (quoteIn * 999n) / 1000n).toBe(true);
    console.table({ base_back: Number(baseBack), quote_earned: Number(quoteEarned), bought: Number(bought), quote_paid_by_buyer: Number(quoteIn) });

    // Now the order is empty: closing it returns its rent; closing twice finds no account.
    const receiver = (await w.h.wallet(0n)).address;
    await w.h.send([buildCloseLimitLadder({ cross, owner: w.creator, limitOrder: order.address, rentReceiver: receiver })], w.creator);
    expect(w.h.exists(order.address)).toBe(false);
    expect((w.h.svm.getBalance(receiver) ?? 0n) > 0n).toBe(true);
    observed.closeTwice = await tryTx(w, [buildCloseLimitLadder({ cross, owner: w.creator, limitOrder: order.address, rentReceiver: receiver })], w.creator);
    console.table(observed);
  });

  it('refuses a rung at or below the market, a repeated bin, a zero amount, and a ladder of the wrong size before sending, and DLMM refuses an ask below the market, a stale view and a zero amount', async () => {
    const w = await World.create();
    const cross = await clearedCross(w);
    await w.h.fund(w.baseMint, w.admin, w.creator.address, 10_000_000_000n);
    const open = await buildOpenDlmmPair({ cross, creator: w.creator, binStep: 10, baseFactor: 10_000 });
    await w.h.send([cu, open.instruction], w.creator);
    const order = await generateKeyPairSigner();
    const base = { cross, owner: w.creator, limitOrder: order, activeId: open.activeId };
    await expect(buildPlaceLimitLadder({ ...base, rungs: [{ binId: open.activeId, amount: 10n }] })).rejects.toThrow(/at or below the active bin/);
    await expect(buildPlaceLimitLadder({ ...base, rungs: [{ binId: open.activeId + 1, amount: 10n }, { binId: open.activeId + 1, amount: 10n }] })).rejects.toThrow(/twice/);
    await expect(buildPlaceLimitLadder({ ...base, rungs: [{ binId: open.activeId + 1, amount: 0n }] })).rejects.toThrow(/positive/);
    await expect(buildPlaceLimitLadder({ ...base, rungs: [] })).rejects.toThrow(/1 to/);
    // A valid order first (it also creates the bin arrays), then tampered copies of it, each with its own order account.
    const ok = await buildPlaceLimitLadder({ ...base, rungs: [{ binId: open.activeId + 1, amount: 100_000_000n }] });
    await w.h.send([cu, ...ok.instructions], w.creator);
    expect(w.h.exists(order.address)).toBe(true);
    const existing = limitLadderArrayIndexes(open.activeId, [{ binId: open.activeId + 1, amount: 1n }]);
    const tampered = async (mutate: (b: Buffer) => void) => {
      const fresh = await generateKeyPairSigner();
      const built = await buildPlaceLimitLadder({ ...base, limitOrder: fresh, rungs: [{ binId: open.activeId + 1, amount: 100_000_000n }], existingBinArrays: existing });
      const place = built.instructions[built.instructions.length - 1]!;
      const data = Buffer.from(place.data!);
      mutate(data);
      return tryTx(w, [cu, { ...place, data: new Uint8Array(data) }], w.creator);
    };
    const REL = 8 + 1 + 16 + 1 + 4 + 4 + 4; // the first rung's offset from the active bin
    observed.askAtActiveBin = await tampered((b) => b.writeInt32LE(0, REL));
    observed.askBelowActiveBin = await tampered((b) => b.writeInt32LE(-1, REL));
    observed.staleActiveBin = await tampered((b) => b.writeInt32LE(open.activeId - 5, 8 + 1 + 16 + 1));
    observed.zeroAmount = await tampered((b) => b.writeBigUInt64LE(0n, REL + 4));
    // DLMM itself allows an ask in the active bin (the builder keeps the ladder above it unless asked), refuses one below it, a stale view of the active bin and a zero amount.
    expect([observed.askAtActiveBin, observed.askBelowActiveBin, observed.staleActiveBin, observed.zeroAmount]).toEqual(['ok', 'InvalidPlaceLimitOrderParameters', 'ExceededBinSlippageTolerance', 'InvalidPlaceLimitOrderParameters']);
    void binArrayAddress;
    console.table(observed);
  });
});

// DLMM will not let a rung be cancelled the moment it is placed unless a buyer has filled it completely. How long that lock lasts, and whether it counts slots or seconds,
// is not documented; this finds out on the real binary. The clock moves in one dimension at a time in two separate worlds.
describe.skipIf(!existsSync(DLMM_FIXTURE))('limit-order cancel lock', () => {
  async function untouched() {
    const w = await World.create();
    const cross = await clearedCross(w);
    await w.h.fund(w.baseMint, w.admin, w.creator.address, 10_000_000_000n);
    const open = await buildOpenDlmmPair({ cross, creator: w.creator, binStep: 10, baseFactor: 10_000 });
    await w.h.send([cu, open.instruction], w.creator);
    const order = await generateKeyPairSigner();
    const rungs = planLimitLadder({ activeId: open.activeId, count: 3, baseAmount: 300_000_000n });
    const placed = await buildPlaceLimitLadder({ cross, owner: w.creator, limitOrder: order, activeId: open.activeId, rungs });
    await w.h.send([cu, ...placed.instructions], w.creator);
    const cancel = async () => tryTx(w, [cu, await buildCancelLimitLadder({ cross, owner: w.creator, limitOrder: order.address, binIds: rungs.map((r) => r.binId) })], w.creator);
    return { w, cancel };
  }
  it('is released by one second and by no number of slots: it is a same-instant guard, not a commitment', async () => {
    const slots = await untouched();
    const results: Record<string, string> = {};
    const steps = [1n, 10n, 100n, 1_000n, 10_000n, 100_000n];
    let slotsUnlock: bigint | null = null;
    for (const n of steps) {
      slots.w.h.svm.warpToSlot(slots.w.h.svm.getClock().slot + n);
      const r = await slots.cancel();
      results[`slots +${n} (clock fixed)`] = r;
      if (r === 'ok') {
        slotsUnlock = n;
        break;
      }
    }
    const seconds = await untouched();
    const secondSteps = [1n, 30n, 60n, 300n, 600n, 1_800n, 3_600n, 86_400n];
    let secondsUnlock: bigint | null = null;
    for (const n of secondSteps) {
      seconds.w.h.setTime(seconds.w.h.svm.getClock().unixTimestamp + n);
      const r = await seconds.cancel();
      results[`seconds +${n} (slot as the clock left it)`] = r;
      if (r === 'ok') {
        secondsUnlock = n;
        break;
      }
    }
    console.table(results);
    // The lock counts seconds, not slots: a hundred thousand slots at one timestamp release nothing, and one second releases it. It is a guard against placing and
    // cancelling in the same instant, not a commitment: the owner can pull an unfilled rung one second after placing it.
    expect(slotsUnlock).toBeNull();
    expect(secondsUnlock).toBe(1n);
  });
});
