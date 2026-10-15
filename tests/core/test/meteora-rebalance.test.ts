// Rebalancing the conviction ladder (ADR-0915, row W10) on the real lb_clmm binary: buyers walk the price up through a ladder, the issuer's position holds a mix of
// quote and base, a rebalance withdraws it, closes it and lays the base again above the new price, and nothing is lost on the way.
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import BN from 'bn.js';
import { AnchorProvider, BorshAccountsCoder, Program, Wallet } from '@coral-xyz/anchor';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { generateKeyPairSigner } from '@solana/kit';
import { getSetComputeUnitLimitInstruction } from '@solana-program/compute-budget';
import { TOKEN_2022_PROGRAM_ADDRESS } from '@solana-program/token-2022';
import { OrderSide, ata } from '@opening-cross/sdk';
import {
  DLMM_PROGRAM_ADDRESS,
  binArrayAddress,
  binArrayIndex,
  binPriceQ64,
  buildDlmmConvictionLadder,
  buildOpenDlmmPair,
  buildRebalanceLadder,
  decodeDlmmBinArray,
  decodeDlmmPosition,
  dlmmPositionAmounts,
  dlmmPositionArrayAddresses,
  ladderStatus,
} from '@opening-cross/adapters';
import { World } from '../src/world.js';
import { DLMM_FIXTURE, fromLegacy } from '../src/harness.js';

// The chain runs are many transactions each; the default five seconds is for pure functions.
vi.setConfig({ testTimeout: 180_000 });

const idl = JSON.parse(readFileSync(fileURLToPath(new URL('../../../idls/lb_clmm.json', import.meta.url)), 'utf8'));
const coder = new BorshAccountsCoder(idl);
const program = new Program(idl, new AnchorProvider(new Connection('http://127.0.0.1:1'), new Wallet(Keypair.generate()), {}));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const m = program.methods as any;
const cu = getSetComputeUnitLimitInstruction({ units: 1_400_000 });
const T22 = new PublicKey(TOKEN_2022_PROGRAM_ADDRESS);
const PID = new PublicKey(DLMM_PROGRAM_ADDRESS);
const MEMO = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');

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

describe.skipIf(!existsSync(DLMM_FIXTURE))('ladder rebalance on the real DLMM', () => {
  it('reads the ladder, withdraws and closes it, and lays the base again above the new price without losing an atom', async () => {
    const w = await World.create();
    const cross = await clearedCross(w);
    await w.h.fund(w.baseMint, w.admin, w.creator.address, 10_000_000_000n);
    const open = await buildOpenDlmmPair({ cross, creator: w.creator, binStep: 10, baseFactor: 10_000 });
    await w.h.send([cu, open.instruction], w.creator);
    const lbPair = new PublicKey(open.addresses.lbPair);
    const activeNow = () => {
      const a = w.h.svm.getAccount(open.addresses.lbPair);
      if (!a.exists) throw new Error('pair missing');
      return coder.decode('LbPair', Buffer.from(a.data)).active_id as number;
    };
    const read = (addr: string) => {
      const a = w.h.svm.getAccount(addr as never);
      return a.exists ? new Uint8Array(a.data) : null;
    };
    const arraysOf = (list: string[]) => list.map((x) => decodeDlmmBinArray(read(x)!)!).filter(Boolean);

    // The ladder: 3,000,000,000 base over 30 bins above P*.
    const baseStart = await w.h.balanceOf(w.creator.address, w.baseMint);
    const first = await generateKeyPairSigner();
    const ladder = await buildDlmmConvictionLadder({ cross, creator: w.creator, position: first, activeId: open.activeId, bins: 30, baseAmount: 3_000_000_000n, shape: 'flat' });
    await w.h.send([cu, ...ladder.instructions], w.creator);
    const laidX = baseStart - (await w.h.balanceOf(w.creator.address, w.baseMint));

    // Read it back: the decoded position and the value of its bins match what went in, and an untouched ladder is not worth rebalancing.
    const pos0 = decodeDlmmPosition(read(first.address)!)!;
    expect([pos0.lowerBinId, pos0.upperBinId, pos0.lbPair, pos0.owner]).toEqual([ladder.lowerBinId, ladder.upperBinId, open.addresses.lbPair, w.creator.address]);
    const amt0 = dlmmPositionAmounts(pos0, arraysOf(dlmmPositionArrayAddresses(open.addresses.lbPair, pos0)));
    expect(amt0.y).toBe(0n);
    // The bins hold what was deposited, to within the rounding of the shares (DLMM floors each bin's share).
    expect(amt0.x <= laidX && laidX - amt0.x <= 100n).toBe(true);
    const status0 = ladderStatus(pos0, amt0, open.activeId);
    expect(status0).toMatchObject({ untouched: true, passed: false, worthRebalancing: false, baseFrom: ladder.lowerBinId, baseTo: ladder.upperBinId });

    // Buyers walk the price up: 1,500,000,000 quote buys through the first bins.
    const swapArrays = dlmmPositionArrayAddresses(open.addresses.lbPair, pos0).map((a) => ({ pubkey: new PublicKey(a), isSigner: false, isWritable: true }));
    const buy = async (quoteIn: bigint, arrays = swapArrays) => {
      const buyer = await w.trader(quoteIn, 0n);
      await w.h.ata(buyer.address, w.baseMint, w.admin);
      const ix = await m
        .swap2(new BN(quoteIn.toString()), new BN(0), { slices: [] })
        .accounts({
          lbPair, binArrayBitmapExtension: PID, reserveX: new PublicKey(open.addresses.reserveX), reserveY: new PublicKey(open.addresses.reserveY),
          userTokenIn: new PublicKey(await ata(buyer.address, w.quoteMint, TOKEN_2022_PROGRAM_ADDRESS)), userTokenOut: new PublicKey(await ata(buyer.address, w.baseMint, TOKEN_2022_PROGRAM_ADDRESS)),
          tokenXMint: new PublicKey(w.baseMint), tokenYMint: new PublicKey(w.quoteMint), oracle: new PublicKey(open.addresses.oracle), hostFeeIn: PID,
          user: new PublicKey(buyer.address), tokenXProgram: T22, tokenYProgram: T22, memoProgram: MEMO,
        } as never)
        .remainingAccounts(arrays)
        .instruction();
      await w.h.send([cu, fromLegacy(ix, { [buyer.address]: buyer })], buyer);
      return w.h.balanceOf(buyer.address, w.baseMint);
    };
    const bought1 = await buy(1_500_000_000n);
    const active1 = activeNow();
    expect(active1 > open.activeId).toBe(true);

    // The ladder now holds quote in the bins that sold and base in the bins that did not.
    const pos1 = decodeDlmmPosition(read(first.address)!)!;
    const amt1 = dlmmPositionAmounts(pos1, arraysOf(dlmmPositionArrayAddresses(open.addresses.lbPair, pos1)));
    const status1 = ladderStatus(pos1, amt1, active1);
    expect(status1.untouched).toBe(false);
    expect(status1.worthRebalancing).toBe(true);
    expect(status1.baseLeft > 0n && status1.quoteEarned > 0n).toBe(true);
    // The base the buyer got plus the base still in the ladder is what was laid (to rounding).
    expect(bought1 + status1.baseLeft <= laidX && laidX - (bought1 + status1.baseLeft) <= 200n).toBe(true);
    expect(status1.baseFrom! >= active1).toBe(true);

    // The rebalance. The computed amounts equal what a real withdrawal pays: base to the atom (the swaps charged their fee in quote), quote plus the fee the position earned.
    const second = await generateKeyPairSigner();
    // DLMM refuses to withdraw liquidity in the same second it was added (`LiquidityLocked`, as it does for limit orders); a minute later it is free.
    const soon = await w.h.fail([cu, ...(await buildRebalanceLadder({ cross, owner: w.creator, position: first.address, lowerBinId: pos1.lowerBinId, upperBinId: pos1.upperBinId, newPosition: second, activeId: active1, bins: 30, baseAmount: status1.baseLeft, claimFees: false })).withdraw], w.creator);
    expect(soon).toContain('LiquidityLocked');
    w.h.setTime(w.h.svm.getClock().unixTimestamp + 60n);
    const baseBefore = await w.h.balanceOf(w.creator.address, w.baseMint);
    const quoteBefore = await w.h.balanceOf(w.creator.address, w.quoteMint);
    const plan = await buildRebalanceLadder({
      cross, owner: w.creator, position: first.address, lowerBinId: pos1.lowerBinId, upperBinId: pos1.upperBinId, newPosition: second,
      activeId: active1, bins: 30, baseAmount: status1.baseLeft, shape: 'flat', existingBinArrays: swapArrays.map((_, i) => binArrayIndex(pos1.lowerBinId) + i),
    });
    await w.h.send([cu, ...plan.withdraw], w.creator);
    const baseGot = (await w.h.balanceOf(w.creator.address, w.baseMint)) - baseBefore;
    const quoteGot = (await w.h.balanceOf(w.creator.address, w.quoteMint)) - quoteBefore;
    expect(baseGot).toBe(status1.baseLeft);
    expect(quoteGot >= status1.quoteEarned).toBe(true);
    // The old position is gone and its rent went back to the owner.
    expect(w.h.exists(first.address)).toBe(false);

    // The relay: a new position above the new active bin, holding the base that came back.
    await w.h.send([cu, ...plan.relay], w.creator);
    const pos2 = decodeDlmmPosition(read(second.address)!)!;
    expect(pos2.lowerBinId).toBe(active1 + 1);
    expect(pos2.upperBinId - pos2.lowerBinId + 1).toBe(30);
    const amt2 = dlmmPositionAmounts(pos2, arraysOf(dlmmPositionArrayAddresses(open.addresses.lbPair, pos2)));
    expect(amt2.y).toBe(0n);
    expect(amt2.x <= baseGot && baseGot - amt2.x <= 100n).toBe(true);
    expect(ladderStatus(pos2, amt2, active1)).toMatchObject({ untouched: true, worthRebalancing: false });

    // Conservation: the base is all accounted for: the wallet, the new ladder and the buyer hold the 3,000,000,000 that was laid (rounding dust under 300 atoms).
    const walletBase = await w.h.balanceOf(w.creator.address, w.baseMint);
    const accounted = (walletBase - (baseStart - laidX)) + amt2.x + bought1;
    expect(accounted <= laidX && laidX - accounted <= 300n).toBe(true);

    // The market keeps walking: a second buyer is served from the new ladder at its bin prices, none below the new first bin.
    const newArrays = dlmmPositionArrayAddresses(open.addresses.lbPair, pos2).map((a) => ({ pubkey: new PublicKey(a), isSigner: false, isWritable: true }));
    const quoteIn = 300_000_000n;
    const bought2 = await buy(quoteIn, newArrays);
    const firstNewPrice = Number(binPriceQ64(pos2.lowerBinId, 10)) / 2 ** 64;
    expect(Number(quoteIn) / Number(bought2) >= firstNewPrice * 0.9999).toBe(true);
    console.table({ laid: Number(laidX), bought_first_walk: Number(bought1), base_left_in_ladder: Number(status1.baseLeft), quote_earned: Number(status1.quoteEarned), active_before: open.activeId, active_after_walk: active1, new_ladder_from: pos2.lowerBinId, base_relaid: Number(amt2.x) });
    void binArrayAddress;
  });

  it('refuses a stranger withdrawing the issuer position, and the builder refuses nothing to lay and an empty range', async () => {
    const w = await World.create();
    const cross = await clearedCross(w);
    await w.h.fund(w.baseMint, w.admin, w.creator.address, 10_000_000_000n);
    const open = await buildOpenDlmmPair({ cross, creator: w.creator, binStep: 10, baseFactor: 10_000 });
    await w.h.send([cu, open.instruction], w.creator);
    const first = await generateKeyPairSigner();
    const ladder = await buildDlmmConvictionLadder({ cross, creator: w.creator, position: first, activeId: open.activeId, bins: 10, baseAmount: 1_000_000_000n });
    await w.h.send([cu, ...ladder.instructions], w.creator);
    const mallory = await w.trader(0n, 0n);
    await w.h.ata(mallory.address, w.baseMint, w.admin);
    await w.h.ata(mallory.address, w.quoteMint, w.admin);
    const second = await generateKeyPairSigner();
    const stolen = await buildRebalanceLadder({ cross, owner: mallory, position: first.address, lowerBinId: ladder.lowerBinId, upperBinId: ladder.upperBinId, newPosition: second, activeId: open.activeId, bins: 10, baseAmount: 1_000_000_000n, claimFees: false });
    const logs = await w.h.fail([cu, ...stolen.withdraw], mallory);
    expect(logs).toMatch(/Error Code: \w+/);
    expect(w.h.exists(first.address)).toBe(true);
    await expect(buildRebalanceLadder({ cross, owner: w.creator, position: first.address, lowerBinId: ladder.lowerBinId, upperBinId: ladder.upperBinId, newPosition: second, activeId: open.activeId, bins: 10, baseAmount: 0n })).rejects.toThrow(/no base to lay/);
    await expect(buildRebalanceLadder({ cross, owner: w.creator, position: first.address, lowerBinId: 5, upperBinId: 4, newPosition: second, activeId: open.activeId, bins: 10, baseAmount: 1n })).rejects.toThrow(/range is empty/);
  });
});
