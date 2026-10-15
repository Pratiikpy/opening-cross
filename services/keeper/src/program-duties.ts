// The keeper's duties for the Wave 3D programs (ADR-0650 to ADR-0656): each is a pure planner over account data the keeper has just read, so any number of keepers can run it and the
// program's own checks make every duplicate a harmless failure (ADR-0703). None of these programs is on devnet until the operations key is funded (docs/HUMAN_TASKS.md H27, H43); on a
// cluster that lacks one, discovery finds no accounts and the duty has nothing to do.
//
//   graduation  a graduation round whose window has closed is finalized; a passed round's outcome is published (cross_graduate: both are permissionless)
//   listings    a listing whose cross ended well and whose delay has passed is released; one whose cross ended because its settlement never happened is slashed (cross_listing)
//   bounties    a cross account that breaks an invariant a bounty pays is claimed, so the reward goes to this keeper's wallet before a stranger takes it (cross_bounty)
//   backing     an opted-in asset whose attested backing is missing, stale or short is halted by `check` (cross_backing)
import type { Address } from '@solana/kit';
import { type Cross, CrossState } from '@opening-cross/cross-core-client';
import { type Bounty } from '@opening-cross/cross-bounty-client';
import { type Charter, type Round } from '@opening-cross/cross-graduate-client';
import { type Listing, type Venue } from '@opening-cross/cross-listing-client';
import { type Attestation, type Policy } from '@opening-cross/cross-backing-client';
import { BOUNTY_INVARIANTS, backingVerdict, brokenInvariants, checkBountyClaim, listingVerdict, roundShortfall } from '@opening-cross/sdk';
import type { Planned } from './duties.js';

// ------------------------------------------------------------------ graduation

export type GraduationFacts = {
  cross: Address;
  charter: Charter;
  /** The latest round the charter started, with its address; null when none started. */
  round: { address: Address; data: Round } | null;
  /** The live supply of the round's token (the quorum is measured against it); null when it could not be read. */
  supply: bigint | null;
  /** Whether the outcome account of the cross exists. */
  outcomePublished: boolean;
};

export function planGraduation(f: GraduationFacts, now: bigint): Planned {
  const here = f.cross;
  const skip = (code: string, reason: string): Planned => ({ actions: [], skipped: [{ cross: here, code, reason }] });
  if (!f.round) return skip('GRADUATION_NO_ROUND', 'the creator has not started a round: only the creator can');
  const r = f.round.data;
  if (!r.finalized) {
    if (now < r.closesTs) return skip('GRADUATION_VOTING', `the voting window closes at ${r.closesTs}`);
    return { actions: [{ kind: 'finalize-round', cross: here, round: f.round.address, baseMint: r.baseMint }], skipped: [] };
  }
  if (r.passed && !f.outcomePublished) return { actions: [{ kind: 'publish-outcome', cross: here, round: f.round.address }], skipped: [] };
  if (r.passed) return { actions: [], skipped: [] };
  // A round that failed: only the creator starts the next one, and the keeper says why this one failed.
  const why = f.supply === null ? null : roundShortfall({ lockedTotal: r.lockedTotal, supply: f.supply, quorumBps: r.quorumBps, tallies: r.tallies, minVolume: r.minVolume, volume: r.volumeSet ? r.volumeQuote : null });
  return skip('GRADUATION_FAILED', `round ${r.index} failed${why ? `: ${why.message}` : ''}${f.charter.rounds < 3 ? '; the creator may start another' : '; all rounds are used'}`);
}

// ------------------------------------------------------------------ listings

export type ListingFacts = {
  address: Address;
  listing: Listing;
  venue: Venue;
  cross: Cross;
  /** The lister's bond account on the venue. */
  bond: Address;
  /** Whether the venue's slash token account exists (a slash creates it when it does not, which the keeper pays for). */
  slashAccountExists: boolean;
};

export function planListing(f: ListingFacts, now: bigint): Planned {
  const verdict = listingVerdict({ listing: f.listing, cross: f.cross, now });
  const here = f.listing.cross;
  if (verdict === 'release') return { actions: [{ kind: 'release-listing', cross: here, listing: f.address, lister: f.listing.lister, venue: f.listing.venue, bond: f.bond }], skipped: [] };
  if (verdict === 'slash') {
    return { actions: [{ kind: 'slash-listing', cross: here, listing: f.address, lister: f.listing.lister, venue: f.listing.venue, slashTo: f.venue.slashTo, bondMint: f.venue.bondMint, bondTokenProgram: f.venue.bondTokenProgram, createSlashAccount: !f.slashAccountExists }], skipped: [] };
  }
  if (verdict === 'wait' && f.cross.state === CrossState.Finalized) return { actions: [], skipped: [{ cross: here, code: 'LISTING_WAITING', reason: `the listing's bond is released from ${f.listing.releaseAfter}` }] };
  return { actions: [], skipped: [] };
}

// ------------------------------------------------------------------ bounties

export type BountyFacts = {
  address: Address;
  bounty: Bounty;
  /** The reward pool now. */
  pool: bigint;
  /** Crosses to look at, with their accounts as read now. */
  crosses: { address: Address; data: Cross }[];
};

/**
 * One claim per unpaid invariant the bounty covers, for the first cross that breaks it. Every honest cross breaks none (about 19,800 probes of 300 randomized crosses fired no invariant,
 * docs/evidence/W3D-X10.md), so on a healthy protocol this plans nothing. The reward goes to the wallet that sends the claim.
 */
export function planBounty(f: BountyFacts, now: bigint): Planned {
  const actions: Planned['actions'] = [];
  const skipped: Planned['skipped'] = [];
  if (now >= f.bounty.expiresAt) return { actions, skipped };
  if (f.pool === 0n) return { actions, skipped: [{ cross: f.address, code: 'BOUNTY_EMPTY', reason: 'the bounty pool is empty, so a claim would pay nothing' }] };
  const claimed = new Set<number>();
  for (const c of f.crosses) {
    for (const invariant of brokenInvariants(c.data)) {
      if (invariant >= BOUNTY_INVARIANTS || claimed.has(invariant) || checkBountyClaim(f.bounty, invariant, now).length > 0) continue;
      claimed.add(invariant);
      actions.push({ kind: 'claim-invariant', cross: c.address, bounty: f.address, invariant, rewardMint: f.bounty.rewardMint, tokenProgram: f.bounty.tokenProgram });
    }
  }
  return { actions, skipped };
}

// ------------------------------------------------------------------ backing

export type BackingFacts = {
  mint: Address;
  policy: Policy;
  attestation: Pick<Attestation, 'backingAtoms' | 'postedTs'> | null;
  /** The live supply of the mint; null when it could not be read (nothing is done then: a halt needs the figure the program will read). */
  supply: bigint | null;
  /** Whether the asset is halted already. */
  halted: boolean;
};

export function planBacking(f: BackingFacts, now: bigint): Planned {
  const here = f.mint;
  if (f.supply === null) return { actions: [], skipped: [{ cross: here, code: 'BACKING_UNREADABLE', reason: 'the mint could not be read, so the backing was not checked' }] };
  const verdict = backingVerdict({ attestation: f.attestation, supply: f.supply, now, minCoverageBps: f.policy.minCoverageBps, maxAgeSecs: f.policy.maxAgeSecs });
  if (verdict === 'Backed') return { actions: [], skipped: [] };
  if (f.halted) return { actions: [], skipped: [{ cross: here, code: 'BACKING_HALTED', reason: `the backing is ${verdict.toLowerCase()} and the asset is halted already; only a printing resume cross lifts the halt` }] };
  return { actions: [{ kind: 'check-backing', mint: f.mint, verdict }], skipped: [] };
}
