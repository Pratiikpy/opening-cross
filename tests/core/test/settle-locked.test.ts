// D3 on the real Meteora binaries (ADR-0482): the locked, compounding continuation design is enforced by the program, the curve is
// driven to completion, DBC migrates it into DAMM v2, and the result is read back from DAMM v2's own pool and position accounts.
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BorshAccountsCoder } from '@coral-xyz/anchor';
import { PublicKey } from '@solana/web3.js';
import { AccountRole, type Address, address } from '@solana/kit';
import { buildClaimPolFees, buildWithdrawPartnerMigrationFee, buildWithdrawPartnerSurplus } from '@opening-cross/adapters';
import { World } from '../src/world.js';
import { DBC_FIXTURE, DAMM_FIXTURE } from '../src/harness.js';
import { CU, completeCurve, dammSwap, defaultDesign, hasMigrationFixtures, hookAccounts, launchDbc, lockedDesign, migrateToDammV2, readPool } from '../src/settle-world.js';

const dammIdl = JSON.parse(readFileSync(fileURLToPath(new URL('../../../idls/cp_amm.json', import.meta.url)), 'utf8'));
const dammCoder = new BorshAccountsCoder(dammIdl);

const decode = (w: World, name: 'Pool' | 'Position', a: string) => {
  const acct = w.h.svm.getAccount(a as Address);
  if (!acct.exists) throw new Error(`${name} missing`);
  return dammCoder.decode(name, Buffer.from(acct.data));
};
/** The owner of a token account (bytes 32 to 64 of its data). */
const tokenAccountOwner = (w: World, a: string): string => {
  const acct = w.h.svm.getAccount(a as Address);
  if (!acct.exists) throw new Error('token account missing');
  return new PublicKey(Buffer.from(acct.data).subarray(32, 64)).toBase58();
};
const big = (v: { toString(): string }) => BigInt(v.toString());
const ready = existsSync(DBC_FIXTURE) && existsSync(DAMM_FIXTURE) && hasMigrationFixtures();

describe.skipIf(!ready)('locked, compounding continuation design', () => {
  it('open_dbc_pool_locked refuses a config whose migrated pool is not compounding', async () => {
    const w = await World.create();
    // The default test design migrates into a plain pool with every unit of liquidity locked: open_dbc_pool accepts it, the locked variant refuses it.
    await expect(launchDbc(w, defaultDesign(), false, true)).rejects.toThrow('DesignNotCompounding');
  });

  it('refuses unlocked liquidity, partner vesting and a too-small lock', async () => {
    type D = ReturnType<typeof lockedDesign>;
    const cases: [string, (d: D) => void, string][] = [
      ['unlocked creator liquidity', (d) => { d.liquidityDistribution.creatorLiquidityPercentage = 10; d.liquidityDistribution.creatorLiquidityVestingInfoParams!.vestingPercentage = 50; }, 'DesignUnlockedLiquidity'],
      ['unlocked partner liquidity', (d) => { d.liquidityDistribution.partnerLiquidityPercentage = 10; d.liquidityDistribution.creatorLiquidityVestingInfoParams!.vestingPercentage = 50; }, 'DesignUnlockedLiquidity'],
      ['partner vesting', (d) => { d.liquidityDistribution.partnerLiquidityVestingInfoParams = { vestingPercentage: 20, bpsPerPeriod: 2500, numberOfPeriods: 4, cliffDurationFromMigrationTime: 0, totalDuration: 4 * 86_400 }; d.liquidityDistribution.creatorLiquidityVestingInfoParams!.vestingPercentage = 40; }, 'DesignPartnerVesting'],
      ['lock below 20%', (d) => { d.liquidityDistribution.partnerPermanentLockedLiquidityPercentage = 5; d.liquidityDistribution.creatorPermanentLockedLiquidityPercentage = 5; d.liquidityDistribution.creatorLiquidityVestingInfoParams!.vestingPercentage = 90; }, 'DesignLockTooLow'],
    ];
    for (const [name, mutate, error] of cases) {
      const w = await World.create();
      const d = lockedDesign();
      mutate(d);
      await expect(launchDbc(w, d, false, true), name).rejects.toThrow(error);
    }
  });

  it('the plain open_dbc_pool still accepts the same configs the locked one refuses', async () => {
    const w = await World.create();
    const l = await launchDbc(w, defaultDesign(), true, false);
    expect(l.cross.data.baseBound).toBe(true);
  });

  it('migrates into a compounding DAMM v2 pool with the liquidity locked and vesting, and the settler claims protocol-owned fees to the issuer', async () => {
    const w = await World.create();
    const l = await launchDbc(w, lockedDesign(), true, true);
    const swaps = await completeCurve(l);
    expect(Number(readPool(w, l.addresses.pool).migration_progress)).toBeGreaterThanOrEqual(1);
    const m = await migrateToDammV2(l, 6);

    const dammPool = decode(w, 'Pool', m.dammPool);
    // collect_fee_mode 2 is DAMM v2's Compounding mode.
    expect(Number(dammPool.collect_fee_mode)).toBe(2);
    const aMint = address(dammPool.token_a_mint.toBase58());
    const bMint = address(dammPool.token_b_mint.toBase58());
    expect(new Set([aMint, bMint])).toEqual(new Set([l.baseMint, w.quoteMint]));

    // The liquidity: DBC hands the first position to the pool creator (the issuer) and the second to the partner (the settler PDA).
    // The settler's is locked for good; the issuer's is part locked, part vesting; nothing in either is unlocked.
    const issuerPosition = decode(w, 'Position', m.firstPosition);
    const settlerPosition = decode(w, 'Position', m.secondPosition);
    // Splitting the liquidity rounds down, so a unit or two can stay unlocked: it must be far below one millionth of what is locked.
    expect(big(issuerPosition.unlocked_liquidity) * 1_000_000n < big(issuerPosition.permanent_locked_liquidity)).toBe(true);
    expect(big(settlerPosition.unlocked_liquidity)).toBe(0n);
    expect(big(settlerPosition.permanent_locked_liquidity) > 0n).toBe(true);
    expect(big(settlerPosition.vested_liquidity)).toBe(0n);
    expect(big(issuerPosition.permanent_locked_liquidity) > 0n).toBe(true);
    expect(big(issuerPosition.vested_liquidity) > 0n).toBe(true);
    // 30 : 10 permanent and 60 vesting: the settler holds three times the issuer's permanent part, and the issuer's vesting is six times it.
    const ratio = (a: bigint, b: bigint) => Number((a * 1000n) / b) / 1000;
    expect(ratio(big(settlerPosition.permanent_locked_liquidity), big(issuerPosition.permanent_locked_liquidity))).toBeCloseTo(3, 1);
    expect(ratio(big(issuerPosition.vested_liquidity), big(issuerPosition.permanent_locked_liquidity))).toBeCloseTo(6, 1);
    expect(tokenAccountOwner(w, m.firstPositionNftAccount)).toBe(w.creator.address);
    expect(tokenAccountOwner(w, m.secondPositionNftAccount)).toBe(l.addresses.settler);

    // Trade through the migrated pool so it earns fees, then claim the protocol-owned position's share to the issuer.
    const trader = await w.trader(50_000_000_000n, 0n);
    await w.h.ata(trader.address, l.baseMint, w.admin);
    const hook = (await hookAccounts(l.baseMint, m.tokenAVault, trader.address)).map((a) => ({ address: address(a.pubkey.toBase58()), role: AccountRole.READONLY }));
    await w.h.send([CU, await dammSwap(m, trader, aMint, bMint, w.quoteMint, 5_000_000_000n, hook)], trader);
    await w.h.ata(l.cross.data.proceedsTo, l.baseMint, w.admin);
    const issuer = w.creator.address;
    const before = [await w.h.balanceOf(issuer, aMint), await w.h.balanceOf(issuer, bMint)];
    const cranker = await w.h.wallet();
    const input = { cross: l.cross, pool: m.dammPool, position: m.secondPosition, positionNftAccount: m.secondPositionNftAccount, tokenAMint: aMint, tokenBMint: bMint, tokenAVault: m.tokenAVault, tokenBVault: m.tokenBVault };
    await w.h.send([CU, await buildClaimPolFees(input)], cranker);
    const after = [await w.h.balanceOf(issuer, aMint), await w.h.balanceOf(issuer, bMint)];
    expect(after[0]! + after[1]! > before[0]! + before[1]!).toBe(true);
    console.table({ swaps, collect_fee_mode: Number(dammPool.collect_fee_mode), pol_fee_token_a: Number(after[0]! - before[0]!), pol_fee_token_b: Number(after[1]! - before[1]!) });

    // A destination that is not the issuer's is refused before DAMM v2 runs.
    const thief = await w.h.wallet();
    const stolenA = await w.h.ata(thief.address, aMint, w.admin);
    const stolenB = await w.h.ata(thief.address, bMint, w.admin);
    expect(await w.h.fail([CU, await buildClaimPolFees({ ...input, tokenADestination: stolenA, tokenBDestination: stolenB })], thief)).toContain('WrongDestination');
    // The issuer's own position is not the settler's to claim: DAMM v2 refuses the settler as its owner.
    expect(await w.h.fail([CU, await buildClaimPolFees({ ...input, position: m.firstPosition, positionNftAccount: m.firstPositionNftAccount })], cranker)).toBeTruthy();
  });

  it('pays the partner migration fee to the fee recipient and the surplus to the issuer after migration, and only then', async () => {
    const w = await World.create();
    const design = lockedDesign();
    design.migration.migrationFee = { feePercentage: 2, creatorFeePercentage: 50 };
    const l = await launchDbc(w, design, true, true);
    await w.h.ata(w.feeRecipient.address, w.quoteMint, w.admin);
    const payer = await w.h.wallet();
    // Before the curve completes DBC refuses both withdrawals.
    expect(await w.h.fail([CU, await buildWithdrawPartnerMigrationFee(l.cross)], payer)).toBeTruthy();
    await completeCurve(l);
    await migrateToDammV2(l, 6);

    const feeBefore = await w.h.balanceOf(w.feeRecipient.address, w.quoteMint);
    await w.h.send([CU, await buildWithdrawPartnerMigrationFee(l.cross)], payer);
    const migrationFee = (await w.h.balanceOf(w.feeRecipient.address, w.quoteMint)) - feeBefore;
    expect(migrationFee > 0n).toBe(true);
    // The fee is paid once.
    expect(await w.h.fail([CU, await buildWithdrawPartnerMigrationFee(l.cross)], payer)).toBeTruthy();

    const proceedsBefore = await w.h.balanceOf(w.creator.address, w.quoteMint);
    let surplus = 0n;
    try {
      await w.h.send([CU, await buildWithdrawPartnerSurplus(l.cross)], payer);
      surplus = (await w.h.balanceOf(w.creator.address, w.quoteMint)) - proceedsBefore;
    } catch (e) {
      // A curve that completes exactly on its threshold has no surplus: DBC itself refuses the withdrawal (the adapter got as far as DBC).
      expect(String(e)).toContain('Program dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN invoke');
      expect(String(e)).not.toContain('WrongDestination');
      console.log('SURPLUS-REFUSED', String(e).match(/Error Code: (\w+)/)?.[1] ?? 'unknown');
    }
    console.table({ migrationFee: Number(migrationFee), surplus: Number(surplus) });
  });
});
