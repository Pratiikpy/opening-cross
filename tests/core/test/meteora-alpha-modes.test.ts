// Alpha Vault modes and the depositor's exits (ADR-0910, rows X13, R2) on the real cp_amm and alpha_vault binaries: first-come mode with its caps, a
// pro-rata depositor who changes their mind (withdraw, then close the escrow), and what the vault refuses in each state.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { getSetComputeUnitLimitInstruction } from '@solana-program/compute-budget';
import { TOKEN_2022_PROGRAM_ADDRESS } from '@solana-program/token-2022';
import { OrderSide } from '@opening-cross/sdk';
import {
  ALPHA_VAULT_PROGRAM_ADDRESS,
  DAMM_V2_PROGRAM_ADDRESS,
  alphaEscrowAddress,
  buildAlphaClaim,
  buildAlphaCloseEscrow,
  buildAlphaDeposit,
  buildAlphaFillDammV2,
  buildAlphaWithdraw,
  buildAlphaWithdrawRemaining,
  buildInitializeAlphaVault,
  buildSeedDammV2,
} from '@opening-cross/adapters';
import { World } from '../src/world.js';
import { DAMM_FIXTURE } from '../src/harness.js';

const VAULT_FIXTURE = fileURLToPath(new URL('../../fixtures/alpha_vault.so', import.meta.url));
const T22 = TOKEN_2022_PROGRAM_ADDRESS;
const cu = getSetComputeUnitLimitInstruction({ units: 1_400_000 });
const observed: Record<string, string> = {};

/** Sends a transaction and returns 'ok' or the Anchor error name (or the tail of the failure) so a test can record what a program does in a state. */
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

/** A closed DAMM v2 pool bound to an Alpha Vault of the given mode, ready for deposits. */
async function market(mode: 'prorata' | 'fcfs', caps: { maxBuyingCap?: bigint; maxDepositingCap?: bigint; individualDepositingCap?: bigint }, depositingOffset = 0n) {
  const w = await World.create();
  w.h.svm.addProgramFromFile(ALPHA_VAULT_PROGRAM_ADDRESS, VAULT_FIXTURE);
  const cross = await clearedCross(w);
  await w.h.fund(w.baseMint, w.admin, w.creator.address, 20_000_000_000n);
  const now = w.h.svm.getClock().unixTimestamp;
  const start = now + 7200n;
  const seed = await buildSeedDammV2({
    cross, creator: w.creator, baseAmount: 5_000_000_000n, quoteAmount: 6_000_000_000n, feeBps: 300, alphaVault: true,
    batch: { windowSecs: 3600, activationPoint: start, endingFeeBps: 30, periods: 10, periodSecs: 60 },
  });
  await w.h.send([cu, seed.instruction], w.creator);
  const common = { funder: w.creator, base: w.creator, pool: seed.addresses.pool, baseMint: w.baseMint, baseTokenProgram: T22, quoteMint: w.quoteMint, quoteTokenProgram: T22, startVestingPoint: start + 100n, endVestingPoint: start + 200n, ...(depositingOffset > 0n && { depositingPoint: now + depositingOffset }) };
  const init = await buildInitializeAlphaVault(mode === 'prorata' ? { ...common, mode, maxBuyingCap: caps.maxBuyingCap! } : { ...common, mode, maxDepositingCap: caps.maxDepositingCap!, individualDepositingCap: caps.individualDepositingCap! });
  await w.h.send(init.instructions, w.creator);
  const pool = { address: seed.addresses.pool, authority: seed.addresses.poolAuthority, tokenAVault: seed.addresses.tokenAVault, tokenBVault: seed.addresses.tokenBVault, tokenAMint: w.baseMint, tokenBMint: w.quoteMint, tokenAProgram: T22, tokenBProgram: T22, eventAuthority: seed.addresses.eventAuthority, programAddress: DAMM_V2_PROGRAM_ADDRESS };
  const deposit = (who: Awaited<ReturnType<typeof w.trader>>, amount: bigint, withEscrow?: boolean) => buildAlphaDeposit({ vault: init.vault, pool: seed.addresses.pool, owner: who, quoteMint: w.quoteMint, quoteTokenProgram: T22, amount, tokenVault: init.tokenVault, ...(withEscrow !== undefined && { withEscrow }) });
  return { w, cross, seed, init, start, now, pool, deposit };
}

describe.skipIf(!existsSync(DAMM_FIXTURE) || !existsSync(VAULT_FIXTURE))('Alpha Vault first-come mode', () => {
  it('takes deposits in order up to its caps, refuses the excess and a withdrawal, fills and pays out in full', async () => {
    const m = await market('fcfs', { maxDepositingCap: 5_000_000_000n, individualDepositingCap: 3_000_000_000n });
    const { w, init, start } = m;
    const alice = await w.trader(20_000_000_000n);
    const bob = await w.trader(20_000_000_000n);
    const carol = await w.trader(20_000_000_000n);

    const vaultQuote = () => w.h.balanceOf(init.vault, w.quoteMint);
    const attempt = (ixs: Parameters<typeof w.h.send>[0], who: typeof alice) => tryTx(w, ixs, who);
    // The per-wallet cap: asking to deposit 4,000,000,000 against a cap of 3,000,000,000.
    observed.aliceAsks4 = await attempt(await m.deposit(alice, 4_000_000_000n), alice);
    observed.vaultAfterAlice = String(await vaultQuote());
    observed.aliceAsks1More = await attempt(await m.deposit(alice, 1n, false), alice);
    observed.vaultAfterAlice2 = String(await vaultQuote());
    observed.bobAsks3 = await attempt(await m.deposit(bob, 3_000_000_000n), bob);
    observed.vaultAfterBob = String(await vaultQuote());
    observed.carolAsks1 = await attempt(await m.deposit(carol, 1n), carol);
    observed.vaultAfterCarol = String(await vaultQuote());
    observed.carolQuote = String(await w.h.balanceOf(carol.address, w.quoteMint));
    // First-come mode clamps a deposit to what is left under the wallet's cap and under the vault's cap, and refuses one with no room at all:
    // Alice asked for 4,000,000,000 against a wallet cap of 3,000,000,000 and was charged 3,000,000,000; Bob asked for 3,000,000,000 and got the 2,000,000,000 left;
    // Carol arrived at a full vault, was refused, and kept her quote.
    expect([observed.aliceAsks4, observed.vaultAfterAlice, observed.aliceAsks1More, observed.bobAsks3, observed.vaultAfterBob, observed.carolAsks1, observed.carolQuote]).toEqual(['ok', '3000000000', 'DepositAmountIsZero', 'ok', '5000000000', 'DepositAmountIsZero', '20000000000']);

    // First-come mode has no deposit-window withdrawal.
    observed.fcfsWithdraw = await tryTx(w, [await buildAlphaWithdraw({ vault: init.vault, pool: m.seed.addresses.pool, owner: alice, quoteMint: w.quoteMint, quoteTokenProgram: T22, tokenVault: init.tokenVault, amount: 1n })], alice);
    expect(observed.fcfsWithdraw).toBe('VaultModeIsIncorrect');

    // The vault buys with everything it holds (it is not oversubscribed, so there is nothing to refund).
    w.h.setTime(start - 1800n);
    const cranker = await w.h.wallet();
    await w.h.send([cu, buildAlphaFillDammV2({ vault: init.vault, cranker, maxAmount: 5_000_000_000n, tokenVault: init.tokenVault, tokenOutVault: init.tokenOutVault, pool: m.pool })], cranker);
    const bought = await w.h.balanceOf(init.vault, w.baseMint);
    expect(bought > 0n).toBe(true);
    expect(await w.h.balanceOf(init.vault, w.quoteMint)).toBe(0n);

    w.h.setTime(start + 250n);
    for (const who of [alice, bob]) await w.h.send(await buildAlphaClaim({ vault: init.vault, owner: who, baseMint: w.baseMint, baseTokenProgram: T22, tokenOutVault: init.tokenOutVault }), who);
    const a = await w.h.balanceOf(alice.address, w.baseMint);
    const b = await w.h.balanceOf(bob.address, w.baseMint);
    expect(a + b <= bought && bought - (a + b) < 4n).toBe(true);
    expect(Number((a * 1000n) / b) / 1000).toBeCloseTo(1.5, 2);
    // Nobody had quote left over, so a refund withdrawal has nothing to return.
    const aliceQuote = await w.h.balanceOf(alice.address, w.quoteMint);
    observed.fcfsRefund = await tryTx(w, [await buildAlphaWithdrawRemaining({ vault: init.vault, pool: m.seed.addresses.pool, owner: alice, quoteMint: w.quoteMint, quoteTokenProgram: T22, tokenVault: init.tokenVault })], alice);
    observed.fcfsRefundMoved = String((await w.h.balanceOf(alice.address, w.quoteMint)) - aliceQuote);
    console.table(observed);
  });
});

describe.skipIf(!existsSync(DAMM_FIXTURE) || !existsSync(VAULT_FIXTURE))('Alpha Vault escrow cancellation', () => {
  it('lets a pro-rata depositor withdraw during the window and close their escrow, and refuses it in every other state', async () => {
    const m = await market('prorata', { maxBuyingCap: 8_000_000_000n });
    const { w, init, start } = m;
    const alice = await w.trader(20_000_000_000n);
    const bob = await w.trader(20_000_000_000n);
    const mallory = await w.trader(20_000_000_000n);
    await w.h.send(await m.deposit(alice, 4_000_000_000n), alice);
    await w.h.send(await m.deposit(bob, 2_000_000_000n), bob);
    const wd = (who: typeof alice, amount: bigint) => buildAlphaWithdraw({ vault: init.vault, pool: m.seed.addresses.pool, owner: who, quoteMint: w.quoteMint, quoteTokenProgram: T22, tokenVault: init.tokenVault, amount });

    const attempt = (ixs: Parameters<typeof w.h.send>[0], who: typeof alice) => tryTx(w, ixs, who);
    const quote = (who: typeof alice) => w.h.balanceOf(who.address, w.quoteMint);
    // A wallet with no escrow, a zero amount and a close while the escrow still holds a deposit are each refused by the vault itself.
    observed.noEscrow = await attempt([await wd(mallory, 1n)], mallory);
    observed.zero = await attempt([await wd(alice, 0n)], alice);
    observed.closeWithDeposit = await attempt([buildAlphaCloseEscrow({ vault: init.vault, owner: alice, rentReceiver: alice.address })], alice);
    expect([observed.noEscrow, observed.zero, observed.closeWithDeposit]).toEqual(['AccountOwnedByWrongProgram', 'WithdrawAmountIsZero', 'EscrowIsNotClosable']);

    // A withdrawal is clamped to the escrow: Alice takes 1,000,000,000 back, then asks for more than she has left and gets her remaining 3,000,000,000.
    await w.h.send([await wd(alice, 1_000_000_000n)], alice);
    expect(await quote(alice)).toBe(17_000_000_000n);
    expect(await attempt([await wd(alice, 4_000_000_001n)], alice)).toBe('ok');
    expect(await quote(alice)).toBe(20_000_000_000n);
    expect(await w.h.balanceOf(init.vault, w.quoteMint)).toBe(2_000_000_000n);

    // The empty escrow closes and its rent goes to the named receiver; a second close finds no escrow.
    const receiver = (await w.h.wallet(0n)).address;
    expect(w.h.exists(alphaEscrowAddress(init.vault, alice.address))).toBe(true);
    await w.h.send([buildAlphaCloseEscrow({ vault: init.vault, owner: alice, rentReceiver: receiver })], alice);
    expect(w.h.exists(alphaEscrowAddress(init.vault, alice.address))).toBe(false);
    expect((w.h.svm.getBalance(receiver) ?? 0n) > 0n).toBe(true);
    observed.closeTwice = await attempt([buildAlphaCloseEscrow({ vault: init.vault, owner: alice, rentReceiver: receiver })], alice);

    // Alice can come back: a fresh deposit opens a new escrow.
    await w.h.send(await m.deposit(alice, 1_000_000_000n), alice);
    expect(await w.h.balanceOf(init.vault, w.quoteMint)).toBe(3_000_000_000n);

    // After the fill the window is over: withdrawing is refused, and Bob's escrow cannot be closed before he has claimed.
    w.h.setTime(start - 1800n);
    const cranker = await w.h.wallet();
    await w.h.send([cu, buildAlphaFillDammV2({ vault: init.vault, cranker, maxAmount: 3_000_000_000n, tokenVault: init.tokenVault, tokenOutVault: init.tokenOutVault, pool: m.pool })], cranker);
    observed.withdrawAfterFill = await attempt([await wd(bob, 1n)], bob);
    observed.closeBeforeClaim = await attempt([buildAlphaCloseEscrow({ vault: init.vault, owner: bob, rentReceiver: bob.address })], bob);
    w.h.setTime(start + 250n);
    await w.h.send(await buildAlphaClaim({ vault: init.vault, owner: bob, baseMint: w.baseMint, baseTokenProgram: T22, tokenOutVault: init.tokenOutVault }), bob);
    observed.closeAfterClaim = await attempt([buildAlphaCloseEscrow({ vault: init.vault, owner: bob, rentReceiver: bob.address })], bob);
    observed.bobEscrowGone = String(!w.h.exists(alphaEscrowAddress(init.vault, bob.address)));
    // The vault spent every deposit (3,000,000,000 against a cap of 8,000,000,000), so nothing is left to withdraw; Bob's escrow still holds his claim
    // until he has claimed it, and closes once he has; a closed escrow no longer exists.
    expect([observed.closeTwice, observed.withdrawAfterFill, observed.closeBeforeClaim, observed.closeAfterClaim, observed.bobEscrowGone]).toEqual(['AccountOwnedByWrongProgram', 'WithdrawAmountIsZero', 'EscrowIsNotClosable', 'ok', 'true']);
    console.table(observed);
  });
});
