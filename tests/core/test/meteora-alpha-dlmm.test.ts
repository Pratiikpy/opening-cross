// Alpha Vault entry into a batch-opened DLMM pair (ADR-0910, rows X13, R2, V-D) on the real lb_clmm and alpha_vault binaries: depositors who missed the
// cross put quote into a vault bound to the pair, the vault buys base from the ladder before the pair opens (`fill_dlmm`), every depositor claims its share
// and takes back what did not fit, and the pair itself stays closed to the public until its start.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { generateKeyPairSigner } from '@solana/kit';
import { getSetComputeUnitLimitInstruction } from '@solana-program/compute-budget';
import { TOKEN_2022_PROGRAM_ADDRESS } from '@solana-program/token-2022';
import { OrderSide } from '@opening-cross/sdk';
import {
  ALPHA_VAULT_PROGRAM_ADDRESS,
  AlphaPoolType,
  buildAlphaClaim,
  buildAlphaDeposit,
  buildAlphaFillDlmm,
  buildAlphaWithdrawRemaining,
  buildDlmmConvictionLadder,
  buildInitializeAlphaVault,
  buildOpenDlmmPair,
  dlmmBinArraysBetween,
  dlmmPairFor,
} from '@opening-cross/adapters';
import { World } from '../src/world.js';
import { DLMM_FIXTURE } from '../src/harness.js';

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

describe.skipIf(!existsSync(DLMM_FIXTURE) || !existsSync(VAULT_FIXTURE))('Alpha Vault fill on a DLMM pair', () => {
  it('fills from the ladder before the pair opens, shares pro rata and refunds the excess', async () => {
    const w = await World.create();
    w.h.svm.addProgramFromFile(ALPHA_VAULT_PROGRAM_ADDRESS, VAULT_FIXTURE);
    const cross = await clearedCross(w);
    await w.h.fund(w.baseMint, w.admin, w.creator.address, 20_000_000_000n);
    const now = w.h.svm.getClock().unixTimestamp;
    const start = now + 7200n;
    const open = await buildOpenDlmmPair({ cross, creator: w.creator, binStep: 10, baseFactor: 10_000, batch: { windowSecs: 300, activationPoint: start, alphaVault: true } });
    await w.h.send([cu, open.instruction], w.creator);

    // The issuer's unsold base stands in the bins above P*; the vault will buy from it.
    const position = await generateKeyPairSigner();
    const ladder = await buildDlmmConvictionLadder({ cross, creator: w.creator, position, activeId: open.activeId, bins: 30, baseAmount: 3_000_000_000n, shape: 'flat' });
    await w.h.send([cu, ...ladder.instructions], w.creator);

    const cap = 2_000_000_000n;
    const init = await buildInitializeAlphaVault({
      mode: 'prorata', maxBuyingCap: cap, funder: w.creator, base: w.creator, pool: open.addresses.lbPair, poolType: AlphaPoolType.Dlmm,
      baseMint: w.baseMint, baseTokenProgram: T22, quoteMint: w.quoteMint, quoteTokenProgram: T22, startVestingPoint: start + 100n, endVestingPoint: start + 200n,
    });
    await w.h.send(init.instructions, w.creator);

    const alice = await w.trader(20_000_000_000n);
    const bob = await w.trader(20_000_000_000n);
    for (const [who, amount] of [[alice, 3_000_000_000n], [bob, 1_000_000_000n]] as const) {
      await w.h.send(await buildAlphaDeposit({ vault: init.vault, pool: open.addresses.lbPair, owner: who, quoteMint: w.quoteMint, quoteTokenProgram: T22, amount, tokenVault: init.tokenVault }), who);
    }
    expect(await w.h.balanceOf(init.vault, w.quoteMint)).toBe(4_000_000_000n);

    w.h.setTime(start - 1800n);
    const cranker = await w.h.wallet();
    const fill = buildAlphaFillDlmm({
      vault: init.vault, cranker, maxAmount: cap, tokenVault: init.tokenVault, tokenOutVault: init.tokenOutVault,
      pair: dlmmPairFor(w.baseMint, w.quoteMint, T22, T22),
      binArrays: dlmmBinArraysBetween(open.addresses.lbPair, open.activeId, ladder.upperBinId),
    });
    await w.h.send([cu, fill], cranker);
    const bought = await w.h.balanceOf(init.vault, w.baseMint);
    expect(bought > 0n).toBe(true);
    expect(await w.h.balanceOf(init.vault, w.quoteMint)).toBe(4_000_000_000n - cap);

    w.h.setTime(start + 250n);
    for (const who of [alice, bob]) {
      await w.h.send(await buildAlphaClaim({ vault: init.vault, owner: who, baseMint: w.baseMint, baseTokenProgram: T22, tokenOutVault: init.tokenOutVault }), who);
      await w.h.send([await buildAlphaWithdrawRemaining({ vault: init.vault, pool: open.addresses.lbPair, owner: who, quoteMint: w.quoteMint, quoteTokenProgram: T22, tokenVault: init.tokenVault })], who);
    }
    const a = await w.h.balanceOf(alice.address, w.baseMint);
    const b = await w.h.balanceOf(bob.address, w.baseMint);
    expect(a + b <= bought && bought - (a + b) < 4n).toBe(true);
    expect(Number((a * 1000n) / b) / 1000).toBeCloseTo(3, 1);
    expect(await w.h.balanceOf(alice.address, w.quoteMint)).toBe(20_000_000_000n - 3_000_000_000n + 1_500_000_000n);
    expect(await w.h.balanceOf(bob.address, w.quoteMint)).toBe(20_000_000_000n - 1_000_000_000n + 500_000_000n);
    expect(await w.h.balanceOf(init.vault, w.quoteMint)).toBe(0n);
  });
});
