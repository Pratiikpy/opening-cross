// Stake-bonded listing (L1; ADR-0653): a lister bonds to list crosses on a venue, gets the bond back when they end well,
// and loses it to the one fault the chain can prove: a settlement that never happened.
import { describe, expect, it } from 'vitest';
import { TOKEN_2022_PROGRAM_ADDRESS, findAssociatedTokenPda } from '@solana-program/token-2022';
import type { Address, KeyPairSigner } from '@solana/kit';
import { CrossState, NoPrintReason, OrderSide, SupplyMode, getAbandonSettlementInstruction } from '@opening-cross/sdk';
import {
  findBondPda,
  findListingPda,
  findVenuePda,
  getBondDecoder,
  getCreateVenueInstruction,
  getDepositBondInstruction,
  getListCrossInstruction,
  getListingDecoder,
  getOpenBondInstruction,
  getReleaseListingInstruction,
  getSlashListingInstruction,
  getWithdrawBondInstruction,
} from '@opening-cross/cross-listing-client';
import { World } from '../src/world.js';
import { T0 } from '../src/harness.js';

const TOKEN = 1_000_000n;
const DAY = 86_400n;
const schedule = [{ price: 1_000_000n, quantity: 2_000_000_000n }];
const ata = async (owner: Address, mint: Address) => (await findAssociatedTokenPda({ owner, mint, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS }))[0];

async function setup(minBond = 100n * TOKEN) {
  const w = await World.create();
  const slash = await w.h.wallet();
  await w.h.ata(slash.address, w.quoteMint, w.admin);
  const [venue] = await findVenuePda({ creator: w.admin.address, id: 1n });
  await w.h.send([getCreateVenueInstruction({ creator: w.admin, bondMint: w.quoteMint, venue, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS, id: 1n, minBond, releaseDelaySecs: DAY, slashTo: slash.address })], w.admin);
  const lister = w.creator;
  const [bond] = await findBondPda({ venue, lister: lister.address });
  const vault = await ata(bond, w.quoteMint);
  await w.h.send([getOpenBondInstruction({ lister, venue, bondMint: w.quoteMint, bond, vault, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS })], lister);
  const deposit = async (amount: bigint) =>
    w.h.send([getDepositBondInstruction({ lister, venue, bondMint: w.quoteMint, listerToken: await ata(lister.address, w.quoteMint), bond, vault, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS, amount })], lister);
  const list = async (cross: Address, who: KeyPairSigner = lister) => {
    const [listing] = await findListingPda({ venue, cross });
    const [whoBond] = await findBondPda({ venue, lister: who.address });
    return { listing, ix: getListCrossInstruction({ lister: who, venue, bond: whoBond, cross, listing }) };
  };
  const readBond = () => getBondDecoder().decode((w.h.svm.getAccount(bond) as { data: Uint8Array }).data);
  const readListing = (listing: Address) => getListingDecoder().decode((w.h.svm.getAccount(listing) as { data: Uint8Array }).data);
  const release = (listing: Address, cross: Address) => getReleaseListingInstruction({ listing, lister: lister.address, venue, bond, cross });
  const slashAcct = () => ata(slash.address, w.quoteMint);
  const slashIx = async (listing: Address, cross: Address) =>
    getSlashListingInstruction({ listing, lister: lister.address, venue, bond, cross, bondMint: w.quoteMint, vault, slashAccount: await slashAcct(), tokenProgram: TOKEN_2022_PROGRAM_ADDRESS });
  return { w, slash, venue, lister, bond, vault, deposit, list, readBond, readListing, release, slashIx, slashAcct };
}

describe('bonds', () => {
  it('a lister deposits, lists, and can withdraw only what no listing has set aside', async () => {
    const s = await setup();
    await s.deposit(250n * TOKEN);
    expect(s.w.h.balance(s.vault)).toBe(250n * TOKEN);
    const cross = await s.w.newCross();
    const { listing, ix } = await s.list(cross.address);
    await s.w.h.send([ix], s.lister);
    expect(s.readBond()).toMatchObject({ amount: 250n * TOKEN, encumbered: 100n * TOKEN });
    expect(s.readListing(listing)).toMatchObject({ amount: 100n * TOKEN, settled: false });
    const listerToken = await ata(s.lister.address, s.w.quoteMint);
    const w2 = (amount: bigint) =>
      getWithdrawBondInstruction({ lister: s.lister, venue: s.venue, bondMint: s.w.quoteMint, bond: s.bond, vault: s.vault, listerToken, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS, amount });
    expect(await s.w.h.fail([w2(150n * TOKEN + 1n)], s.lister)).toContain('BondEncumbered');
    await s.w.h.send([w2(150n * TOKEN)], s.lister);
    expect(s.readBond()).toMatchObject({ amount: 100n * TOKEN, encumbered: 100n * TOKEN });
    expect(s.w.h.balance(s.vault)).toBe(100n * TOKEN);
    // A stranger cannot withdraw it.
    const stranger = await s.w.h.wallet();
    await s.w.h.fund(s.w.quoteMint, s.w.admin, stranger.address, 1n);
    const theirs = getWithdrawBondInstruction({ lister: stranger, venue: s.venue, bondMint: s.w.quoteMint, bond: s.bond, vault: s.vault, listerToken: await ata(stranger.address, s.w.quoteMint), tokenProgram: TOKEN_2022_PROGRAM_ADDRESS, amount: 1n });
    expect(await s.w.h.fail([theirs], stranger)).toBeTruthy();
  });

  it('refuses a listing without enough free bond, a cross the lister did not create, a cross that is not live, and a second listing of one cross', async () => {
    const s = await setup();
    const cross = await s.w.newCross();
    expect(await s.w.h.fail([(await s.list(cross.address)).ix], s.lister)).toBeTruthy(); // bond account has nothing in it
    await s.deposit(150n * TOKEN);
    await s.w.h.send([(await s.list(cross.address)).ix], s.lister);
    expect(await s.w.h.fail([(await s.list(cross.address)).ix], s.lister)).toBeTruthy(); // listed once only
    const second = await s.w.newCross();
    expect(await s.w.h.fail([(await s.list(second.address)).ix], s.lister)).toContain('BondTooSmall'); // 50 free, 100 needed
    await s.deposit(50n * TOKEN);
    await s.w.h.send([(await s.list(second.address)).ix], s.lister);
    // A cross that is no longer live.
    const done = await s.w.newCross();
    s.w.h.setTime(done.data.closeTs + 1n);
    await s.w.settle(done);
    await s.deposit(100n * TOKEN);
    expect(await s.w.h.fail([(await s.list(done.address)).ix], s.lister)).toContain('CrossNotLive');
  });
});

describe('who can list', () => {
  it('only the creator of a cross can list it, whoever else holds a bond', async () => {
    const s = await setup();
    const rival = await s.w.trader(1_000n * TOKEN);
    const [rivalBond] = await findBondPda({ venue: s.venue, lister: rival.address });
    const rivalVault = await ata(rivalBond, s.w.quoteMint);
    await s.w.h.send([getOpenBondInstruction({ lister: rival, venue: s.venue, bondMint: s.w.quoteMint, bond: rivalBond, vault: rivalVault, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS })], rival);
    await s.w.h.send([getDepositBondInstruction({ lister: rival, venue: s.venue, bondMint: s.w.quoteMint, listerToken: await ata(rival.address, s.w.quoteMint), bond: rivalBond, vault: rivalVault, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS, amount: 500n * TOKEN })], rival);
    const cross = await s.w.newCross();
    expect(await s.w.h.fail([(await s.list(cross.address, rival)).ix], rival)).toContain('NotTheCreator');
    // Nor can a lister borrow another lister's bond account.
    const [listing] = await findListingPda({ venue: s.venue, cross: cross.address });
    const stolen = getListCrossInstruction({ lister: rival, venue: s.venue, bond: s.bond, cross: cross.address, listing });
    expect(await s.w.h.fail([stolen], rival)).toBeTruthy();
  });
});

describe('release and slash', () => {
  it('a cross that ends well releases the bond after the delay, and not before', async () => {
    const s = await setup();
    await s.deposit(100n * TOKEN);
    const cross = await s.w.newCross();
    const buyer = await s.w.trader(1_000n * TOKEN);
    const seller = await s.w.trader(0n, 1_000n * TOKEN);
    const { listing, ix } = await s.list(cross.address);
    await s.w.h.send([ix], s.lister);
    const o1 = await s.w.place(cross, buyer, OrderSide.Buy, 1_500_000n, 100n * TOKEN);
    const o2 = await s.w.place(cross, seller, OrderSide.Sell, 1_000_000n, 100n * TOKEN);
    const settled = await s.w.settle(cross);
    expect(settled.data.state).toBe(CrossState.Cleared);
    // Not ended yet: the cross is cleared but not finalized.
    expect(await s.w.h.fail([s.release(listing, cross.address)], s.w.admin)).toBeTruthy();
    await s.w.claimAll(settled, [o1, o2]);
    await s.w.finalize(s.w.view(cross.address));
    expect(await s.w.h.fail([s.release(listing, cross.address)], s.w.admin)).toContain('TooEarly');
    s.w.h.setTime(cross.data.closeTs + DAY);
    await s.w.h.send([s.release(listing, cross.address)], s.w.admin);
    expect(s.readBond()).toMatchObject({ amount: 100n * TOKEN, encumbered: 0n });
    expect(s.readListing(listing).settled).toBe(true);
    expect(await s.w.h.fail([s.release(listing, cross.address)], s.w.admin)).toContain('AlreadySettled');
    // A release is not a slash: the same listing cannot then be slashed either.
    expect(await s.w.h.fail([await s.slashIx(listing, cross.address)], s.w.admin)).toContain('NoFault');
  });

  it('a cross that did not print for a market reason releases the bond and is not a fault', async () => {
    const s = await setup();
    await s.deposit(100n * TOKEN);
    const cross = await s.w.newCross();
    const { listing, ix } = await s.list(cross.address);
    await s.w.h.send([ix], s.lister);
    const settled = await s.w.settle(cross);
    expect(settled.data.state).toBe(CrossState.NoPrint);
    expect(settled.data.noPrintReason).toMatchObject({ __option: 'Some', value: NoPrintReason.NoCross });
    expect(await s.w.h.fail([await s.slashIx(listing, cross.address)], s.w.admin)).toContain('NoFault');
    s.w.h.setTime(cross.data.closeTs + DAY);
    await s.w.h.send([s.release(listing, cross.address)], s.w.admin);
    expect(s.readBond().encumbered).toBe(0n);
  });

  it('an unbound settlement slashes the bond to the venue account, once, and a release is then refused', async () => {
    const s = await setup();
    await s.deposit(300n * TOKEN);
    const settler = await s.w.h.wallet();
    const cross = await s.w.newCross({ supplyMode: SupplyMode.DeferredMint, schedule, settler: settler.address, settleDeadlineTs: T0 + 500n });
    const { listing, ix } = await s.list(cross.address);
    await s.w.h.send([ix], s.lister);
    const buyer = await s.w.trader(10_000n * TOKEN);
    const order = await s.w.place(cross, buyer, OrderSide.Buy, 1_200_000n, 1_000n * TOKEN);
    await s.w.settle(cross);
    // Not a fault yet: the settlement may still be bound.
    expect(await s.w.h.fail([await s.slashIx(listing, cross.address)], s.w.admin)).toContain('NoFault');
    s.w.h.setTime(T0 + 500n);
    await s.w.h.send([getAbandonSettlementInstruction({ cross: cross.address })], s.w.admin);
    const after = s.w.view(cross.address);
    expect(after.data.noPrintReason).toMatchObject({ __option: 'Some', value: NoPrintReason.SettlementExpired });
    // The buyer is refunded in full by the cross itself; the bond is a separate matter.
    await s.w.claimAll(after, [order]);
    expect(await s.w.h.balanceOf(buyer.address, s.w.quoteMint)).toBe(10_000n * TOKEN);

    const before = await s.slashAcct().then((a) => s.w.h.balance(a));
    s.w.h.setTime(cross.data.closeTs + 2n * DAY);
    expect(await s.w.h.fail([s.release(listing, cross.address)], s.w.admin)).toContain('NotEnded');
    await s.w.h.send([await s.slashIx(listing, cross.address)], s.w.admin);
    expect(await s.slashAcct().then((a) => s.w.h.balance(a))).toBe(before + 100n * TOKEN);
    expect(s.readBond()).toMatchObject({ amount: 200n * TOKEN, encumbered: 0n });
    expect(s.w.h.balance(s.vault)).toBe(200n * TOKEN);
    expect(await s.w.h.fail([await s.slashIx(listing, cross.address)], s.w.admin)).toContain('AlreadySettled');
  });

  it('the slash can only go to the venue account, and a listing cannot be settled against another cross', async () => {
    const s = await setup();
    await s.deposit(300n * TOKEN);
    const settler = await s.w.h.wallet();
    const cross = await s.w.newCross({ supplyMode: SupplyMode.DeferredMint, schedule, settler: settler.address, settleDeadlineTs: T0 + 500n });
    const { listing, ix } = await s.list(cross.address);
    await s.w.h.send([ix], s.lister);
    const other = await s.w.newCross({ supplyMode: SupplyMode.DeferredMint, schedule, settler: settler.address, settleDeadlineTs: T0 + 500n });
    const buyer = await s.w.trader(10_000n * TOKEN);
    await s.w.place(cross, buyer, OrderSide.Buy, 1_200_000n, 10n * TOKEN);
    await s.w.place(other, buyer, OrderSide.Buy, 1_200_000n, 10n * TOKEN);
    await s.w.settle(cross);
    await s.w.settle(other);
    s.w.h.setTime(T0 + 500n);
    await s.w.h.send([getAbandonSettlementInstruction({ cross: cross.address })], s.w.admin);
    await s.w.h.send([getAbandonSettlementInstruction({ cross: other.address })], s.w.admin);
    // The attacker names its own token account as the slash destination.
    const thief = await s.w.h.wallet();
    const thiefAcct = await s.w.h.ata(thief.address, s.w.quoteMint, s.w.admin);
    const steal = getSlashListingInstruction({ listing, lister: s.lister.address, venue: s.venue, bond: s.bond, cross: cross.address, bondMint: s.w.quoteMint, vault: s.vault, slashAccount: thiefAcct, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS });
    expect(await s.w.h.fail([steal], thief)).toBeTruthy();
    // Another faulted cross in place of the listed one.
    expect(await s.w.h.fail([await s.slashIx(listing, other.address)], s.w.admin)).toContain('WrongCross');
  });

  it('refuses venue terms with no bond or a delay under a day', async () => {
    const w = await World.create();
    for (const [i, [minBond, delay]] of ([[0n, DAY], [TOKEN, DAY - 1n]] as const).entries()) {
      const [venue] = await findVenuePda({ creator: w.admin.address, id: BigInt(i + 5) });
      expect(await w.h.fail([getCreateVenueInstruction({ creator: w.admin, bondMint: w.quoteMint, venue, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS, id: BigInt(i + 5), minBond, releaseDelaySecs: delay, slashTo: w.admin.address })], w.admin)).toContain('BadTerms');
    }
  });
});
