// Stock-quoted pools (ADR-0485, rows X12 and C1): a tokenized stock carries Token-2022 extensions that Meteora refuses without a
// Token Badge. The adapter passes the badge through; the refusal and the acceptance are read from the real DLMM binary.
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { getSetComputeUnitLimitInstruction } from '@solana-program/compute-budget';
import { OrderSide } from '@opening-cross/sdk';
import { buildOpenDlmmPair, dlmmTokenBadgeAddress } from '@opening-cross/adapters';
import { World } from '../src/world.js';
import { DLMM_FIXTURE } from '../src/harness.js';
import { plantDlmmTokenBadge, useStockQuoteMint } from '../src/settle-world.js';

const cu = getSetComputeUnitLimitInstruction({ units: 1_400_000 });

async function clearedStockCross(w: World) {
  await useStockQuoteMint(w);
  const cross = await w.newCross();
  const s = await w.trader(0n, 5_000_000_000n);
  const b = await w.trader(20_000_000_000n);
  const orders = [await w.place(cross, s, OrderSide.Sell, 1_200_000n, 2_000_000_000n), await w.place(cross, b, OrderSide.Buy, 1_300_000n, 2_000_000_000n)];
  const settled = await w.settle(cross);
  await w.claimAll(settled, orders);
  await w.finalize(w.view(cross.address));
  await w.h.fund(w.baseMint, w.admin, w.creator.address, 10_000_000_000n);
  return w.view(cross.address);
}

describe.skipIf(!existsSync(DLMM_FIXTURE))('DLMM pair quoted in a stock-like mint', () => {
  it('DLMM refuses the mint without a badge and accepts it with one', async () => {
    const w = await World.create();
    const cross = await clearedStockCross(w);
    // Without a badge Meteora itself refuses the pair; the adapter forwards the refusal.
    const plain = await buildOpenDlmmPair({ cross, creator: w.creator, binStep: 10, baseFactor: 10_000 });
    const refusal = await w.h.fail([cu, plain.instruction], w.creator);
    expect(refusal).toContain('LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo');
    expect(refusal).toContain('UnsupportedMintExtension');

    // With a badge for the quote mint the same pair opens at P*.
    plantDlmmTokenBadge(w, cross.data.quoteMint, dlmmTokenBadgeAddress(cross.data.quoteMint));
    const badged = await buildOpenDlmmPair({ cross, creator: w.creator, binStep: 10, baseFactor: 10_000, badges: { quote: true } });
    await w.h.send([cu, badged.instruction], w.creator);
    expect(w.h.svm.getAccount(badged.addresses.lbPair).exists).toBe(true);
  });

  it('refuses the wrong number of badge accounts and a badge slot for the wrong mint', async () => {
    const w = await World.create();
    const cross = await clearedStockCross(w);
    plantDlmmTokenBadge(w, cross.data.quoteMint, dlmmTokenBadgeAddress(cross.data.quoteMint));
    const ok = await buildOpenDlmmPair({ cross, creator: w.creator, binStep: 10, baseFactor: 10_000, badges: { quote: true } });
    // One badge account instead of two.
    const short = { ...ok.instruction, accounts: ok.instruction.accounts!.slice(0, -1) };
    expect(await w.h.fail([cu, short], w.creator)).toContain('BadgeAccounts');
    // A badge in the base slot that is not the base mint's badge: DLMM rejects it.
    const swapped = { ...ok.instruction, accounts: [...ok.instruction.accounts!.slice(0, -2), ok.instruction.accounts!.at(-1)!, ok.instruction.accounts!.at(-1)!] };
    expect(await w.h.fail([cu, swapped], w.creator)).toBeTruthy();
  });
});
