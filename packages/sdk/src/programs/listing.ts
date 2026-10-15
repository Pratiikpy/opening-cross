// Builders for `cross_listing` (L1; ADR-0653): a venue with fixed terms, a lister's bond, listing of a cross the lister created, release after the delay
// and a slash to the venue's account when the cross ended because its settlement never happened.
import { type Address, type Instruction, type TransactionSigner } from '@solana/kit';
import {
  type Bond,
  CROSS_LISTING_PROGRAM_ADDRESS,
  type Listing,
  type Venue,
  findBondPda,
  findListingPda,
  findVenuePda,
  getCreateVenueInstruction,
  getDepositBondInstruction,
  getListCrossInstruction,
  getOpenBondInstruction,
  getReleaseListingInstruction,
  getSlashListingInstruction,
  getWithdrawBondInstruction,
} from '@opening-cross/cross-listing-client';
import { type Cross, CrossState, NoPrintReason, ata } from '../index.js';
import { type ProgramIssue, createAtaIdempotent, refuse } from './common.js';

export { CROSS_LISTING_PROGRAM_ADDRESS };
export type { Bond, Listing, Venue };

/** The shortest delay a venue may set between a cross's close and the release of its bond: a day (the program's `MIN_RELEASE_DELAY_SECS`). */
export const LISTING_MIN_RELEASE_DELAY_SECS = 86_400n;

export function checkVenueTerms(minBond: bigint, releaseDelaySecs: bigint): ProgramIssue[] {
  const out: ProgramIssue[] = [];
  if (!(minBond > 0n)) out.push({ code: 'BadTerms', field: 'minBond', message: 'a listing sets aside a positive bond' });
  if (releaseDelaySecs < LISTING_MIN_RELEASE_DELAY_SECS) out.push({ code: 'BadTerms', field: 'releaseDelaySecs', message: 'the release delay is at least one day (86,400 seconds)' });
  return out;
}

export async function venueAddress(creator: Address, id: bigint): Promise<Address> {
  return (await findVenuePda({ creator, id }))[0];
}
export async function bondAddresses(venue: Address, lister: Address, bondMint: Address, bondTokenProgram: Address): Promise<{ bond: Address; vault: Address }> {
  const [bond] = await findBondPda({ venue, lister });
  return { bond, vault: await ata(bond, bondMint, bondTokenProgram) };
}
export async function listingAddress(venue: Address, cross: Address): Promise<Address> {
  return (await findListingPda({ venue, cross }))[0];
}

/** `create_venue`: the terms never change. `slashTo` owns the account that receives slashed bonds; that account must exist before a slash. */
export async function buildCreateVenue(input: { creator: TransactionSigner; id: bigint; bondMint: Address; bondTokenProgram: Address; minBond: bigint; releaseDelaySecs: bigint; slashTo: Address }): Promise<{ instruction: Instruction; venue: Address }> {
  refuse(checkVenueTerms(input.minBond, input.releaseDelaySecs));
  const venue = await venueAddress(input.creator.address, input.id);
  return { venue, instruction: getCreateVenueInstruction({ creator: input.creator, bondMint: input.bondMint, venue, tokenProgram: input.bondTokenProgram, id: input.id, minBond: input.minBond, releaseDelaySecs: input.releaseDelaySecs, slashTo: input.slashTo }) };
}

/** `open_bond`: the lister's bond account and vault on a venue, empty. */
export async function buildOpenBond(input: { lister: TransactionSigner; venue: Address; bondMint: Address; bondTokenProgram: Address }): Promise<{ instruction: Instruction; bond: Address; vault: Address }> {
  const a = await bondAddresses(input.venue, input.lister.address, input.bondMint, input.bondTokenProgram);
  return { ...a, instruction: getOpenBondInstruction({ lister: input.lister, venue: input.venue, bondMint: input.bondMint, bond: a.bond, vault: a.vault, tokenProgram: input.bondTokenProgram }) };
}

export async function buildDepositBond(input: { lister: TransactionSigner; venue: Address; bondMint: Address; bondTokenProgram: Address; amount: bigint }): Promise<Instruction> {
  refuse(input.amount > 0n ? [] : [{ code: 'NothingToDo', field: 'amount', message: 'deposit a positive amount' }]);
  const a = await bondAddresses(input.venue, input.lister.address, input.bondMint, input.bondTokenProgram);
  return getDepositBondInstruction({ lister: input.lister, venue: input.venue, bondMint: input.bondMint, listerToken: await ata(input.lister.address, input.bondMint, input.bondTokenProgram), bond: a.bond, vault: a.vault, tokenProgram: input.bondTokenProgram, amount: input.amount });
}

/** `withdraw_bond`: only the bond no open listing has set aside. `bond` is the decoded account when known, to refuse a withdrawal the program would. */
export async function buildWithdrawBond(input: { lister: TransactionSigner; venue: Address; bondMint: Address; bondTokenProgram: Address; amount: bigint; bond?: Pick<Bond, 'amount' | 'encumbered'> }): Promise<Instruction> {
  const issues: ProgramIssue[] = [];
  if (!(input.amount > 0n)) issues.push({ code: 'NothingToDo', field: 'amount', message: 'withdraw a positive amount' });
  if (input.bond && input.amount > input.bond.amount - input.bond.encumbered) issues.push({ code: 'BondEncumbered', field: 'amount', message: `only ${input.bond.amount - input.bond.encumbered} of the bond is free; the rest is set aside for open listings` });
  refuse(issues);
  const a = await bondAddresses(input.venue, input.lister.address, input.bondMint, input.bondTokenProgram);
  return getWithdrawBondInstruction({ lister: input.lister, venue: input.venue, bondMint: input.bondMint, bond: a.bond, vault: a.vault, listerToken: await ata(input.lister.address, input.bondMint, input.bondTokenProgram), tokenProgram: input.bondTokenProgram, amount: input.amount });
}

/** What `list_cross` refuses from the facts it reads: the lister created the cross, the cross still takes orders, the free bond covers `min_bond`. */
export function checkListing(f: { lister: Address; cross: { data: Pick<Cross, 'creator' | 'state'> }; venue: Pick<Venue, 'minBond'>; bond: Pick<Bond, 'amount' | 'encumbered'> }): ProgramIssue[] {
  const out: ProgramIssue[] = [];
  if (f.cross.data.creator !== f.lister) out.push({ code: 'NotTheCreator', field: 'cross', message: 'only the wallet that created a cross can list it' });
  if (f.cross.data.state !== CrossState.Live) out.push({ code: 'CrossNotLive', field: 'cross', message: 'only a cross that is still taking orders can be listed' });
  const free = f.bond.amount - f.bond.encumbered;
  if (free < f.venue.minBond) out.push({ code: 'BondTooSmall', field: 'bond', message: `listing sets aside ${f.venue.minBond}; the bond has ${free} free` });
  return out;
}

export async function buildListCross(input: { lister: TransactionSigner; venue: Address; cross: Address }): Promise<{ instruction: Instruction; listing: Address }> {
  const [bond] = await findBondPda({ venue: input.venue, lister: input.lister.address });
  const listing = await listingAddress(input.venue, input.cross);
  return { listing, instruction: getListCrossInstruction({ lister: input.lister, venue: input.venue, bond, cross: input.cross, listing }) };
}

/**
 * What a listing's cross says about it: `release` once it ended well and the delay passed, `slash` when it ended because its settlement never happened,
 * `wait` otherwise (still open, or the delay has not passed), `settled` when the listing was already released or slashed.
 */
export function listingVerdict(f: { listing: Pick<Listing, 'releaseAfter' | 'settled'>; cross: { state: CrossState; noPrintReason: { __option: 'Some'; value: NoPrintReason } | { __option: 'None' } }; now: bigint }): 'release' | 'slash' | 'wait' | 'settled' {
  if (f.listing.settled) return 'settled';
  const fault = f.cross.state === CrossState.NoPrint && f.cross.noPrintReason.__option === 'Some' && f.cross.noPrintReason.value === NoPrintReason.SettlementExpired;
  if (fault) return 'slash';
  const endedWell = f.cross.state === CrossState.Finalized || f.cross.state === CrossState.NoPrint;
  return endedWell && f.now >= f.listing.releaseAfter ? 'release' : 'wait';
}

/** `release_listing` (anyone). */
export function buildReleaseListing(input: { listing: Address; lister: Address; venue: Address; bond: Address; cross: Address }): Instruction {
  return getReleaseListingInstruction(input);
}

/** `slash_listing` (anyone). The slash account is the associated token account of the venue's `slash_to`; it is created first, paid by `payer`, when `createSlashAccount` is set. */
export async function buildSlashListing(input: { payer: TransactionSigner; listing: Address; lister: Address; venue: Address; slashTo: Address; cross: Address; bondMint: Address; bondTokenProgram: Address; createSlashAccount?: boolean }): Promise<Instruction[]> {
  const { bond, vault } = await bondAddresses(input.venue, input.lister, input.bondMint, input.bondTokenProgram);
  const slashAccount = await ata(input.slashTo, input.bondMint, input.bondTokenProgram);
  const slash = getSlashListingInstruction({ listing: input.listing, lister: input.lister, venue: input.venue, bond, cross: input.cross, bondMint: input.bondMint, vault, slashAccount, tokenProgram: input.bondTokenProgram });
  return input.createSlashAccount ? [createAtaIdempotent(input.payer, input.slashTo, input.bondMint, input.bondTokenProgram, slashAccount), slash] : [slash];
}
