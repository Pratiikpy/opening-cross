// The planners of the Wave 3D duties, one case at a time. Pure: no chain, no clock but the one passed in.
import { describe, expect, it } from 'vitest';
import { type Address, none, some } from '@solana/kit';
import { type Cross, CrossState } from '@opening-cross/cross-core-client';
import type { Charter, Round } from '@opening-cross/cross-graduate-client';
import type { Listing, Venue } from '@opening-cross/cross-listing-client';
import { NoPrintReason } from '@opening-cross/sdk';
import { parseDuties, DEFAULT_DUTIES } from '../src/keeper.js';
import { planBacking, planBounty, planGraduation, planListing } from '../src/program-duties.js';

const NOW = 1_800_000_000n;
const DAY = 86_400n;
const A = (n: number) => `Addr${n}` as unknown as Address;

describe('duty names', () => {
  it('turns graduation and backing on by default, and asks for listings and bounties by name', () => {
    expect([...DEFAULT_DUTIES].sort()).toEqual(['backing', 'challenges', 'graduation', 'halts', 'refunds']);
    expect([...parseDuties(undefined)].sort()).toEqual([...DEFAULT_DUTIES].sort());
    expect(parseDuties('listings').has('listings')).toBe(true);
    expect(parseDuties('listings,bounties').has('bounties')).toBe(true);
    expect(parseDuties('all').size).toBe(10); // the nine of Wave 3D and before, and partner-fees
    expect(parseDuties('none').size).toBe(0);
    expect(() => parseDuties('listing')).toThrow(/unknown keeper duty "listing".*graduation, listings, bounties, backing/);
  });
});

describe('planGraduation', () => {
  const charter = (o: Partial<Charter> = {}) => ({ rounds: 1, active: true, passed: false, ...o }) as unknown as Charter;
  const round = (o: Partial<Round> = {}) => ({ finalized: false, passed: false, closesTs: NOW - 1n, baseMint: A(9), index: 0, lockedTotal: 0n, quorumBps: 4_000, tallies: [0n, 0n, 0n, 0n], minVolume: 0n, volumeSet: false, volumeQuote: 0n, ...o }) as unknown as Round;
  const facts = (r: Round | null, extra: Partial<Parameters<typeof planGraduation>[0]> = {}) => ({ cross: A(1), charter: charter(), round: r ? { address: A(2), data: r } : null, supply: 1_000n, outcomePublished: false, ...extra });

  it('finalizes a round the moment its window has closed, not before', () => {
    expect(planGraduation(facts(round({ closesTs: NOW })), NOW).actions).toEqual([{ kind: 'finalize-round', cross: A(1), round: A(2), baseMint: A(9) }]);
    const open = planGraduation(facts(round({ closesTs: NOW + 1n })), NOW);
    expect(open.actions).toEqual([]);
    expect(open.skipped[0]).toMatchObject({ code: 'GRADUATION_VOTING' });
  });

  it('publishes the outcome of a passed round once', () => {
    expect(planGraduation(facts(round({ finalized: true, passed: true })), NOW).actions).toEqual([{ kind: 'publish-outcome', cross: A(1), round: A(2) }]);
    expect(planGraduation(facts(round({ finalized: true, passed: true }), { outcomePublished: true }), NOW)).toEqual({ actions: [], skipped: [] });
  });

  it('says why a failed round failed and whether the creator may try again, and does nothing', () => {
    const p = planGraduation(facts(round({ finalized: true, passed: false, lockedTotal: 100n, tallies: [100n, 0n, 0n, 0n] })), NOW);
    expect(p.actions).toEqual([]);
    expect(p.skipped[0]).toMatchObject({ code: 'GRADUATION_FAILED' });
    expect(p.skipped[0]!.reason).toMatch(/below the quorum of 40%.*may start another/);
    expect(planGraduation(facts(round({ finalized: true }), { charter: charter({ rounds: 3 }) }), NOW).skipped[0]!.reason).toMatch(/all rounds are used/);
  });

  it('waits for the creator when no round was started', () => {
    expect(planGraduation(facts(null), NOW).skipped[0]).toMatchObject({ code: 'GRADUATION_NO_ROUND' });
  });
});

describe('planListing', () => {
  const listing = (o: Partial<Listing> = {}) => ({ venue: A(5), lister: A(6), cross: A(7), amount: 100n, releaseAfter: NOW - 1n, settled: false, ...o }) as unknown as Listing;
  const venue = { slashTo: A(8), bondMint: A(9), bondTokenProgram: A(10) } as unknown as Venue;
  const cross = (state: CrossState, reason: NoPrintReason | null = null) => ({ state, noPrintReason: reason === null ? none() : some(reason) }) as unknown as Cross;
  const facts = (l: Listing, c: Cross, slashAccountExists = true) => ({ address: A(1), listing: l, venue, cross: c, bond: A(11), slashAccountExists });

  it('releases a listing whose cross ended well once the delay passed, and not a moment before', () => {
    expect(planListing(facts(listing(), cross(CrossState.Finalized)), NOW).actions).toEqual([{ kind: 'release-listing', cross: A(7), listing: A(1), lister: A(6), venue: A(5), bond: A(11) }]);
    const early = planListing(facts(listing({ releaseAfter: NOW + 5n }), cross(CrossState.Finalized)), NOW);
    expect(early.actions).toEqual([]);
    expect(early.skipped[0]).toMatchObject({ code: 'LISTING_WAITING' });
    expect(planListing(facts(listing(), cross(CrossState.NoPrint, NoPrintReason.NoCross)), NOW).actions[0]).toMatchObject({ kind: 'release-listing' });
  });

  it('slashes at once when the settlement never happened, creating the venue\'s account only if it is missing', () => {
    const slash = (exists: boolean) => planListing(facts(listing({ releaseAfter: NOW + 10n * DAY }), cross(CrossState.NoPrint, NoPrintReason.SettlementExpired), exists), NOW).actions[0];
    expect(slash(true)).toMatchObject({ kind: 'slash-listing', createSlashAccount: false, slashTo: A(8), bondMint: A(9) });
    expect(slash(false)).toMatchObject({ kind: 'slash-listing', createSlashAccount: true });
  });

  it('leaves a listing that is still open, a cleared cross not yet finalized, and a settled listing alone', () => {
    expect(planListing(facts(listing(), cross(CrossState.Live)), NOW)).toEqual({ actions: [], skipped: [] });
    expect(planListing(facts(listing(), cross(CrossState.Cleared)), NOW)).toEqual({ actions: [], skipped: [] });
    expect(planListing(facts(listing({ settled: true }), cross(CrossState.NoPrint, NoPrintReason.SettlementExpired)), NOW)).toEqual({ actions: [], skipped: [] });
  });
});

describe('planBounty', () => {
  const bounty = (o: Record<string, unknown> = {}) => ({ expiresAt: NOW + DAY, rewards: Array.from({ length: 11 }, (_, i) => (i === 3 ? 0n : 10n)), paidMask: 0, rewardMint: A(20), tokenProgram: A(21), ...o }) as never;
  const honest = { state: CrossState.Finalized, ordersOpen: 0, ordersTotal: 4, clearing: some({ price: 1_300_000n, matched: 1_000n, demand: 1_200n, supply: 1_000n }), noPrintReason: none(), minPrice: 1_000_000n, tick: 100_000n, ticks: 20, protocolFeeBps: 30, integratorFeeBps: 0, supplyMode: 0, baseSold: 0n, baseBought: 0n, sellerPaid: 0n, buyerPaid: 0n, priceScale: 1_000_000n };
  const broken = { ...honest, ordersOpen: 9 }; // more open than ever placed (0), and a finalized cross with orders open (3, which this bounty does not pay)
  const facts = (crosses: { address: Address; data: unknown }[], o: Record<string, unknown> = {}, pool = 100n) => ({ address: A(30), bounty: bounty(o), pool, crosses: crosses as never });

  it('plans nothing across honest crosses, which break no invariant', () => {
    expect(planBounty(facts([{ address: A(1), data: honest }, { address: A(2), data: honest }]), NOW)).toEqual({ actions: [], skipped: [] });
  });

  it('claims each unpaid invariant it covers once, for the first cross that breaks it, and skips what it does not pay', () => {
    const p = planBounty(facts([{ address: A(1), data: broken }, { address: A(2), data: broken }]), NOW);
    expect(p.actions).toEqual([{ kind: 'claim-invariant', cross: A(1), bounty: A(30), invariant: 0, rewardMint: A(20), tokenProgram: A(21) }]);
  });

  it('does not claim an invariant that has paid, an expired bounty or an empty pool', () => {
    expect(planBounty(facts([{ address: A(1), data: broken }], { paidMask: 1 }), NOW).actions).toEqual([]);
    expect(planBounty(facts([{ address: A(1), data: broken }], { expiresAt: NOW }), NOW)).toEqual({ actions: [], skipped: [] });
    const empty = planBounty(facts([{ address: A(1), data: broken }], {}, 0n), NOW);
    expect(empty.actions).toEqual([]);
    expect(empty.skipped[0]).toMatchObject({ code: 'BOUNTY_EMPTY' });
  });
});

describe('planBacking', () => {
  const policy = { minCoverageBps: 10_000, maxAgeSecs: 3_600n } as never;
  const facts = (att: { backingAtoms: bigint; postedTs: bigint } | null, o: Partial<{ supply: bigint | null; halted: boolean }> = {}) => ({ mint: A(1), policy, attestation: att, supply: o.supply === undefined ? 1_000n : o.supply, halted: o.halted ?? false });

  it('halts exactly when the program would: missing, one second stale, one atom short; and leaves a backed asset alone', () => {
    expect(planBacking(facts(null), NOW).actions).toEqual([{ kind: 'check-backing', mint: A(1), verdict: 'Missing' }]);
    expect(planBacking(facts({ backingAtoms: 1_000n, postedTs: NOW - 3_600n }), NOW).actions).toEqual([]);
    expect(planBacking(facts({ backingAtoms: 1_000n, postedTs: NOW - 3_601n }), NOW).actions).toEqual([{ kind: 'check-backing', mint: A(1), verdict: 'Stale' }]);
    expect(planBacking(facts({ backingAtoms: 999n, postedTs: NOW }), NOW).actions).toEqual([{ kind: 'check-backing', mint: A(1), verdict: 'Short' }]);
    expect(planBacking(facts({ backingAtoms: 1_000n, postedTs: NOW }), NOW)).toEqual({ actions: [], skipped: [] });
  });

  it('does not call check on an asset that is halted already, and says so; nor when the supply cannot be read', () => {
    const halted = planBacking(facts(null, { halted: true }), NOW);
    expect(halted.actions).toEqual([]);
    expect(halted.skipped[0]).toMatchObject({ code: 'BACKING_HALTED' });
    expect(halted.skipped[0]!.reason).toMatch(/missing.*resume cross/);
    const unreadable = planBacking(facts(null, { supply: null }), NOW);
    expect(unreadable.actions).toEqual([]);
    expect(unreadable.skipped[0]).toMatchObject({ code: 'BACKING_UNREADABLE' });
  });
});
