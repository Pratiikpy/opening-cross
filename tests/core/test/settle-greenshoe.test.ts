// Greenshoe (ADR-0487, rows D4, VM8, X18) on the real DLMM limit-order binary: standing bids under P* that the program owns for a
// week, filled by a seller crossing them, cancelled at expiry with the bought tokens burned and the unspent budget returned.
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
  binArrayAddress,
  binArrayIndex,
  buildCreateGreenshoe,
  buildDeployGreenshoeBid,
  buildFinishGreenshoe,
  buildOpenDlmmPair,
  buildSettleGreenshoeLevel,
  greenshoeAddresses,
  greenshoeBinFor,
  greenshoeLevelCap,
  greenshoeMinBudget,
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
const WEEK = 7n * 24n * 3600n;

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

async function setup() {
  const w = await World.create();
  const cross = await clearedCross(w);
  await w.h.fund(w.baseMint, w.admin, w.creator.address, 10_000_000_000n);
  const open = await buildOpenDlmmPair({ cross, creator: w.creator, binStep: 10, baseFactor: 10_000 });
  await w.h.send([cu, open.instruction], w.creator);
  const pair = coder.decode('LbPair', Buffer.from((w.h.svm.getAccount(open.addresses.lbPair) as { data: Uint8Array }).data));
  const price = cross.data.clearing.__option === 'Some' ? cross.data.clearing.value.price : 0n;
  return { w, cross, open, pair, price, activeId: open.activeId };
}

describe('greenshoe arithmetic', () => {
  it('the bins sit under P* at 0.90, 0.85 and 0.80 and the budget floor is 10%', () => {
    for (const [price, scale, step] of [[1_300_000n, 1_000_000n, 10], [7_654_321n, 1_000_000n, 25], [999_999_937n, 1_000_000n, 1]] as const) {
      const active = Math.round(Math.log(Number(price) / Number(scale)) / Math.log(1 + step / 10_000));
      const bins = [0, 1, 2].map((l) => greenshoeBinFor(price, scale, step, l));
      expect(bins[0]! < active && bins[1]! < bins[0]! && bins[2]! < bins[1]!).toBe(true);
      const ratio = (b: number) => Math.pow(1 + step / 10_000, b) / (Number(price) / Number(scale));
      expect(Math.abs(ratio(bins[0]!) - 0.9)).toBeLessThan(step / 10_000 / 2 + 1e-9);
      expect(Math.abs(ratio(bins[2]!) - 0.8)).toBeLessThan(step / 10_000 / 2 + 1e-9);
    }
    expect(greenshoeMinBudget(2_600_000_000n)).toBe(260_000_000n);
    for (const budget of [1n, 2n, 3n, 100n, 10n ** 12n + 1n]) expect(greenshoeLevelCap(budget) * 3n >= budget).toBe(true);
  });
});

describe.skipIf(!existsSync(DLMM_FIXTURE))('greenshoe on the real DLMM', () => {
  it('commits a budget, places three bids, refuses every departure, fills, burns and returns', async () => {
    const { w, cross, open, price, activeId } = await setup();
    const budget = 3_000_000_000n;
    const now = w.h.svm.getClock().unixTimestamp;
    const bps = (cross.data.buyerPaid * 1000n) / 10_000n;

    // The budget floor: less than 10% of what buyers paid is refused; a start in the past is refused.
    expect(bps > 0n && greenshoeMinBudget(cross.data.buyerPaid) <= budget).toBe(true);
    const thin = await buildCreateGreenshoe({ cross, creator: w.creator, budget: greenshoeMinBudget(cross.data.buyerPaid) - 1n, startTs: now, periodSecs: 3600n, periodCap: 1n });
    expect(await w.h.fail([cu, thin], w.creator)).toContain('GreenshoeBudget');
    const late = await buildCreateGreenshoe({ cross, creator: w.creator, budget, startTs: now - 10n, periodSecs: 3600n, periodCap: budget });
    expect(await w.h.fail([cu, late], w.creator)).toContain('GreenshoeWindow');
    const stranger = await w.h.wallet();
    expect(await w.h.fail([cu, await buildCreateGreenshoe({ cross, creator: stranger, budget, startTs: now, periodSecs: 3600n, periodCap: budget })], stranger)).toBeTruthy();

    const quoteBefore = await w.h.balanceOf(w.creator.address, w.quoteMint);
    await w.h.send([cu, await buildCreateGreenshoe({ cross, creator: w.creator, budget, startTs: now, periodSecs: 3600n, periodCap: 2_000_000_000n })], w.creator);
    const a = await greenshoeAddresses(cross.address);
    expect(await w.h.balanceOf(a.greenshoe, w.quoteMint)).toBe(0n);
    expect(await w.h.balance(a.vault)).toBe(budget);
    expect(await w.h.balanceOf(w.creator.address, w.quoteMint)).toBe(quoteBefore - budget);

    // DLMM keeps each limit order's bins in bin arrays that must exist first.
    const lbPair = new PublicKey(open.addresses.lbPair);
    const payerLegacy = new PublicKey(w.creator.address);
    const signers = { [w.creator.address]: w.creator };
    const lowestBin = greenshoeBinFor(price, cross.data.priceScale, 10, 2);
    // Every array from the lowest bid up to the active bin, because a swap walks them in order.
    for (let index = binArrayIndex(lowestBin) - 1; index <= binArrayIndex(activeId); index++) {
      const init = await m.initializeBinArray(new BN(index)).accounts({ lbPair, binArray: new PublicKey(binArrayAddress(open.addresses.lbPair, index)), funder: payerLegacy } as never).instruction();
      await w.h.send([cu, fromLegacy(init, signers)], w.creator);
    }

    // Departures: the wrong bin, a level that does not exist, an oversized level, a bin at or above the market.
    const bin = (l: number) => greenshoeBinFor(price, cross.data.priceScale, 10, l);
    const payer = await w.h.wallet();
    const order = async () => generateKeyPairSigner();
    const place = async (level: number, binId: number, amount: bigint) => buildDeployGreenshoeBid({ cross, payer, limitOrder: await order(), level, binId, amount });
    expect(await w.h.fail([cu, await place(0, bin(1), 1_000_000_000n)], payer)).toContain('GreenshoeBin');
    expect(await w.h.fail([cu, await place(0, activeId, 1_000_000_000n)], payer)).toContain('GreenshoeBin');
    expect(await w.h.fail([cu, await place(3, bin(0), 1n)], payer)).toContain('GreenshoeLevel');
    expect(await w.h.fail([cu, await place(0, bin(0), 1_000_000_001n)], payer)).toContain('GreenshoeBudget');
    expect(await w.h.fail([cu, await place(0, bin(0), 0n)], payer)).toContain('GreenshoeBudget');

    // Level 0 and 1 fit the per-period cap of 2,000,000,000; level 2 in the same period does not.
    const orders: { level: number; signer: Awaited<ReturnType<typeof generateKeyPairSigner>> }[] = [];
    for (const level of [0, 1]) {
      const signer = await order();
      await w.h.send([cu, await buildDeployGreenshoeBid({ cross, payer, limitOrder: signer, level, binId: bin(level), amount: 1_000_000_000n })], payer);
      orders.push({ level, signer });
    }
    expect(await w.h.fail([cu, await place(2, bin(2), 1_000_000_000n)], payer)).toContain('GreenshoeRateLimit');
    expect(await w.h.fail([cu, await place(0, bin(0), 1n)], payer)).toContain('GreenshoeLevel'); // a level is placed once
    expect(await w.h.balance(a.vault)).toBe(budget - 2_000_000_000n);

    // The next period allows the third level.
    w.h.setTime(now + 3_700n);
    const third = await order();
    await w.h.send([cu, await buildDeployGreenshoeBid({ cross, payer, limitOrder: third, level: 2, binId: bin(2), amount: 1_000_000_000n })], payer);
    orders.push({ level: 2, signer: third });
    expect(await w.h.balance(a.vault)).toBe(0n);

    // No exit before the week ends.
    const exit = (level: number) => buildSettleGreenshoeLevel({ cross, rentReceiver: w.creator.address, level, limitOrder: orders[level]!.signer.address, binId: bin(level), hook: false });
    expect(await w.h.fail([cu, await exit(0)], payer)).toContain('GreenshoeNotExpired');
    expect(await w.h.fail([cu, await buildFinishGreenshoe(cross)], payer)).toContain('GreenshoeNotExpired');

    // A seller walks the price down through all three bids on DLMM's own swap.
    const seller = await w.trader(0n, 8_000_000_000n);
    await w.h.ata(seller.address, w.quoteMint, w.admin);
    const lowest = Math.min(...[0, 1, 2].map(bin));
    const swapArrays = [];
    // Selling base walks the price down, so DLMM wants the arrays from the active bin's downwards.
    for (let i = binArrayIndex(activeId); i >= binArrayIndex(lowest) - 1; i--) swapArrays.push({ pubkey: new PublicKey(binArrayAddress(open.addresses.lbPair, i)), isSigner: false, isWritable: true });
    const baseBefore = await w.h.balanceOf(seller.address, w.baseMint);
    const quoteBeforeSale = await w.h.balanceOf(seller.address, w.quoteMint);
    const swap = await m
      .swap2(new BN(2_500_000_000), new BN(0), { slices: [] })
      .accounts({
        lbPair,
        binArrayBitmapExtension: PID,
        reserveX: new PublicKey(open.addresses.reserveX),
        reserveY: new PublicKey(open.addresses.reserveY),
        userTokenIn: new PublicKey(await ata(seller.address, w.baseMint, TOKEN_2022_PROGRAM_ADDRESS)),
        userTokenOut: new PublicKey(await ata(seller.address, w.quoteMint, TOKEN_2022_PROGRAM_ADDRESS)),
        tokenXMint: new PublicKey(w.baseMint),
        tokenYMint: new PublicKey(w.quoteMint),
        oracle: new PublicKey(open.addresses.oracle),
        hostFeeIn: PID,
        user: new PublicKey(seller.address),
        tokenXProgram: T22,
        tokenYProgram: T22,
        memoProgram: MEMO,
      } as never)
      .remainingAccounts(swapArrays)
      .instruction();
    await w.h.send([cu, fromLegacy(swap, { [seller.address]: seller })], seller);
    const sold = baseBefore - (await w.h.balanceOf(seller.address, w.baseMint));
    const received = (await w.h.balanceOf(seller.address, w.quoteMint)) - quoteBeforeSale;
    expect(sold > 0n && received > 0n).toBe(true);
    // The seller got no better than the three bids (0.90, 0.85, 0.80 of P*) allow.
    expect(Number(received) / Number(sold) <= (Number(price) / Number(cross.data.priceScale)) * 0.9 + 1e-9).toBe(true);

    // After the week anyone settles each placed level and finishes: bought tokens burned, unspent budget back to the issuer.
    w.h.setTime(now + WEEK + 10_000n);
    const supplyBefore = w.h.mintInfo(w.baseMint).supply;
    const proceedsBefore = await w.h.balanceOf(w.creator.address, w.quoteMint);
    for (const o of orders) await w.h.send([cu, await exit(o.level)], payer);
    expect(await w.h.fail([cu, await exit(0)], payer)).toContain('GreenshoeLevel'); // settled once
    const bought = await w.h.balance(a.baseAccount);
    expect(bought > 0n).toBe(true);
    await w.h.send([cu, await buildFinishGreenshoe(cross)], payer);
    expect(await w.h.fail([cu, await buildFinishGreenshoe(cross)], payer)).toContain('GreenshoeLevel'); // finishes once
    expect(w.h.mintInfo(w.baseMint).supply).toBe(supplyBefore - bought);
    expect(await w.h.balance(a.baseAccount)).toBe(0n);
    expect(await w.h.balance(a.vault)).toBe(0n);
    const returned = (await w.h.balanceOf(w.creator.address, w.quoteMint)) - proceedsBefore;
    // Conservation: what the bids paid the seller plus what returned is the whole budget, to within the pair fee kept inside DLMM.
    expect(returned + received <= budget).toBe(true);
    expect(returned + received >= budget - budget / 50n).toBe(true);
    // The base the bids bought is what the seller gave up, less the fee DLMM kept.
    expect(bought <= sold && bought >= sold - sold / 50n).toBe(true);
    console.table({ sold: Number(sold), received: Number(received), bought: Number(bought), returned: Number(returned), budget: Number(budget) });
  });
});
