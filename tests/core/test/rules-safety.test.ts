// What the rules must never allow, and what must keep working when a caller leaves an account out: referral
// payout, who may resume a halt, the circuit breaker's inputs, the arbiter's deadline, the applicant and lock
// accounts, the series' funds, and the omission of every account a rule calls for (ADR-0450 to ADR-0460).
import { describe, expect, it } from 'vitest';
import { type Address, type Instruction, address, generateKeyPairSigner, lamports } from '@solana/kit';
import { getCreateAccountInstruction } from '@solana-program/system';
import {
  TOKEN_2022_PROGRAM_ADDRESS,
  getInitializeMint2Instruction,
  getInitializePausableConfigInstruction,
  getMintSize,
  getPauseInstruction,
  getResumeInstruction,
  extension,
} from '@solana-program/token-2022';
import {
  CrossState,
  Disclosure,
  FLAG_FEEDS_LENDERS,
  FLAG_RESUMES_HALT,
  NoPrintReason,
  OrderSide,
  SupplyMode,
  applicantAddress,
  ata,
  challengeAddress,
  classBookAddress,
  arbiterRegistryAddress,
  getChallengeInsiderInstruction,
  getCloseApplicantInstruction,
  getExpireChallengeInstruction,
  getHaltStateDecoder,
  getInitHaltStateInstruction,
  getInitPrintFeedInstruction,
  getLogExtInstruction,
  getObservePriceInstruction,
  getSetArbiterInstruction,
  getSetFeedPublishersInstruction,
  getSetHaltInstruction,
  getSyncPauseInstruction,
  getClaimInstruction,
  haltStateAddress,
  orderAddress,
  printFeedAddress,
  protocolAddress,
  quoteVaultAddress,
  withAccounts,
} from '@opening-cross/sdk';
import { Mode, findConfigPda, getCreateConfigInstruction, getGrantPassInstruction } from '@opening-cross/cross-gate-client';
import { RulesWorld } from '../src/rules-world.js';
import { T0 } from '../src/harness.js';

const TOKEN = 1_000_000n;
const schedule = [{ price: 1_000_000n, quantity: 100n * TOKEN }];
const RECEIVER = address('rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ');
const DISC = [34, 241, 35, 99, 157, 126, 244, 205];
const FEED = new Uint8Array(32).fill(7);

function priceUpdate(price: bigint, publishTime: bigint, opts: { full?: boolean; feed?: Uint8Array } = {}): Uint8Array {
  const b = Buffer.alloc(8 + 32 + 2 + 32 + 8 + 8 + 4 + 8 * 6);
  let at = 0;
  Buffer.from(DISC).copy(b, at);
  at += 8 + 32;
  if (opts.full ?? true) {
    b[at] = 1;
    at += 1;
  } else {
    b[at] = 0;
    b[at + 1] = 13;
    at += 2;
  }
  Buffer.from(opts.feed ?? FEED).copy(b, at);
  at += 32;
  b.writeBigInt64LE(price, at);
  at += 8 + 8;
  b.writeInt32LE(-2, at);
  at += 4;
  b.writeBigInt64LE(publishTime, at);
  return new Uint8Array(b);
}

async function oracleAccount(w: RulesWorld, data: Uint8Array): Promise<Address> {
  const acct = (await generateKeyPairSigner()).address;
  w.h.svm.setAccount({ address: acct, data, executable: false, lamports: lamports(10_000_000n), programAddress: RECEIVER, space: BigInt(data.length) });
  return acct;
}

async function haltState(w: RulesWorld, opts: { venue?: Address; breaker?: { windowSlots: number; moveBps: number } } = {}) {
  const halt = await haltStateAddress(w.baseMint);
  await w.h.send(
    [
      getInitHaltStateInstruction({
        authority: w.admin,
        baseMint: w.baseMint,
        protocol: await protocolAddress(),
        halt,
        venueSigner: opts.venue ?? null,
        breaker: opts.breaker ? { feedId: FEED, windowSlots: opts.breaker.windowSlots, moveBps: opts.breaker.moveBps } : null,
      }),
    ],
    w.admin,
  );
  return halt;
}

const readHalt = (w: RulesWorld, halt: Address) => {
  const acc = w.h.svm.getAccount(halt);
  if (!acc.exists) throw new Error('halt state missing');
  return getHaltStateDecoder().decode(acc.data);
};

describe('referral', () => {
  async function run(shareBps: number, opts: { referrerQuote?: boolean } = {}) {
    const w = await RulesWorld.createRules();
    const referrer = await w.h.wallet();
    if (opts.referrerQuote !== false) await w.h.ata(referrer.address, w.quoteMint, w.admin);
    const cross = await w.newRuledCross({
      supplyMode: SupplyMode.Mint,
      schedule,
      integratorFeeBps: 200,
      rules: { referral: { referrer: referrer.address, shareBps } },
    });
    const buyer = await w.trader(10_000_000_000n);
    const order = await w.place(cross, buyer, OrderSide.Buy, 1_000_000n, 100n * TOKEN);
    const settled = await w.settle(cross);
    await w.claimAll(settled, [order]);
    return { w, settled, referrer };
  }

  it('pays the referrer its share of the protocol fee and nothing else', async () => {
    // 100 tokens at 1.0 raise 100,000,000; the integrator takes 200 bps, the protocol min(30, 200/4) = 30 bps of it.
    const { w, settled, referrer } = await run(1_000);
    const fee = await w.h.balanceOf(w.feeRecipient.address, w.quoteMint);
    const before = { fee, integrator: await w.h.balanceOf(w.integrator.address, w.quoteMint) };
    const final = await w.finalize(settled);
    expect(final.data.state).toBe(CrossState.Finalized);
    const protocol = (100_000_000n * 30n) / 10_000n;
    const referral = (protocol * 1_000n) / 10_000n;
    expect(await w.h.balanceOf(referrer.address, w.quoteMint)).toBe(referral);
    expect((await w.h.balanceOf(w.feeRecipient.address, w.quoteMint)) - before.fee).toBe(protocol - referral);
    expect((await w.h.balanceOf(w.integrator.address, w.quoteMint)) - before.integrator).toBe((100_000_000n * 200n) / 10_000n);
    expect(w.h.balance(await quoteVaultAddress(settled.address))).toBe(0n);
  });

  it('is refused when the referrer account is left out or is somebody else\'s, and works once it is right', async () => {
    const { w, settled, referrer } = await run(2_500);
    const view = w.view(settled.address);
    const good = await w.finalizeIx(view, w.admin);
    const base = { ...good, accounts: (good.accounts ?? []).slice(0, -1) } as Instruction;
    expect(await w.h.fail([base], w.admin)).toMatch(/ReferralAccountMissing/);
    const stranger = await w.h.wallet();
    const strangerAta = await w.h.ata(stranger.address, w.quoteMint, w.admin);
    expect(await w.h.fail([await w.finalizeIx(view, w.admin, { referrerQuote: strangerAta })], w.admin)).toMatch(/ReferralAccountMissing/);
    await w.h.send([good], w.admin);
    expect(await w.h.balanceOf(referrer.address, w.quoteMint) > 0n).toBe(true);
  });

  it('a referrer with no token account cannot stop a finalize: anyone may open the account first', async () => {
    const { w, settled, referrer } = await run(500, { referrerQuote: false });
    expect(await w.h.fail([await w.finalizeIx(w.view(settled.address), w.admin)], w.admin)).toMatch(/ReferralAccountMissing|AccountNotInitialized|3012/);
    await w.h.ata(referrer.address, w.quoteMint, w.admin);
    await w.finalize(settled);
  });
});

describe('who may lift a halt', () => {
  it('only the halt state\'s authority or venue may create a cross that resumes the asset', async () => {
    const w = await RulesWorld.createRules();
    const halt = await haltState(w);
    // The creator of these crosses is not the halt authority (the admin is).
    await expect(w.newRuledCross({ rules: { flags: FLAG_RESUMES_HALT, guards: { haltSource: halt } }})).rejects.toThrow(/Unauthorized/);
  });
});

describe('the circuit breaker', () => {
  async function setup() {
    const w = await RulesWorld.createRules();
    const halt = await haltState(w, { breaker: { windowSlots: 100, moveBps: 500 } });
    const feed = (price: bigint, t: bigint, o: { full?: boolean; feed?: Uint8Array } = {}) => oracleAccount(w, priceUpdate(price, t, o));
    const observe = async (price: bigint, t: bigint, o: { full?: boolean; feed?: Uint8Array } = {}) =>
      w.h.send([getObservePriceInstruction({ halt, priceUpdate: await feed(price, t, o) })], w.admin);
    return { w, halt, feed, observe };
  }
  const NOW = T0 + 10n;

  it('trips on a move beyond the bound inside the window, and only then', async () => {
    const { w, halt, observe } = await setup();
    w.h.setTime(NOW);
    await observe(100n, NOW);
    expect(readHalt(w, halt).halted).toBe(false);
    // 4% is inside a 5% bound.
    w.h.svm.warpToSlot(w.h.svm.getClock().slot + 5n);
    await observe(104n, NOW + 1n);
    expect(readHalt(w, halt).halted).toBe(false);
    // 6% from the last observation (104 -> 110.24 is 6%).
    w.h.svm.warpToSlot(w.h.svm.getClock().slot + 5n);
    await observe(111n, NOW + 2n);
    const h = readHalt(w, halt);
    expect(h.halted).toBe(true);
    expect(h.reason).toBe(3); // CircuitBreaker
  });

  it('does not compare two observations further apart than the window', async () => {
    const { w, halt, observe } = await setup();
    w.h.setTime(NOW);
    await observe(100n, NOW);
    w.h.svm.warpToSlot(w.h.svm.getClock().slot + 500n);
    await observe(150n, NOW + 1n);
    expect(readHalt(w, halt).halted).toBe(false);
  });

  it('refuses a stale update, a replayed one, a partly verified one and one for another feed', async () => {
    const { w, observe } = await setup();
    w.h.setTime(NOW);
    await expect(observe(100n, NOW - 1_000n)).rejects.toThrow(/OracleUnavailable/); // older than the age bound
    await observe(100n, NOW);
    await expect(observe(150n, NOW)).rejects.toThrow(/OracleUnavailable/); // not newer than the last one: a replay
    await expect(observe(150n, NOW - 5n)).rejects.toThrow(/OracleUnavailable/); // older than the last one
    await expect(observe(150n, NOW + 1n, { full: false })).rejects.toThrow(/OracleUnavailable/);
    await expect(observe(150n, NOW + 1n, { feed: new Uint8Array(32).fill(9) })).rejects.toThrow(/OracleUnavailable/);
  });

  it('a halt lifted only by a printing resume cross run by the halt authority', async () => {
    const w = await RulesWorld.createRules();
    const halt = await haltState(w);
    await w.h.send([getSetHaltInstruction({ signer: w.admin, halt })], w.admin);
    expect(readHalt(w, halt).halted).toBe(true);
    // The admin is the authority, but the cross is created by the creator: a different party, refused.
    // So the authority is made the creator by a dedicated world.
    const authorityWorld = w;
    authorityWorld.creator = w.admin;
    await w.h.ata(w.admin.address, w.baseMint, w.admin);
    await w.h.ata(w.admin.address, w.quoteMint, w.admin);
    await w.h.fund(w.quoteMint, w.admin, w.admin.address, 1_000_000_000_000n);
    const cross = await w.newRuledCross({ reference: 1_500_000n, rules: { flags: FLAG_RESUMES_HALT, guards: { haltSource: halt } }});
    const seller = await w.trader(0n, 2_000_000_000n);
    const buyer = await w.trader(10_000_000_000n);
    await w.place(cross, seller, OrderSide.Sell, 1_400_000n, 100_000_000n);
    await w.place(cross, buyer, OrderSide.Buy, 1_600_000n, 100_000_000n);
    const settled = await w.settle(cross);
    expect(settled.data.state).toBe(CrossState.Cleared);
    expect(readHalt(w, halt).halted).toBe(false);
  });
});

describe('the mint\'s own pause', () => {
  it('copies a paused Token-2022 mint into the halt state and a cross naming it does not print', async () => {
    const w = await RulesWorld.createRules();
    // A mint with the pausable extension, authority the admin.
    const mint = await generateKeyPairSigner();
    const space = BigInt(getMintSize([extension('PausableConfig', { authority: w.admin.address, paused: false })]));
    await w.h.send(
      [
        getCreateAccountInstruction({ payer: w.admin, newAccount: mint, lamports: w.h.svm.minimumBalanceForRentExemption(space), space, programAddress: TOKEN_2022_PROGRAM_ADDRESS }),
        getInitializePausableConfigInstruction({ mint: mint.address, authority: w.admin.address }),
        getInitializeMint2Instruction({ mint: mint.address, decimals: 6, mintAuthority: w.admin.address, freezeAuthority: null }),
      ],
      w.admin,
    );
    w.baseMint = mint.address;
    for (const who of [w.feeRecipient, w.integrator, w.creator]) await w.h.ata(who.address, w.baseMint, w.admin);
    const halt = await haltState(w);
    const sync = getSyncPauseInstruction({ halt, baseMint: w.baseMint });
    await w.h.send([sync], w.admin);
    expect(readHalt(w, halt).halted).toBe(false);
    await w.h.send([getPauseInstruction({ mint: w.baseMint, authority: w.admin })], w.admin);
    await w.h.send([sync], w.admin);
    const h = readHalt(w, halt);
    expect(h.halted).toBe(true);
    expect(h.reason).toBe(1); // IssuerPause

    // A reopen that opts in to the halt state does not print while the mint is paused.
    await w.h.send([getResumeInstruction({ mint: w.baseMint, authority: w.admin })], w.admin);
    const seller = await w.trader(0n, 2_000_000_000n);
    const buyer = await w.trader(10_000_000_000n);
    const cross = await w.newRuledCross({ reference: 1_500_000n, rules: { guards: { haltSource: halt } } });
    const orders = [await w.place(cross, seller, OrderSide.Sell, 1_400_000n, 100_000_000n), await w.place(cross, buyer, OrderSide.Buy, 1_600_000n, 100_000_000n)];
    await w.h.send([getPauseInstruction({ mint: w.baseMint, authority: w.admin })], w.admin);
    const settled = await w.settle(cross);
    expect(settled.data.state).toBe(CrossState.NoPrint);
    expect(settled.data.noPrintReason).toEqual({ __option: 'Some', value: NoPrintReason.IssuerPaused });
    // The issuer lifts its pause: refunds are paid in full.
    await w.h.send([getResumeInstruction({ mint: w.baseMint, authority: w.admin })], w.admin);
    await w.claimAll(settled, orders);
    expect(await w.h.balanceOf(seller.address, w.baseMint)).toBe(2_000_000_000n);
  });
});

describe('the arbiter\'s deadline', () => {
  it('an unanswered challenge expires, the deposit returns, and finalize is no longer held back', async () => {
    const w = await RulesWorld.createRules();
    const insider = await w.trader(100_000_000_000n);
    const outsider = await w.trader(100_000_000_000n);
    const challenger = await w.trader(1_000_000_000n);
    const arbiter = await w.h.wallet();
    await w.h.send([getSetArbiterInstruction({ admin: w.admin, protocol: await protocolAddress(), registry: await arbiterRegistryAddress(), arbiter: arbiter.address })], w.admin);
    const cross = await w.newRuledCross({ supplyMode: SupplyMode.Mint, schedule, rules: { neutrality: { insiders: [insider.address], bondQuote: 1_000_000n, challengeSecs: 3_600 } } });
    const orders = [await w.place(cross, insider, OrderSide.Buy, 1_000_000n, 10n * TOKEN), await w.place(cross, outsider, OrderSide.Buy, 1_000_000n, 20n * TOKEN)];
    const settled = await w.settle(cross);
    await w.claimAll(settled, orders);
    const challenge = await challengeAddress(cross.address, 0);
    const lamportsBefore = w.h.svm.getBalance(challenger.address) ?? 0n;
    await w.h.send([getChallengeInsiderInstruction({ challenger, cross: cross.address, challenge, subject: (await w.h.wallet()).address, evidence: new Uint8Array(32).fill(1) })], challenger);
    const expire = getExpireChallengeInstruction({ cross: cross.address, challenge, challenger: challenger.address });
    // The window passes, the arbiter says nothing: finalize is held back, expiry is not yet possible.
    w.h.setTime(w.h.svm.getClock().unixTimestamp + 4_000n);
    await expect(w.finalize(settled)).rejects.toThrow(/ChallengesOutstanding/);
    expect(await w.h.fail([expire], w.admin)).toMatch(/DeadlineNotReached/);
    // Fourteen days later anyone closes it.
    w.h.setTime(w.h.svm.getClock().unixTimestamp + 14n * 86_400n);
    await w.h.send([expire], w.admin);
    expect(w.view(cross.address).ext!.neutralState.openChallenges).toBe(0);
    expect(w.h.svm.getAccount(challenge).exists).toBe(false);
    // The challenger got deposit and rent back (less the transaction fees paid along the way).
    expect((w.h.svm.getBalance(challenger.address) ?? 0n) + 20_000n >= lamportsBefore).toBe(true);
    // A second expiry finds nothing to close.
    expect(await w.h.fail([expire], w.admin)).toMatch(/AccountNotInitialized|ChallengeMismatch|3012/);
    const final = await w.finalize(w.view(cross.address));
    expect(final.data.state).toBe(CrossState.Finalized);
    expect(w.h.balance(await quoteVaultAddress(cross.address))).toBe(0n);
  });
});

describe('a rule is never skipped by leaving its account out', () => {
  async function gated(w: RulesWorld, who: { address: Address }[]) {
    const gateMint = await w.h.mint(w.admin, 6);
    const [config] = await findConfigPda({ mint: gateMint });
    await w.h.send([getCreateConfigInstruction({ payer: w.admin, mintAuthority: w.admin, mint: gateMint, config, authority: w.admin.address, mode: Mode.Allowlist })], w.admin);
    for (const p of who) {
      const { gatePassAddress } = await import('@opening-cross/sdk');
      await w.h.send([getGrantPassInstruction({ authority: w.admin, config, pass: await gatePassAddress(gateMint, p.address), owner: p.address })], w.admin);
    }
    return gateMint;
  }

  it('commit without the applicant record, the class book or the pass is refused', async () => {
    const w = await RulesWorld.createRules();
    const alice = await w.trader(100_000_000_000n);
    const stranger = await w.trader(100_000_000_000n);
    const gateMint = await gated(w, [alice]);
    const cross = await w.newRuledCross({ supplyMode: SupplyMode.Mint, schedule, gateMint, rules: { identity: { maxOrders: 1 }, neutrality: { insiders: [stranger.address] } } });
    const view = w.view(cross.address);
    const full = await w.commitIx(view, alice, 0n, OrderSide.Buy, 1_000_000n, 5n * TOKEN, new Uint8Array(32));
    const accounts = full.accounts ?? [];
    // Drop the applicant, then the class book (the last two remaining accounts).
    const without = (n: number) => ({ ...full, accounts: accounts.filter((_, i) => i !== accounts.length - n) }) as Instruction;
    expect(await w.h.fail([without(1)], alice)).toMatch(/ClassBookMissing|ApplicantMismatch/);
    expect(await w.h.fail([without(2)], alice)).toMatch(/ClassBookMissing|ApplicantMismatch/);
    // A wallet without a pass cannot place an order.
    const noPass = await w.commitIx(view, stranger, 0n, OrderSide.Buy, 1_000_000n, 5n * TOKEN, new Uint8Array(32));
    expect(await w.h.fail([noPass], stranger)).toMatch(/NotEligible|AccountNotInitialized|3012/);
    // The right call works.
    await w.h.send([full], alice);
  });

  it('clear without the halt state or the base mint is refused', async () => {
    const w = await RulesWorld.createRules();
    const halt = await haltState(w);
    const cross = await w.newRuledCross({ reference: 1_500_000n, rules: { guards: { haltSource: halt, minFloatBps: 100 } } });
    const seller = await w.trader(0n, 2_000_000_000n);
    const buyer = await w.trader(10_000_000_000n);
    await w.place(cross, seller, OrderSide.Sell, 1_400_000n, 100_000_000n);
    await w.place(cross, buyer, OrderSide.Buy, 1_600_000n, 100_000_000n);
    w.h.setTime(cross.data.revealEndTs + 1n);
    const ixs = await w.settleIxs(w.view(cross.address));
    const clear = ixs[ixs.length - 1]!;
    for (const ix of ixs.slice(0, -1)) await w.h.send([ix], w.admin);
    const accounts = clear.accounts ?? [];
    for (const drop of [1, 2]) {
      const partial = { ...clear, accounts: accounts.slice(0, accounts.length - drop) } as Instruction;
      expect(await w.h.fail([partial], w.admin)).toMatch(/HaltMismatch|WrongMint/);
    }
    await w.h.send([clear], w.admin);
    expect(w.view(cross.address).data.state).toBe(CrossState.Cleared);
  });

  it('clear without the class book is refused', async () => {
    const w = await RulesWorld.createRules();
    const insider = await w.trader(100_000_000_000n);
    const cross = await w.newRuledCross({ supplyMode: SupplyMode.Mint, schedule, rules: { neutrality: { insiders: [insider.address] } } });
    await w.place(cross, insider, OrderSide.Buy, 1_000_000n, 5n * TOKEN);
    w.h.setTime(cross.data.revealEndTs + 1n);
    const ixs = await w.settleIxs(w.view(cross.address));
    const clear = ixs[ixs.length - 1]!;
    for (const ix of ixs.slice(0, -1)) await w.h.send([ix], w.admin);
    const bare = { ...clear, accounts: (clear.accounts ?? []).slice(0, -1) } as Instruction;
    expect(await w.h.fail([bare], w.admin)).toMatch(/ClassBookMissing/);
    await w.h.send([clear], w.admin);
  });

  it('claiming a locked fill without the lock accounts is refused, and the right call works', async () => {
    const w = await RulesWorld.createRules();
    const insider = await w.trader(100_000_000_000n);
    const cross = await w.newRuledCross({ supplyMode: SupplyMode.Mint, schedule, rules: { neutrality: { insiders: [insider.address], insiderCliffSecs: 100 } } });
    const o = await w.place(cross, insider, OrderSide.Buy, 1_000_000n, 5n * TOKEN);
    const settled = await w.settle(cross);
    const ixs = await w.claimIxs(w.view(settled.address), w.admin, o);
    const claim = ixs[ixs.length - 1]!;
    const bare = { ...claim, accounts: (claim.accounts ?? []).slice(0, -2) } as Instruction;
    expect(await w.h.fail([...ixs.slice(0, -1), bare], w.admin)).toMatch(/LockupMismatch/);
    // Nothing was paid out by the failed attempt: the fill is not in the insider's wallet.
    expect(await w.h.balanceOf(insider.address, settled.data.baseMint)).toBe(0n);
    await w.h.send(ixs, w.admin);
    // The lock account exists now; a second claim of the same order finds no order.
    expect(w.h.svm.getAccount(await orderAddress(settled.address, insider.address, o.nonce)).exists).toBe(false);
    void getClaimInstruction;
  });
});

describe('refunds need nothing the rules add', () => {
  it('an insider whose cross did not print collects a refund with a plain claim, no lock accounts', async () => {
    const w = await RulesWorld.createRules();
    const insider = await w.trader(100_000_000_000n);
    const cross = await w.newRuledCross({ supplyMode: SupplyMode.Mint, schedule, rules: { guards: { minRaiseQuote: 10_000_000_000n }, neutrality: { insiders: [insider.address], insiderCliffSecs: 100 } } });
    const o = await w.place(cross, insider, OrderSide.Buy, 1_000_000n, 5n * TOKEN);
    const settled = await w.settle(cross);
    expect(settled.data.state).toBe(CrossState.NoPrint);
    const ixs = await w.claimIxs(w.view(settled.address), w.admin, o);
    const claim = ixs[ixs.length - 1]!;
    const bare = { ...claim, accounts: (claim.accounts ?? []).slice(0, -2) } as Instruction;
    const before = await w.h.balanceOf(insider.address, w.quoteMint);
    await w.h.send([...ixs.slice(0, -1), bare], w.admin);
    expect((await w.h.balanceOf(insider.address, w.quoteMint)) - before).toBe(o.escrow);
  });
});

describe('housekeeping', () => {
  it('a finalized cross\'s applicant records give their rent back; before that they stay', async () => {
    const w = await RulesWorld.createRules();
    const alice = await w.trader(100_000_000_000n);
    const gateMint = await (async () => {
      const m = await w.h.mint(w.admin, 6);
      const [config] = await findConfigPda({ mint: m });
      await w.h.send([getCreateConfigInstruction({ payer: w.admin, mintAuthority: w.admin, mint: m, config, authority: w.admin.address, mode: Mode.Allowlist })], w.admin);
      const { gatePassAddress } = await import('@opening-cross/sdk');
      await w.h.send([getGrantPassInstruction({ authority: w.admin, config, pass: await gatePassAddress(m, alice.address), owner: alice.address })], w.admin);
      return m;
    })();
    const cross = await w.newRuledCross({ supplyMode: SupplyMode.Mint, schedule, gateMint, rules: { identity: { maxOrders: 2 } } });
    const o = await w.place(cross, alice, OrderSide.Buy, 1_000_000n, 5n * TOKEN);
    const applicant = await applicantAddress(cross.address, alice.address);
    const close = getCloseApplicantInstruction({ cross: cross.address, owner: alice.address, applicant });
    const settled = await w.settle(cross);
    expect(await w.h.fail([close], w.admin)).toMatch(/WrongState/);
    await w.claimAll(settled, [o]);
    await w.finalize(settled);
    const before = w.h.svm.getBalance(alice.address) ?? 0n;
    await w.h.send([close], w.admin);
    expect((w.h.svm.getBalance(alice.address) ?? 0n) > before).toBe(true);
    expect(w.h.svm.getAccount(applicant).exists).toBe(false);
  });

  it('log_ext emits the stored rules and changes nothing', async () => {
    const w = await RulesWorld.createRules();
    const cross = await w.newRuledCross({ supplyMode: SupplyMode.Mint, schedule, rules: { guards: { minRaiseQuote: 7n } } });
    const before = w.h.svm.getAccount(cross.address);
    const sent = await w.h.send([getLogExtInstruction({ cross: cross.address })], w.admin);
    expect(sent > 0n).toBe(true);
    const after = w.h.svm.getAccount(cross.address);
    expect(before.exists && after.exists && Buffer.from(before.data).equals(Buffer.from(after.data))).toBe(true);
  });

  it('only the feed\'s authority changes its publishers', async () => {
    const w = await RulesWorld.createRules();
    const feed = await printFeedAddress(w.baseMint);
    await w.h.send([getInitPrintFeedInstruction({ authority: w.admin, baseMint: w.baseMint, quoteMint: w.quoteMint, protocol: await protocolAddress(), feed, publishers: [w.admin.address], minMatched: 5n })], w.admin);
    const stranger = await w.h.wallet();
    expect(await w.h.fail([getSetFeedPublishersInstruction({ authority: stranger, feed, publishers: [stranger.address], minMatched: 0n })], stranger)).toMatch(/Unauthorized/);
    expect(await w.h.fail([getSetFeedPublishersInstruction({ authority: w.admin, feed, publishers: [], minMatched: 0n })], w.admin)).toMatch(/InvalidParams/);
    await w.h.send([getSetFeedPublishersInstruction({ authority: w.admin, feed, publishers: [w.admin.address, stranger.address], minMatched: 9n })], w.admin);
  });

  it('a feed can be created only by the mint authority or the protocol admin', async () => {
    const w = await RulesWorld.createRules();
    const stranger = await w.h.wallet();
    const feed = await printFeedAddress(w.baseMint);
    expect(await w.h.fail([getInitPrintFeedInstruction({ authority: stranger, baseMint: w.baseMint, quoteMint: w.quoteMint, protocol: await protocolAddress(), feed, publishers: [stranger.address], minMatched: 0n })], stranger)).toMatch(/Unauthorized/);
  });
});

void [Disclosure, NoPrintReason, FLAG_FEEDS_LENDERS, ata, classBookAddress, withAccounts];
