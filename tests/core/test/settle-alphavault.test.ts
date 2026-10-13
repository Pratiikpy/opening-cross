// Alpha Vault entry into a batch-opened DAMM v2 pool (ADR-0484) on the real vault and cp-amm binaries: depositors who missed the
// cross put quote into a pro-rata vault bound to the pool, the vault buys from the closed pool before it opens, and every depositor
// claims base and takes back the quote that did not fit.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { address } from '@solana/kit';
import { getSetComputeUnitLimitInstruction } from '@solana-program/compute-budget';
import { TOKEN_2022_PROGRAM_ADDRESS } from '@solana-program/token-2022';
import { OrderSide } from '@opening-cross/sdk';
import {
  ALPHA_VAULT_PROGRAM_ADDRESS,
  DAMM_V2_PROGRAM_ADDRESS,
  buildAlphaClaim,
  buildAlphaDeposit,
  buildAlphaFillDammV2,
  buildAlphaWithdrawRemaining,
  buildInitializeAlphaVault,
  buildSeedDammV2,
} from '@opening-cross/adapters';
import { World } from '../src/world.js';
import { seededDammSwap } from '../src/settle-world.js';
import { DAMM_FIXTURE } from '../src/harness.js';

const VAULT_FIXTURE = fileURLToPath(new URL('../../fixtures/alpha_vault.so', import.meta.url));
const T22 = TOKEN_2022_PROGRAM_ADDRESS;
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

describe.skipIf(!existsSync(DAMM_FIXTURE) || !existsSync(VAULT_FIXTURE))('Alpha Vault entry into a closed pool', () => {
  it('fills before the pool opens, shares pro rata, refunds the excess and refuses a public swap and a second fill', async () => {
    const w = await World.create();
    w.h.svm.addProgramFromFile(ALPHA_VAULT_PROGRAM_ADDRESS, VAULT_FIXTURE);
    const cross = await clearedCross(w);
    await w.h.fund(w.baseMint, w.admin, w.creator.address, 20_000_000_000n);
    const now = w.h.svm.getClock().unixTimestamp;
    // DAMM v2 requires an Alpha Vault pool to start between one hour and 31 days away; the vault buys in the hour before the start.
    const start = now + 7200n;
    const seed = await buildSeedDammV2({
      cross, creator: w.creator, baseAmount: 5_000_000_000n, quoteAmount: 6_000_000_000n, feeBps: 300, alphaVault: true,
      batch: { windowSecs: 3600, activationPoint: start, endingFeeBps: 30, periods: 10, periodSecs: 60 },
    });
    await w.h.send([cu, seed.instruction], w.creator);

    // A pro-rata vault with a cap smaller than the deposits, bound to this pool and these mints.
    // DAMM v2 derives the one vault allowed to buy early from the pool and the account that created it, so the vault base is the creator.
    const base = w.creator;
    const cap = 8_000_000_000n;
    const init = await buildInitializeAlphaVault({
      mode: 'prorata', maxBuyingCap: cap, funder: w.creator, base, pool: seed.addresses.pool, baseMint: w.baseMint, baseTokenProgram: T22, quoteMint: w.quoteMint, quoteTokenProgram: T22,
      startVestingPoint: start + 100n, endVestingPoint: start + 200n,
    });
    await w.h.send(init.instructions, w.creator);

    // Two depositors put in 9 and 3 (12 against a cap of 8): oversubscribed 1.5 times.
    const alice = await w.trader(20_000_000_000n);
    const bob = await w.trader(20_000_000_000n);
    for (const [who, amount] of [[alice, 9_000_000_000n], [bob, 3_000_000_000n]] as const) {
      await w.h.send(await buildAlphaDeposit({ vault: init.vault, pool: seed.addresses.pool, owner: who, quoteMint: w.quoteMint, quoteTokenProgram: T22, amount, tokenVault: init.tokenVault }), who);
    }
    expect(await w.h.balanceOf(init.vault, w.quoteMint)).toBe(12_000_000_000n);

    // The pool is closed to everyone but the vault: a public swap is refused, the vault's fill is not.
    w.h.setTime(start - 1800n);
    const cranker = await w.h.wallet();
    const fill = buildAlphaFillDammV2({
      vault: init.vault, cranker, maxAmount: cap, tokenVault: init.tokenVault, tokenOutVault: init.tokenOutVault,
      pool: { address: seed.addresses.pool, authority: seed.addresses.poolAuthority, tokenAVault: seed.addresses.tokenAVault, tokenBVault: seed.addresses.tokenBVault, tokenAMint: w.baseMint, tokenBMint: w.quoteMint, tokenAProgram: T22, tokenBProgram: T22, eventAuthority: seed.addresses.eventAuthority, programAddress: DAMM_V2_PROGRAM_ADDRESS },
    });
    const outsider = await w.trader(0n, 100_000_000n);
    await w.h.ata(outsider.address, w.quoteMint, w.admin);
    expect(await w.h.fail([cu, await seededDammSwap(w, seed, outsider, 10_000_000n)], outsider)).toContain('PoolDisabled');
    await w.h.send([cu, fill], cranker);
    const bought = await w.h.balanceOf(init.vault, w.baseMint);
    expect(bought > 0n).toBe(true);
    // The vault spent its cap (the rest of the deposits stays in it to be returned).
    expect(await w.h.balanceOf(init.vault, w.quoteMint)).toBe(12_000_000_000n - cap);

    // The vault cannot be filled twice: it has spent its cap.
    expect(await w.h.fail([cu, fill], cranker)).toBeTruthy();

    // After the vesting start everyone claims their share of what was bought and withdraws the quote that did not fit.
    w.h.setTime(start + 250n);
    for (const who of [alice, bob]) {
      await w.h.send(await buildAlphaClaim({ vault: init.vault, owner: who, baseMint: w.baseMint, baseTokenProgram: T22, tokenOutVault: init.tokenOutVault }), who);
      await w.h.send([await buildAlphaWithdrawRemaining({ vault: init.vault, pool: seed.addresses.pool, owner: who, quoteMint: w.quoteMint, quoteTokenProgram: T22, tokenVault: init.tokenVault })], who);
    }
    const a = await w.h.balanceOf(alice.address, w.baseMint);
    const b = await w.h.balanceOf(bob.address, w.baseMint);
    // Shares follow the deposits 3 : 1 to within rounding, and nothing is created or lost.
    expect(a + b <= bought && bought - (a + b) < 4n).toBe(true);
    expect(Number((a * 1000n) / b) / 1000).toBeCloseTo(3, 1);
    // Refunds: each gets back its deposit less its share of the cap (8/12 spent): 3 and 1 remain.
    expect(await w.h.balanceOf(alice.address, w.quoteMint)).toBe(20_000_000_000n - 9_000_000_000n + 3_000_000_000n);
    expect(await w.h.balanceOf(bob.address, w.quoteMint)).toBe(20_000_000_000n - 3_000_000_000n + 1_000_000_000n);
    expect(await w.h.balanceOf(init.vault, w.quoteMint)).toBe(0n);
    void address;
  });
});
