// The passes of the keeper's Wave 3D duties: read the accounts of each candidate from chain (discovery is only a hint), plan with the pure planners of program-duties.ts, and send.
// `perform` is the keeper's own sender (keeper.ts): it records a dry run, a success or a failure the way the other duties do.
import type { Address, Instruction } from '@solana/kit';
import { type Cross, getCrossDecoder } from '@opening-cross/cross-core-client';
import { getHaltStateDecoder, haltStateAddress } from '@opening-cross/cross-core-client';
import { getBountyDecoder } from '@opening-cross/cross-bounty-client';
import { getCharterDecoder, getRoundDecoder } from '@opening-cross/cross-graduate-client';
import { getListingDecoder, getVenueDecoder } from '@opening-cross/cross-listing-client';
import { ATTESTATION_DISCRIMINATOR, getAttestationDecoder, getPolicyDecoder } from '@opening-cross/cross-backing-client';
import {
  ata,
  backingAddresses,
  bondAddresses,
  bountyAddresses,
  buildCheckBacking,
  buildClaimInvariant,
  buildFinalizeRound,
  buildPublishOutcome,
  buildReleaseListing,
  buildSlashListing,
  outcomeAddress,
  roundAddress,
} from '@opening-cross/sdk';
import type { Action } from './plan.js';
import { type BountyFacts, type ListingFacts, planBacking, planBounty, planGraduation, planListing } from './program-duties.js';
import type { Duty, KeeperDeps, PassResult } from './keeper.js';
import { partnerFeesPass } from './partner-fees.js';

/** The sender the passes use: runs the instructions of one action (a dry run only records it). */
export type Perform = (d: KeeperDeps, result: PassResult, action: Action, build: () => Promise<Instruction[][]>) => Promise<boolean>;

/** Crosses examined for a bounty per pass: a bounty with an unpaid invariant looks at this many, oldest first. */
export const MAX_BOUNTY_CROSSES = 2_000;

const u64At = (data: Uint8Array, at: number): bigint => new DataView(data.buffer, data.byteOffset).getBigUint64(at, true);
const tryDecode = <T>(decode: (b: Uint8Array) => T, data: Uint8Array): T | null => {
  try {
    return decode(data);
  } catch {
    return null;
  }
};

export async function programPasses(d: KeeperDeps, now: bigint, result: PassResult, perform: Perform): Promise<void> {
  const duties = d.duties ?? new Set<Duty>();
  if (duties.has('backing') && d.policies) await backingPass(d, now, result, perform);
  if (duties.has('graduation') && d.charters) await graduationPass(d, now, result, perform);
  if (duties.has('listings') && d.listings) await listingsPass(d, now, result, perform);
  if (duties.has('bounties') && d.bounties) await bountiesPass(d, now, result, perform);
  if (duties.has('partner-fees')) await partnerFeesPass(d, now, result, perform);
}

async function inScope(d: KeeperDeps, cross: Address): Promise<boolean> {
  if (!d.accept) return true;
  const raw = await d.fetch(cross);
  const c = raw ? tryDecode((b) => getCrossDecoder().decode(b), raw) : null;
  return !!c && d.accept(c);
}

// ------------------------------------------------------------------ graduation

async function graduationPass(d: KeeperDeps, now: bigint, result: PassResult, perform: Perform): Promise<void> {
  for (const address of await d.charters!()) {
    const raw = await d.fetch(address);
    const charter = raw ? tryDecode((b) => getCharterDecoder().decode(b), raw) : null;
    if (!charter) continue;
    if (!(await inScope(d, charter.cross))) continue;
    // A closed round is finalized and, when it passed, its outcome is published in the same pass: the second step is planned again from chain once the first has landed.
    for (let step = 0; step < 2; step++) {
      const fresh = step === 0 ? charter : tryDecode((b) => getCharterDecoder().decode(b), (await d.fetch(address)) ?? new Uint8Array());
      if (!fresh) break;
      let round: { address: Address; data: ReturnType<ReturnType<typeof getRoundDecoder>['decode']> } | null = null;
      if (fresh.rounds > 0) {
        const ra = await roundAddress(fresh.cross, fresh.rounds - 1);
        const rr = await d.fetch(ra);
        const data = rr ? tryDecode((b) => getRoundDecoder().decode(b), rr) : null;
        if (data) round = { address: ra, data };
      }
      const mintRaw = round ? await d.fetch(round.data.baseMint) : null;
      const supply = mintRaw && mintRaw.length >= 44 ? u64At(mintRaw, 36) : null;
      const outcomePublished = (await d.fetch(await outcomeAddress(fresh.cross))) !== null;
      const p = planGraduation({ cross: fresh.cross, charter: fresh, round, supply, outcomePublished }, now);
      if (step === 0) result.skipped.push(...p.skipped);
      let sent = false;
      for (const action of p.actions) {
        sent =
          (await perform(d, result, action, async () => {
            if (action.kind === 'finalize-round') return [[await buildFinalizeRound({ cross: action.cross, round: action.round, baseMint: action.baseMint })]];
            if (action.kind === 'publish-outcome') return [[(await buildPublishOutcome({ payer: d.payer, cross: action.cross, round: action.round })).instruction]];
            throw new Error(`unexpected graduation action ${action.kind}`);
          })) || sent;
      }
      if (!sent) break;
    }
  }
}

// ------------------------------------------------------------------ listings

async function listingsPass(d: KeeperDeps, now: bigint, result: PassResult, perform: Perform): Promise<void> {
  for (const address of await d.listings!()) {
    const raw = await d.fetch(address);
    const listing = raw ? tryDecode((b) => getListingDecoder().decode(b), raw) : null;
    if (!listing || listing.settled) continue;
    if (!(await inScope(d, listing.cross))) continue;
    const venueRaw = await d.fetch(listing.venue);
    const venue = venueRaw ? tryDecode((b) => getVenueDecoder().decode(b), venueRaw) : null;
    const crossRaw = await d.fetch(listing.cross);
    const cross: Cross | null = crossRaw ? tryDecode((b) => getCrossDecoder().decode(b), crossRaw) : null;
    if (!venue || !cross) continue;
    const { bond } = await bondAddresses(listing.venue, listing.lister, venue.bondMint, venue.bondTokenProgram);
    const slashAccountExists = (await d.fetch(await ata(venue.slashTo, venue.bondMint, venue.bondTokenProgram))) !== null;
    const facts: ListingFacts = { address, listing, venue, cross, bond, slashAccountExists };
    const p = planListing(facts, now);
    result.skipped.push(...p.skipped);
    for (const action of p.actions) {
      await perform(d, result, action, async () => {
        if (action.kind === 'release-listing') return [[buildReleaseListing({ listing: action.listing, lister: action.lister, venue: action.venue, bond: action.bond, cross: action.cross })]];
        if (action.kind === 'slash-listing') {
          return [await buildSlashListing({ payer: d.payer, listing: action.listing, lister: action.lister, venue: action.venue, slashTo: action.slashTo, cross: action.cross, bondMint: action.bondMint, bondTokenProgram: action.bondTokenProgram, createSlashAccount: action.createSlashAccount })];
        }
        throw new Error(`unexpected listing action ${action.kind}`);
      });
    }
  }
}

// ------------------------------------------------------------------ bounties

async function bountiesPass(d: KeeperDeps, now: bigint, result: PassResult, perform: Perform): Promise<void> {
  let crossAddresses: Address[] | null = null;
  for (const address of await d.bounties!()) {
    const raw = await d.fetch(address);
    const bounty = raw ? tryDecode((b) => getBountyDecoder().decode(b), raw) : null;
    if (!bounty || now >= bounty.expiresAt) continue;
    // Nothing to look for when every invariant the bounty pays has paid.
    const open = bounty.rewards.some((r, i) => r > 0n && (bounty.paidMask & (1 << i)) === 0);
    if (!open) continue;
    const vault = (await bountyAddresses(bounty.sponsor, bounty.id, bounty.rewardMint, bounty.tokenProgram)).vault;
    const vaultRaw = await d.fetch(vault);
    const pool = vaultRaw && vaultRaw.length >= 72 ? u64At(vaultRaw, 64) : 0n;
    if (pool === 0n) {
      result.skipped.push(...planBounty({ address, bounty, pool, crosses: [] }, now).skipped);
      continue;
    }
    crossAddresses ??= (await (d.bountyCrosses ?? d.crosses)()).slice(0, MAX_BOUNTY_CROSSES);
    const crosses: BountyFacts['crosses'] = [];
    for (const a of crossAddresses) {
      const cr = await d.fetch(a);
      const data = cr ? tryDecode((b) => getCrossDecoder().decode(b), cr) : null;
      if (data) crosses.push({ address: a, data });
    }
    const p = planBounty({ address, bounty, pool, crosses }, now);
    result.skipped.push(...p.skipped);
    for (const action of p.actions) {
      if (action.kind !== 'claim-invariant') continue;
      await perform(d, result, action, async () => [await buildClaimInvariant({ claimant: d.payer, bounty: action.bounty, vault, rewardMint: action.rewardMint, tokenProgram: action.tokenProgram, cross: action.cross, invariant: action.invariant, createDestination: true })]);
    }
  }
}

// ------------------------------------------------------------------ backing

async function backingPass(d: KeeperDeps, now: bigint, result: PassResult, perform: Perform): Promise<void> {
  for (const address of await d.policies!()) {
    const raw = await d.fetch(address);
    const policy = raw ? tryDecode((b) => getPolicyDecoder().decode(b), raw) : null;
    if (!policy) continue;
    const a = await backingAddresses(policy.mint);
    const attRaw = await d.fetch(a.attestation);
    const att = attRaw && (ATTESTATION_DISCRIMINATOR as Uint8Array).every((b, i) => attRaw[i] === b) ? tryDecode((b) => getAttestationDecoder().decode(b), attRaw) : null;
    const mintRaw = await d.fetch(policy.mint);
    const supply = mintRaw && mintRaw.length >= 44 ? u64At(mintRaw, 36) : null;
    const haltRaw = await d.fetch(await haltStateAddress(policy.mint));
    const halt = haltRaw ? tryDecode((b) => getHaltStateDecoder().decode(b), haltRaw) : null;
    const p = planBacking({ mint: policy.mint, policy, attestation: att && att.mint === policy.mint ? att : null, supply, halted: halt?.halted ?? false }, now);
    result.skipped.push(...p.skipped);
    for (const action of p.actions) {
      await perform(d, result, action, async () => {
        if (action.kind === 'check-backing') return [[await buildCheckBacking({ mint: action.mint })]];
        throw new Error(`unexpected backing action ${action.kind}`);
      });
    }
  }
}
