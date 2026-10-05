// End-to-end Meteora DBC continuation (ADR-0006) against the real mainnet DBC binary: a
// deferred-mint launch clears, the issuer opens a DBC pool whose start price is exactly P*, the
// adapter binds the mint, winners claim at P*, and finalize revokes the mint authority.
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { getSetComputeUnitLimitInstruction } from '@solana-program/compute-budget';
import { ActivationType, BaseFeeMode, CollectFeeMode, MigrationFeeOption, MigrationOption, TokenDecimal } from '@meteora-ag/dynamic-bonding-curve-sdk';
import { CrossState, OrderSide, SupplyMode, buildClaim } from '@opening-cross/sdk';
import { type ContinuationDesign, buildBindDbcMint, buildOpenDbcPool, settlerAddress, sqrtPriceQ64 } from '@opening-cross/meteora-adapters';
import { World } from '../src/world.js';
import { DBC_FIXTURE } from '../src/harness.js';

const design: ContinuationDesign = {
  token: { tokenBaseDecimal: TokenDecimal.SIX, tokenQuoteDecimal: TokenDecimal.SIX, totalTokenSupply: 1_000_000_000, leftover: 0 },
  fee: {
    baseFeeParams: { baseFeeMode: BaseFeeMode.FeeSchedulerLinear, feeSchedulerParam: { startingFeeBps: 100, endingFeeBps: 100, numberOfPeriod: 0, totalDuration: 0 } },
    dynamicFeeEnabled: false,
    collectFeeMode: CollectFeeMode.QuoteToken,
    creatorTradingFeePercentage: 0,
    poolCreationFee: 0,
    enableFirstSwapWithMinFee: false,
  },
  migration: { migrationOption: MigrationOption.MET_DAMM_V2, migrationFeeOption: MigrationFeeOption.FixedBps100, migrationFee: { feePercentage: 0, creatorFeePercentage: 0 } },
  liquidityDistribution: { partnerLiquidityPercentage: 0, partnerPermanentLockedLiquidityPercentage: 100, creatorLiquidityPercentage: 0, creatorPermanentLockedLiquidityPercentage: 0 },
  lockedVesting: { totalLockedVestingAmount: 0, numberOfVestingPeriod: 0, cliffUnlockAmount: 0, totalVestingDuration: 0, cliffDurationFromMigrationTime: 0 },
  activationType: ActivationType.Timestamp,
  sqrtPriceMultiples: [2, 4],
};

const schedule = [{ price: 1_000_000n, quantity: 2_000_000_000n }, { price: 1_500_000n, quantity: 2_000_000_000n }];

describe.skipIf(!existsSync(DBC_FIXTURE))('Meteora DBC continuation', () => {
  it('launch clears, DBC pool opens at exactly P*, winners claim, mint authority revoked', async () => {
    const w = await World.create();
    const crossAddr = await (await import('@opening-cross/sdk')).crossAddress(w.creator.address, 1n);
    const settler = await settlerAddress(crossAddr);
    const cross = await w.newCross({ supplyMode: SupplyMode.DeferredMint, schedule, settler, settleDeadlineTs: 1_800_001_000n });
    const a = await w.trader(10_000_000_000n);
    const b = await w.trader(10_000_000_000n);
    const orders = [await w.place(cross, a, OrderSide.Buy, 1_500_000n, 2_500_000_000n), await w.place(cross, b, OrderSide.Buy, 1_100_000n, 1_000_000_000n)];
    const settled = await w.settle(cross);
    expect(settled.data.state).toBe(CrossState.Cleared);
    const pStar = settled.data.clearing.__option === 'Some' ? settled.data.clearing.value.price : 0n;

    const cu = getSetComputeUnitLimitInstruction({ units: 1_400_000 });
    const open = await buildOpenDbcPool({ cross: settled, creator: w.creator, design, name: 'Proof Launch', symbol: 'PRF', uri: 'https://github.com/Pratiikpy/opening-cross' });
    const openCu = await w.h.send([cu, open.instruction], w.creator);
    // Read DBC's own pool account: PoolState.sqrt_price (offset 8 + 64 + 5·32 + 6·8 = 280,
    // from DBC IDL v0.2.1) must equal the cross's clearing price exactly.
    const poolAcct = w.h.svm.getAccount(open.addresses.pool);
    if (!poolAcct.exists) throw new Error('DBC pool not created');
    const live = Buffer.from(poolAcct.data).readBigUInt64LE(280) + (Buffer.from(poolAcct.data).readBigUInt64LE(288) << 64n);
    expect(live).toBe(sqrtPriceQ64(pStar, settled.data.priceScale));

    const bindCu = await w.h.send([cu, await buildBindDbcMint(w.view(cross.address), w.admin)], w.admin);
    console.table({ open_dbc_pool: Number(openCu), bind_dbc_mint: Number(bindCu), clearing_price: Number(pStar) });
    const bound = w.view(cross.address);
    expect(bound.data.baseBound).toBe(true);
    expect(bound.data.baseMint).toBe(open.addresses.baseMint);

    for (const o of orders) await w.h.send(await buildClaim(w.view(cross.address), w.admin, o.owner.address, o.nonce), w.admin);
    // a bid at 1.5 above P* fills fully; the bid at 1.1 is below P* when P* > 1.1
    const filledA = await w.h.balanceOf(a.address, bound.data.baseMint);
    expect(filledA > 0n).toBe(true);
    await w.finalize(w.view(cross.address));
    expect(w.h.mintInfo(bound.data.baseMint).mintAuthority.__option).toBe('None');
  });

  it('refuses a DBC start price that is not the clearing price, and non-creators', async () => {
    const w = await World.create();
    const sdk = await import('@opening-cross/sdk');
    const settler = await settlerAddress(await sdk.crossAddress(w.creator.address, 1n));
    const cross = await w.newCross({ supplyMode: SupplyMode.DeferredMint, schedule, settler, settleDeadlineTs: 1_800_001_000n });
    const a = await w.trader(10_000_000_000n);
    await w.place(cross, a, OrderSide.Buy, 1_500_000n, 2_500_000_000n);
    const settled = await w.settle(cross);
    const cu = getSetComputeUnitLimitInstruction({ units: 1_400_000 });

    // Tamper with the price: pretend the cross cleared one tick lower.
    const tampered = { ...settled, data: { ...settled.data, clearing: { __option: 'Some' as const, value: { ...(settled.data.clearing as { value: object }).value, price: 1_400_000n } } } } as typeof settled;
    const bad = await buildOpenDbcPool({ cross: tampered, creator: w.creator, design, name: 'X', symbol: 'X', uri: 'https://x' });
    expect(await w.h.fail([cu, bad.instruction], w.creator)).toContain('StartPriceNotClearingPrice');

    const mallory = await w.h.wallet();
    const stolen = await buildOpenDbcPool({ cross: settled, creator: mallory, design, name: 'X', symbol: 'X', uri: 'https://x' });
    expect(await w.h.fail([cu, stolen.instruction], mallory)).toContain('NotCreator');

    // Binding before the pool exists fails.
    expect(await w.h.fail([cu, await buildBindDbcMint(settled, w.admin)], w.admin)).toMatch(/AccountNotInitialized|PoolNotOpened/);
  });
});
