// The fixed-price tranche for a base token with the cross_gate transfer hook (ADR-0916, row B4) on the real presale, DBC and cross_gate binaries: a launch mints the hooked
// token through the DBC continuation, the issuer wins part of it in the call and puts some of it in a tranche at P*, buyers deposit and claim, and the issuer withdraws what
// was raised. Every transfer of the hooked token runs the hook, so each step needs its accounts; the program's refusals are read when they are left out.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { address, generateKeyPairSigner } from '@solana/kit';
import { OrderSide, SupplyMode, buildClaim, crossAddress } from '@opening-cross/sdk';
import {
  buildBindDbcMint,
  buildOpenDbcPool,
  buildOpenFixedPricePresale,
  buildPresaleClaim,
  buildPresaleCreatorWithdraw,
  buildPresaleDeposit,
  fixedPriceQ64,
  decodePresale,
  presaleOutcome,
  settlerAddress,
} from '@opening-cross/adapters';
import { World } from '../src/world.js';
import { DBC_FIXTURE } from '../src/harness.js';
import { CU, DEFAULT_SCHEDULE, defaultDesign } from '../src/settle-world.js';

// The chain runs are many transactions each; the default five seconds is for pure functions.
vi.setConfig({ testTimeout: 180_000 });

const FIX = fileURLToPath(new URL('../../fixtures/', import.meta.url));
const PRESALE = address('presSVxnf9UU8jMxhgSMqaRwNiT36qeBdNeTRKjTdbj');
const have = existsSync(`${FIX}presale.so`) && existsSync(DBC_FIXTURE);
const observed: Record<string, string> = {};

async function tryTx(w: World, ixs: Parameters<World['h']['send']>[0], who: Parameters<World['h']['send']>[1]): Promise<string> {
  try {
    await w.h.send(ixs, who);
    return 'ok';
  } catch (e) {
    const logs = (e as { logs?: string[] }).logs;
    return (logs ? logs.join(' ') : String(e)).match(/Error Code: (\w+)/)?.[1] ?? (logs ? logs.slice(-3).join(' ') : String(e)).slice(0, 300);
  }
}

/** A launch whose base token is minted by the DBC continuation (so it carries the transfer hook) and whose creator won the call and holds the tokens. */
async function hookedLaunch() {
  const w = await World.create();
  w.h.svm.addProgramFromFile(PRESALE, `${FIX}presale.so`);
  const crossAddr = await crossAddress(w.creator.address, 1n);
  const settler = await settlerAddress(crossAddr);
  const cross = await w.newCross({ supplyMode: SupplyMode.DeferredMint, schedule: DEFAULT_SCHEDULE, settler, settleDeadlineTs: 1_800_001_000n });
  const order = await w.place(cross, w.creator, OrderSide.Buy, 1_500_000n, 2_500_000_000n);
  const settled = await w.settle(cross);
  const open = await buildOpenDbcPool({ cross: settled, creator: w.creator, design: defaultDesign(), name: 'Tranche', symbol: 'TRN', uri: 'https://github.com/Pratiikpy/opening-cross' });
  await w.h.send([CU, open.instruction], w.creator);
  await w.h.send([CU, await buildBindDbcMint(w.view(cross.address), w.admin)], w.admin);
  await w.h.send(await buildClaim(w.view(cross.address), w.admin, order.owner.address, order.nonce), w.admin);
  return { w, cross: w.view(cross.address), baseMint: open.addresses.baseMint };
}

describe.skipIf(!have)('fixed-price tranche of a hooked base token', () => {
  it('opens with the hook accounts, sells at exactly P* to buyers who claim through the hook, and pays the issuer', async () => {
    const { w, cross, baseMint } = await hookedLaunch();
    const c = cross.data;
    const pStar = c.clearing.__option === 'Some' ? c.clearing.value.price : 0n;
    const held = await w.h.balanceOf(w.creator.address, baseMint);
    expect(held > 0n).toBe(true);
    const supply = 500_000_000n;
    const now = w.h.svm.getClock().unixTimestamp;
    const start = now + 600n;
    const end = start + 3_600n;
    const maxCap = (supply * pStar) / c.priceScale;
    const terms = { maxCap, minCap: 1_000_000n, start, end, supply, buyerMinDeposit: 1_000n, buyerMaxDeposit: maxCap };
    const base = await generateKeyPairSigner();

    // Without the hook's accounts Meteora's vault refuses to fund itself with the hooked token: the transfer cannot run its hook.
    const bare = await buildOpenFixedPricePresale({ cross, creator: w.creator, base, terms });
    observed.openWithoutHook = await tryTx(w, [CU, bare.instruction], w.creator);
    expect(observed.openWithoutHook).toBe('MissingRemainingAccountForTransferHook');
    expect(w.h.exists(bare.addresses.presale)).toBe(false);
    // With them it opens, at exactly P*, and the supply moves into the vault.
    const base2 = await generateKeyPairSigner();
    const built = await buildOpenFixedPricePresale({ cross, creator: w.creator, base: base2, terms, transferHook: true });
    await w.h.send([CU, built.instruction], w.creator);
    const a = built.addresses;
    expect(built.qPrice).toBe(fixedPriceQ64(pStar, c.priceScale));
    expect(await w.h.balance(a.presaleVault)).toBe(supply);
    expect(await w.h.balanceOf(w.creator.address, baseMint)).toBe(held - supply);

    // Buyers deposit during the sale. Alice and Bob take 500,000,000 of the 750,000,000 cap; a deposit with no escrow first is refused.
    w.h.setTime(start + 10n);
    const alice = await w.trader(1_000_000_000n);
    const bob = await w.trader(1_000_000_000n);
    const carol = await w.trader(1_000_000_000n);
    const deposit = (who: typeof alice, amount: bigint, createEscrow: boolean) => buildPresaleDeposit({ presale: a.presale, quoteTokenVault: a.quoteTokenVault, quoteMint: c.quoteMint, quoteTokenProgram: c.quoteTokenProgram, buyer: who, maxAmount: amount, createEscrow });
    observed.depositWithoutEscrow = await tryTx(w, await deposit(alice, 100_000_000n, false), alice);
    expect(observed.depositWithoutEscrow).toBe('AccountOwnedByWrongProgram');
    await w.h.send(await deposit(alice, 300_000_000n, true), alice);
    await w.h.send(await deposit(bob, 200_000_000n, true), bob);
    expect(await w.h.balance(a.quoteTokenVault)).toBe(500_000_000n);

    // While the sale is ongoing and under its cap, nobody can claim.
    const claim = (who: typeof alice, hook = true) => buildPresaleClaim({ presale: a.presale, baseTokenVault: a.presaleVault, baseMint, baseTokenProgram: c.baseTokenProgram, buyer: who, hook });
    observed.claimEarly = await tryTx(w, await claim(alice), alice);
    expect(observed.claimEarly).toBe('PresaleNotOpenForClaim');

    // Carol asks for 600,000,000 and the vault takes the 250,000,000 that fits under the cap; the sale is then full, so a further deposit is refused.
    await w.h.send(await deposit(carol, 600_000_000n, true), carol);
    const raised = await w.h.balance(a.quoteTokenVault);
    // The vault takes what the supply can pay for: up to two atoms under the cap, because it rounds the tokens down and not the quote up.
    expect(raised <= maxCap && maxCap - raised <= 2n).toBe(true);
    const carolDeposit = raised - 500_000_000n;
    expect(await w.h.balanceOf(carol.address, c.quoteMint)).toBe(1_000_000_000n - carolDeposit);
    observed.carolAsked600Paid = String(carolDeposit);
    observed.depositWhenFull = await tryTx(w, await deposit(bob, 1_000n, false), bob);
    expect(observed.depositWhenFull).toBe('ZeroTokenAmount');

    // After the sale each buyer receives deposit x scale / P* base tokens through the hook, floored; a claim without the hook's accounts is refused.
    w.h.setTime(end + 10n);
    observed.claimWithoutHook = await tryTx(w, await claim(alice, false), alice);
    expect(observed.claimWithoutHook).toBe('MissingRemainingAccountForTransferHook');
    for (const who of [alice, bob, carol]) await w.h.send(await claim(who), who);
    const expectBase = (q: bigint) => (q << 64n) / built.qPrice;
    const buyers = [[alice, 300_000_000n], [bob, 200_000_000n], [carol, carolDeposit]] as const;
    let sold = 0n;
    for (const [who, dep] of buyers) {
      const got = await w.h.balanceOf(who.address, baseMint);
      // The vault pays the floor of deposit x scale / P* and, where that quotient is exact, one atom less (observed: 199,999,999 for 300,000,000 at 1.5).
      expect(got <= expectBase(dep) && expectBase(dep) - got <= 1n).toBe(true);
      // The price each paid is P*: tokens times P* over the scale is the deposit, to two atoms.
      const cost = (got * pStar) / c.priceScale;
      expect(cost <= dep && dep - cost <= 2n).toBe(true);
      sold += got;
    }
    // The whole cap bought at most the whole supply, and the vault keeps only rounding dust of it.
    expect(sold <= supply).toBe(true);
    observed.unsoldDust = String(supply - sold);
    expect(supply - sold <= 4n).toBe(true);
    const aliceBase = await w.h.balanceOf(alice.address, baseMint);
    void aliceBase;

    // A second claim pays nothing more: the claim is cumulative and subtracts what was claimed.
    const aliceBefore = await w.h.balanceOf(alice.address, baseMint);
    observed.claimTwice = await tryTx(w, await claim(alice), alice);
    expect(await w.h.balanceOf(alice.address, baseMint)).toBe(aliceBefore);

    // The app's reading of the sale agrees with the account: its deposits, its caps, and where it stands at each moment.
    const state = decodePresale(new Uint8Array((w.h.svm.getAccount(a.presale) as { data: Uint8Array }).data))!;
    expect(state).toMatchObject({ owner: w.creator.address, baseMint, quoteMint: c.quoteMint, maxCap, minCap: 1_000_000n, start, end, supply, totalDeposit: raised, hasCreatorWithdrawn: false });
    expect(presaleOutcome(state, start - 1n)).toBe('not-started');
    expect(presaleOutcome({ ...state, totalDeposit: 500_000_000n }, start + 10n)).toBe('ongoing');
    expect(presaleOutcome(state, end + 10n)).toBe('completed');
    expect(presaleOutcome({ ...state, totalDeposit: 10n }, end + 10n)).toBe('failed');

    // The issuer withdraws the raised quote, once.
    const before = await w.h.balanceOf(w.creator.address, c.quoteMint);
    const withdraw = () => buildPresaleCreatorWithdraw({ presale: a.presale, cross, creator: w.creator, outcome: 'completed', quoteTokenVault: a.quoteTokenVault, baseTokenVault: a.presaleVault });
    await w.h.send([await withdraw()], w.creator);
    // The issuer is paid the quote raised, to within the atom the vault's rounding keeps.
    const paidOut = (await w.h.balanceOf(w.creator.address, c.quoteMint)) - before;
    expect(paidOut <= raised && raised - paidOut <= 1n).toBe(true);
    observed.creatorWithdrawTwice = await tryTx(w, [await withdraw()], w.creator);
    expect(observed.creatorWithdrawTwice).toBe('CreatorAlreadyWithdrawn');
    expect(decodePresale(new Uint8Array((w.h.svm.getAccount(a.presale) as { data: Uint8Array }).data))!.hasCreatorWithdrawn).toBe(true);

    // A second tranche that does not reach its minimum fails: nobody deposits, and the issuer takes the hooked supply back through the hook.
    const base3 = await generateKeyPairSigner();
    const smallCap = (100_000_000n * pStar) / c.priceScale; // Meteora requires the cap to be what the supply is worth at the price
    const failTerms = { maxCap: smallCap, minCap: smallCap / 2n, start: end + 100n, end: end + 3_700n, supply: 100_000_000n, buyerMinDeposit: 1_000n, buyerMaxDeposit: smallCap };
    const second = await buildOpenFixedPricePresale({ cross, creator: w.creator, base: base3, terms: failTerms, transferHook: true });
    const heldBefore = await w.h.balanceOf(w.creator.address, baseMint);
    await w.h.send([CU, second.instruction], w.creator);
    expect(await w.h.balanceOf(w.creator.address, baseMint)).toBe(heldBefore - 100_000_000n);
    w.h.setTime(failTerms.end + 10n);
    const failedState = decodePresale(new Uint8Array((w.h.svm.getAccount(second.addresses.presale) as { data: Uint8Array }).data))!;
    expect(presaleOutcome(failedState, failTerms.end + 10n)).toBe('failed');
    const failedWithdraw = (hook: boolean) => buildPresaleCreatorWithdraw({ presale: second.addresses.presale, cross, creator: w.creator, outcome: 'failed', quoteTokenVault: second.addresses.quoteTokenVault, baseTokenVault: second.addresses.presaleVault, hook });
    // Without the hook's accounts the hooked base cannot move back out; with them it does.
    observed.failedWithoutHook = await tryTx(w, [await failedWithdraw(false)], w.creator);
    expect(observed.failedWithoutHook).toBe('MissingRemainingAccountForTransferHook');
    await w.h.send([await failedWithdraw(true)], w.creator);
    expect(await w.h.balanceOf(w.creator.address, baseMint)).toBe(heldBefore);
    console.table(observed);
  });
});
