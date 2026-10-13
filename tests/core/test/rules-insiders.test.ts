// Issuer neutrality (ADR-0454): declared insiders are left out of the minimum raise, their fills unlock only
// after a cliff, and a bond behind the declaration is slashed by the arbiter when an undeclared insider is proven.
import { describe, expect, it } from 'vitest';
import {
  CrossState,
  NoPrintReason,
  OrderSide,
  SupplyMode,
  arbiterRegistryAddress,
  challengeAddress,
  getChallengeInsiderInstruction,
  getResolveChallengeInstruction,
  getSetArbiterInstruction,
  lockupAddress,
  protocolAddress,
  quoteVaultAddress,
  ata,
} from '@opening-cross/sdk';
import { RulesWorld } from '../src/rules-world.js';

const TOKEN = 1_000_000n;
const schedule = [{ price: 1_000_000n, quantity: 100n * TOKEN }];
const reason = (w: RulesWorld, cross: string) => {
  const d = w.view(cross as never).data;
  return d.noPrintReason.__option === 'Some' ? d.noPrintReason.value : null;
};

describe('declared insiders', () => {
  async function launch(minRaise: bigint) {
    const w = await RulesWorld.createRules();
    const insider = await w.trader(100_000_000_000n);
    const outsider = await w.trader(100_000_000_000n);
    const cross = await w.newRuledCross({
      supplyMode: SupplyMode.Mint,
      schedule,
      rules: {
        guards: { minRaiseQuote: minRaise },
        neutrality: { insiders: [insider.address], insiderCliffSecs: 1_000 },
      },
    });
    const orders = [
      await w.place(cross, insider, OrderSide.Buy, 1_000_000n, 60n * TOKEN),
      await w.place(cross, outsider, OrderSide.Buy, 1_000_000n, 30n * TOKEN),
    ];
    return { w, cross: await w.settle(cross), orders, insider, outsider };
  }

  it('their allocation does not count toward the minimum raise', async () => {
    // 90 tokens matched at 1.0, 60 of them the insider's: only 30,000,000 quote atoms count.
    expect((await launch(30n * TOKEN)).cross.data.state).toBe(CrossState.Cleared);
    const short = await launch(30n * TOKEN + 1n);
    expect(short.cross.data.state).toBe(CrossState.NoPrint);
    expect(reason(short.w, short.cross.address)).toBe(NoPrintReason.BelowMinimumRaise);
  });

  it('their fills are locked behind the cliff and the rest are not', async () => {
    const { w, cross, orders, insider, outsider } = await launch(0n);
    await w.claimAll(cross, orders);
    expect(await w.h.balanceOf(outsider.address, cross.data.baseMint)).toBe(30n * TOKEN);
    expect(await w.h.balanceOf(insider.address, cross.data.baseMint)).toBe(0n);
    const lockup = await lockupAddress(cross.address, insider.address, orders[0]!.nonce);
    expect(w.h.svm.getAccount(lockup).exists).toBe(true);
    const release = async () => w.h.send(await w.releaseIxs(w.view(cross.address), w.admin, insider.address, orders[0]!.nonce), w.admin);
    await expect(release()).rejects.toThrow(/NothingToRelease/);
    w.h.setTime(w.h.svm.getClock().unixTimestamp + 1_001n);
    await release();
    expect(await w.h.balanceOf(insider.address, cross.data.baseMint)).toBe(60n * TOKEN);
  });
});

describe('the bond behind the declaration', () => {
  it('finalize waits out the challenge window; an upheld challenge slashes the bond; the rest returns to the issuer', async () => {
    const w = await RulesWorld.createRules();
    const insider = await w.trader(100_000_000_000n);
    const outsider = await w.trader(100_000_000_000n);
    const challenger = await w.trader(1_000_000_000n);
    const arbiter = await w.h.wallet();
    await w.h.send([getSetArbiterInstruction({ admin: w.admin, protocol: await protocolAddress(), registry: await arbiterRegistryAddress(), arbiter: arbiter.address })], w.admin);
    const cross = await w.newRuledCross({
      supplyMode: SupplyMode.Mint,
      schedule,
      rules: { neutrality: { insiders: [insider.address], insiderCliffSecs: 10, bondQuote: 1_000_000n, challengeSecs: 7_200 } },
    });
    const orders = [
      await w.place(cross, insider, OrderSide.Buy, 1_000_000n, 10n * TOKEN),
      await w.place(cross, outsider, OrderSide.Buy, 1_000_000n, 20n * TOKEN),
    ];
    const settled = await w.settle(cross);
    await w.claimAll(settled, orders);
    // The bond is in the vault and cannot be swept yet.
    await expect(w.finalize(settled)).rejects.toThrow(/ChallengesOutstanding/);

    const id = settled.ext!.neutralState.challenges;
    const challenge = await challengeAddress(cross.address, id);
    const wallet = await w.trader(0n);
    const evidence = new Uint8Array(32).fill(9);
    await w.h.send([getChallengeInsiderInstruction({ challenger, cross: cross.address, challenge, subject: wallet.address, evidence })], challenger);
    expect(w.view(cross.address).ext!.neutralState.openChallenges).toBe(1);
    // Nobody but the arbiter may rule.
    const resolve = async (signer: typeof arbiter, upheld: boolean, slash: bigint) =>
      getResolveChallengeInstruction({
        arbiter: signer,
        registry: await arbiterRegistryAddress(),
        cross: cross.address,
        challenge,
        challenger: challenger.address,
        feeRecipient: w.feeRecipient.address,
        quoteMint: w.quoteMint,
        quoteVault: await quoteVaultAddress(cross.address),
        challengerQuote: await ata(challenger.address, w.quoteMint, settled.data.quoteTokenProgram),
        feeRecipientQuote: await ata(w.feeRecipient.address, w.quoteMint, settled.data.quoteTokenProgram),
        quoteTokenProgram: settled.data.quoteTokenProgram,
        upheld,
        slash,
      });
    await w.h.ata(challenger.address, w.quoteMint, w.admin);
    expect(await w.h.fail([await resolve(challenger, true, 400_000n)], challenger)).toMatch(/Unauthorized|ConstraintRaw/);
    // A slash above the bond is refused; a valid one splits between the challenger and the protocol.
    expect(await w.h.fail([await resolve(arbiter, true, 1_000_001n)], arbiter)).toMatch(/InvalidParams/);
    const feeBefore = await w.h.balanceOf(w.feeRecipient.address, w.quoteMint);
    const chBefore = await w.h.balanceOf(challenger.address, w.quoteMint);
    await w.h.send([await resolve(arbiter, true, 400_000n)], arbiter);
    expect(await w.h.balanceOf(challenger.address, w.quoteMint)).toBe(chBefore + 200_000n);
    expect(await w.h.balanceOf(w.feeRecipient.address, w.quoteMint)).toBe(feeBefore + 200_000n);
    expect(w.view(cross.address).ext!.neutralState.openChallenges).toBe(0);
    expect(w.view(cross.address).ext!.neutralState.slashed).toBe(400_000n);

    // Still inside the window.
    await expect(w.finalize(settled)).rejects.toThrow(/ChallengesOutstanding/);
    w.h.setTime(w.h.svm.getClock().unixTimestamp + 7_201n);
    const creatorBefore = await w.h.balanceOf(w.creator.address, w.quoteMint);
    const final = await w.finalize(w.view(cross.address));
    expect(final.data.state).toBe(CrossState.Finalized);
    // 600,000 of the bond comes back, with the proceeds and the dust bond, less fees.
    const gain = (await w.h.balanceOf(w.creator.address, w.quoteMint)) - creatorBefore;
    expect(gain >= 600_000n + settled.data.dustBond).toBe(true);
    expect(w.h.balance(await quoteVaultAddress(cross.address))).toBe(0n);
  });

  it('a challenge after the window is refused', async () => {
    const w = await RulesWorld.createRules();
    const insider = await w.trader(100_000_000_000n);
    const challenger = await w.trader(1_000_000_000n);
    const cross = await w.newRuledCross({
      supplyMode: SupplyMode.Mint,
      schedule,
      rules: { neutrality: { insiders: [insider.address], bondQuote: 1_000_000n, challengeSecs: 3_600 } },
    });
    const o = await w.place(cross, await w.trader(10_000_000_000n), OrderSide.Buy, 1_000_000n, 10n * TOKEN);
    const settled = await w.settle(cross);
    void o;
    w.h.setTime(w.h.svm.getClock().unixTimestamp + 3_601n);
    const challenge = await challengeAddress(cross.address, 0);
    const ix = getChallengeInsiderInstruction({ challenger, cross: cross.address, challenge, subject: insider.address, evidence: new Uint8Array(32) });
    expect(await w.h.fail([ix], challenger)).toMatch(/ChallengeWindowClosed|InvalidParams/);
    void settled;
  });
});
