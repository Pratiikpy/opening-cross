// Stake-bonded listing (L1; ADR-0653): what the listing routes serve, the words a lister and a holder read, and the forms that become the bodies of the
// listing routes. Pure and free of React. Integers that can exceed 2^53 are decimal strings; times are Unix seconds.
//
// Rules of the program (programs/cross_listing, docs/evidence/W3D-L1.md): a venue fixes its terms for good (a bond token, the bond one listing sets aside, a release
// delay of at least a day, the owner of the account slashed bonds go to). A lister opens a bond, deposits, and lists a cross it created that still takes orders. The
// set-aside bond is released, by anyone, once the cross ended well and the delay passed; it is slashed, by anyone, only when the cross ended because the settlement
// its creator promised never happened (NoPrintReason SettlementExpired). Buyers are refunded by the cross itself; the bond is the price of the failure.
import { isAddress } from '@solana/kit';
import type { ReleaseNote } from './new-programs';
import { formatAtoms, parseAtoms, shortAddress } from './units';

export type VenueRow = { venue: string; creator: string; bondMint: string; minBond: string; releaseDelaySecs: number; slashTo: string; listings: number; openListings: number };
export type VenuesRead = { venues: VenueRow[]; release: ReleaseNote; note?: string };
export type BondRead = { opened?: false; address?: string; vault?: string; total?: string; setAside?: string; free?: string; fitsAnother?: boolean };
export type VenueRead = { venue: string; creator: string; id: string; bondMint: string; bondTokenProgram: string; minBond: string; releaseDelaySecs: string; slashTo: string; slashAccount: string; bond?: BondRead; release: ReleaseNote };
export type ListingStatus = 'open' | 'released' | 'slashed';
export type ListingRow = { listing: string; venue: string; lister: string; cross: string; amount: string; status: ListingStatus; slashedTo: string | null; createdSlot: string };
export type ListingsRead = { venue?: string; cross?: string; listings: ListingRow[]; release: ReleaseNote };
export type ListingNext = 'release' | 'slash' | 'wait' | 'settled';
export type ListingDetail = { listing: string; venue: string; lister: string; cross: string; crossState: string | null; amount: string; releaseAfter: string; settled: boolean; next: ListingNext | null; release: ReleaseNote };

export const days = (secs: number | string): string => {
  const d = Number(secs) / 86_400;
  return `${Number.isInteger(d) ? d : d.toFixed(1)} day${d === 1 ? '' : 's'}`;
};

/** What a listing is doing, in a sentence a holder reads. */
export function statusLine(l: Pick<ListingRow, 'status' | 'slashedTo' | 'lister'>, bond: string): string {
  if (l.status === 'open') return `${bond} of the lister's bond is set aside against this listing. It comes back when the cross ends well and the venue's delay has passed; it goes to the venue only if the cross fails because its settlement never happened.`;
  if (l.status === 'released') return `The bond (${bond}) was released to the lister: the cross ended without the fault the bond covers.`;
  return `The bond (${bond}) was slashed${l.slashedTo ? ` to ${shortAddress(l.slashedTo)}` : ''}: the cross failed because its settlement never happened.`;
}

export const NEXT_LABEL: Record<ListingNext, string> = {
  release: 'Ready to release: the cross ended well and the delay has passed.',
  slash: 'Ready to slash: the cross failed because its settlement never happened.',
  wait: 'Not yet: the cross is still open, or the venue’s delay has not passed.',
  settled: 'Settled: the bond was already released or slashed.',
};

// ---------------------------------------------------------------------------------------------------- forms

export type VenueForm = { bondMint: string; minBond: string; delayDays: string; slashTo: string };
export const EMPTY_VENUE: VenueForm = { bondMint: '', minBond: '', delayDays: '7', slashTo: '' };
export type VenueErrors = Partial<Record<keyof VenueForm, string>>;

/** The body of POST /v1/tx/listing-create-venue. A venue never changes, so every bound the program has is checked here first. */
export function buildVenue(f: VenueForm, creator: string | null, bondDecimals: number | null): { body: Record<string, unknown> | null; errors: VenueErrors } {
  const errors: VenueErrors = {};
  if (!isAddress(f.bondMint.trim())) errors.bondMint = 'This is not a Solana address.';
  const bond = bondDecimals === null ? null : parseAtoms(f.minBond, bondDecimals);
  if (f.minBond.trim() === '' || bond === null || bond === 0n) errors.minBond = bondDecimals === null ? 'The bond token’s decimals have not been read yet.' : `A bond above zero with at most ${bondDecimals} decimals.`;
  const d = f.delayDays.trim();
  const delay = /^\d{1,4}$/.test(d) ? Number(d) : null;
  if (delay === null || delay < 1) errors.delayDays = 'A release delay is a whole number of days, at least 1.';
  const slash = f.slashTo.trim() === '' ? creator : f.slashTo.trim();
  if (slash && !isAddress(slash)) errors.slashTo = 'This is not a Solana address.';
  if (Object.keys(errors).length > 0 || !creator || bond === null || delay === null || !slash) return { body: null, errors };
  return { body: { creator, bondMint: f.bondMint.trim(), minBond: bond.toString(), releaseDelaySecs: delay * 86_400, slashTo: slash }, errors };
}

/** A token amount typed by a person, as the atoms string a route takes; null when it is not one. */
export function atomsText(text: string, decimals: number | null): string | null {
  if (decimals === null) return null;
  const v = parseAtoms(text, decimals);
  return v === null || v === 0n ? null : v.toString();
}

/** What the lister's bond can do, in words. */
export function bondLine(b: BondRead | undefined, decimals: number, symbol: string): string {
  if (!b) return 'Connect a wallet to see your bond on this venue.';
  if (b.opened === false) return 'You have no bond on this venue yet. Open one, then deposit.';
  const f = (v: string | undefined) => `${formatAtoms(BigInt(v ?? '0'), decimals)} ${symbol}`.trim();
  return `Your bond: ${f(b.total)} in total, ${f(b.setAside)} set aside by open listings, ${f(b.free)} free${b.fitsAnother ? ': enough to list another cross.' : '.'}`;
}
