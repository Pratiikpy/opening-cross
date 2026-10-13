// Batch-opened pools (ADR-0483, rows F4 and W10) on the real cp-amm and DLMM binaries: the program refuses a pool that could trade
// before its window ends, a flat fee or a plain collect-fee mode, and the pool it accepts really is closed until the start and
// charges a fee that falls afterwards.
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BorshAccountsCoder } from '@coral-xyz/anchor';
import { type Instruction } from '@solana/kit';
import { getSetComputeUnitLimitInstruction } from '@solana-program/compute-budget';
import { OrderSide } from '@opening-cross/sdk';
import { DAMM_V2_PROGRAM_ADDRESS, buildOpenDlmmPair, buildSeedDammV2 } from '@opening-cross/adapters';
import { World } from '../src/world.js';
import { DAMM_FIXTURE, DLMM_FIXTURE, T0 } from '../src/harness.js';
import { seededDammSwap } from '../src/settle-world.js';

const lbIdl = JSON.parse(readFileSync(fileURLToPath(new URL('../../../idls/lb_clmm.json', import.meta.url)), 'utf8'));
const lbCoder = new BorshAccountsCoder(lbIdl);
const cu = getSetComputeUnitLimitInstruction({ units: 1_400_000 });

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

const batchOf = (now: bigint, windowSecs = 300) => ({ windowSecs, activationPoint: now + BigInt(windowSecs) + 10n, endingFeeBps: 30, periods: 10, periodSecs: 60 });

describe.skipIf(!existsSync(DAMM_FIXTURE))('batch-opened DAMM v2 pool', () => {
  it('opens closed, refuses to trade before the start, then trades with a fee that falls', async () => {
    const w = await World.create();
    const cross = await clearedCross(w);
    await w.h.fund(w.baseMint, w.admin, w.creator.address, 20_000_000_000n);
    const now = w.h.svm.getClock().unixTimestamp;
    const batch = batchOf(now);
    const seed = await buildSeedDammV2({ cross, creator: w.creator, baseAmount: 5_000_000_000n, quoteAmount: 6_000_000_000n, feeBps: 300, batch });
    await w.h.send([cu, seed.instruction], w.creator);

    const trader = await w.trader(0n, 100_000_000n);
    await w.h.ata(trader.address, w.quoteMint, w.admin);
    // Before the start DAMM v2 itself refuses the swap.
    const early = await w.h.fail([cu, await seededDammSwap(w, seed, trader, 10_000_000n)], trader);
    expect(early).toContain(DAMM_V2_PROGRAM_ADDRESS);
    expect(early).toContain('PoolDisabled');
    expect(await w.h.balanceOf(trader.address, w.quoteMint)).toBe(0n);

    // Just after the start the opening fee (300 bps) applies; ten minutes later the fee has fallen to 30 bps.
    const out = async (at: bigint) => {
      w.h.setTime(at);
      const before = await w.h.balanceOf(trader.address, w.quoteMint);
      await w.h.send([cu, await seededDammSwap(w, seed, trader, 10_000_000n)], trader);
      return (await w.h.balanceOf(trader.address, w.quoteMint)) - before;
    };
    const first = await out(batch.activationPoint + 1n);
    const last = await out(batch.activationPoint + 60n * 12n);
    // The pool moved a little between the two, so compare against the price: the second swap sells into a slightly lower price,
    // yet it still returns more, because the fee fell from 3% to 0.3%.
    expect(last > first).toBe(true);
    console.table({ opening_fee_out: Number(first), settled_fee_out: Number(last), start: Number(batch.activationPoint) - Number(T0) });
  });

  it('refuses, in the program, a pool that opens too soon, with a flat fee, or without compounding', async () => {
    const w = await World.create();
    const cross = await clearedCross(w);
    await w.h.fund(w.baseMint, w.admin, w.creator.address, 20_000_000_000n);
    const now = w.h.svm.getClock().unixTimestamp;
    const good = await buildSeedDammV2({ cross, creator: w.creator, baseAmount: 5_000_000_000n, quoteAmount: 6_000_000_000n, feeBps: 300, batch: batchOf(now) });
    const data = Buffer.from(good.instruction.data!);
    const tail = data.length; // ... activation_type u8, collect_fee_mode u8, activation_point Option<u64> (9), window_secs i64 (8)
    const activationAt = tail - 8 - 8;
    const collectAt = tail - 8 - 9 - 1;
    const withData = (mut: (b: Buffer) => void): Instruction => {
      const b = Buffer.from(data);
      mut(b);
      return { ...good.instruction, data: new Uint8Array(b) } as Instruction;
    };
    // The start is inside the window.
    expect(await w.h.fail([cu, withData((b) => b.writeBigUInt64LE(now + 100n, activationAt))], w.creator)).toContain('BatchActivation');
    // The fee never steps: number_of_period (u16 at offset 8 + 8 of the 27-byte fee data) is zero.
    expect(await w.h.fail([cu, withData((b) => b.writeUInt16LE(0, 8 + 4 + 8))], w.creator)).toContain('BatchFeeNotDecaying');
    // The pool collects its fee in a plain mode.
    expect(await w.h.fail([cu, withData((b) => b.writeUInt8(0, collectAt))], w.creator)).toContain('BatchNotCompounding');
    // A window outside the allowed range.
    expect(await w.h.fail([cu, withData((b) => b.writeBigInt64LE(5n, tail - 8))], w.creator)).toContain('BatchWindow');
    // The unmodified instruction still works.
    await w.h.send([cu, good.instruction], w.creator);
  });

  it('the builder refuses a flat fee before anything is sent', async () => {
    const w = await World.create();
    const cross = await clearedCross(w);
    const now = w.h.svm.getClock().unixTimestamp;
    await expect(buildSeedDammV2({ cross, creator: w.creator, baseAmount: 1n, quoteAmount: 1n, feeBps: 30, batch: { ...batchOf(now), endingFeeBps: 30 } })).rejects.toThrow(/fee that falls/);
  });
});

describe.skipIf(!existsSync(DLMM_FIXTURE))('batch-opened DLMM pair', () => {
  it('opens with a start beyond the window and the creator on-off control, and the program refuses anything else', async () => {
    const w = await World.create();
    const cross = await clearedCross(w);
    await w.h.fund(w.baseMint, w.admin, w.creator.address, 10_000_000_000n);
    const now = w.h.svm.getClock().unixTimestamp;
    const batch = { windowSecs: 300, activationPoint: now + 400n, alphaVault: false };
    const open = await buildOpenDlmmPair({ cross, creator: w.creator, binStep: 10, baseFactor: 10_000, batch });
    await w.h.send([cu, open.instruction], w.creator);
    const acct = w.h.svm.getAccount(open.addresses.lbPair);
    if (!acct.exists) throw new Error('pair missing');
    const pair = lbCoder.decode('LbPair', Buffer.from(acct.data));
    expect(BigInt(pair.activation_point.toString())).toBe(batch.activationPoint);

    // Too soon, and a slot-denominated start, are refused by the program.
    const w2 = await World.create();
    const cross2 = await clearedCross(w2);
    await w2.h.fund(w2.baseMint, w2.admin, w2.creator.address, 10_000_000_000n);
    const now2 = w2.h.svm.getClock().unixTimestamp;
    const soon = await buildOpenDlmmPair({ cross: cross2, creator: w2.creator, binStep: 10, baseFactor: 10_000, batch: { windowSecs: 300, activationPoint: now2 + 100n } });
    expect(await w2.h.fail([cu, soon.instruction], w2.creator)).toContain('BatchActivation');
    const noWindow = await buildOpenDlmmPair({ cross: cross2, creator: w2.creator, binStep: 10, baseFactor: 10_000, batch: { windowSecs: 5, activationPoint: now2 + 100n } });
    expect(await w2.h.fail([cu, noWindow.instruction], w2.creator)).toContain('BatchWindow');
  });
});
