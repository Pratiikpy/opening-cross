// The pure arithmetic and the pre-flight checks of the builders for the seven Wave 3D programs, compared with independent references (a 128-bit recomputation, a written-out
// table), and the instructions the builders produce. The programs themselves run in tests/core against the real binaries.
import { describe, expect, it } from 'vitest';
import { type Address, createNoopSigner, generateKeyPairSigner, none, some } from '@solana/kit';
import {
  AllowKind,
  BACKING_MAX_AGE_SECS,
  BASKET_SHARE_UNIT,
  BOUNTY_INVARIANTS,
  CONVICTION_MAX_LOCK_SECS,
  CONVICTION_MIN_LOCK_SECS,
  CrossState,
  Disclosure,
  GRADUATE_VENUES,
  LISTING_MIN_RELEASE_DELAY_SECS,
  MANDATE_MAX_ALLOW,
  MANDATE_MAX_SHARE_BPS,
  MANDATE_MIN_SIGNER_LAMPORTS,
  NoPrintReason,
  ProgramRefusal,
  SupplyMode,
  backingRequired,
  backingVerdict,
  basketCovers,
  basketOwed,
  brokenInvariants,
  buildCreateBasket,
  buildCreateBounty,
  buildCreateMandate,
  buildInitCharter,
  buildLockTokens,
  buildCreateVenue,
  checkBackingPolicy,
  checkBasketTerms,
  checkBountyClaim,
  checkBountyTerms,
  checkCharterTerms,
  checkConvictionLock,
  checkListing,
  checkMandateLimits,
  checkMandateOrder,
  checkVenueTerms,
  checkVote,
  convictionTokenDays,
  crossViolates,
  decideRound,
  mandateShareBound,
  mandateSupplyReference,
  maxBaseForEscrow,
  onGrid,
  listingVerdict,
  roundShortfall,
  venueNumber,
} from '../src/index.js';

const key = async () => (await generateKeyPairSigner()).address;
const NOW = 1_800_000_000n;
const DAY = 86_400n;

describe('mandates', () => {
  const limits = (patch: Partial<Parameters<typeof checkMandateLimits>[0]> = {}) => ({ maxPerOrder: 100n, totalCap: 1_000n, maxShareBps: 2_500, expiresAt: NOW + 1n, allow: [{ kind: AllowKind.Creator, key: '11111111111111111111111111111112' as Address }], ...patch });

  it('accepts the edges and refuses one step beyond each', () => {
    expect(checkMandateLimits(limits(), NOW)).toEqual([]);
    expect(checkMandateLimits(limits({ totalCap: 100n }), NOW)).toEqual([]);
    expect(checkMandateLimits(limits({ totalCap: 99n }), NOW).map((i) => i.field)).toEqual(['totalCap']);
    expect(checkMandateLimits(limits({ maxPerOrder: 0n }), NOW).map((i) => i.field)).toContain('maxPerOrder');
    expect(checkMandateLimits(limits({ maxShareBps: MANDATE_MAX_SHARE_BPS }), NOW)).toEqual([]);
    expect(checkMandateLimits(limits({ maxShareBps: MANDATE_MAX_SHARE_BPS + 1 }), NOW).map((i) => i.field)).toEqual(['maxShareBps']);
    expect(checkMandateLimits(limits({ maxShareBps: 0 }), NOW).map((i) => i.field)).toEqual(['maxShareBps']);
    expect(checkMandateLimits(limits({ expiresAt: NOW }), NOW).map((i) => i.field)).toEqual(['expiresAt']);
    expect(checkMandateLimits(limits({ allow: [] }), NOW).map((i) => i.field)).toEqual(['allow']);
    const nine = Array.from({ length: MANDATE_MAX_ALLOW + 1 }, () => ({ kind: AllowKind.Cross, key: '11111111111111111111111111111112' as Address }));
    expect(checkMandateLimits(limits({ allow: nine }), NOW).map((i) => i.field)).toEqual(['allow']);
    expect(checkMandateLimits(limits({ allow: nine.slice(0, MANDATE_MAX_ALLOW) }), NOW)).toEqual([]);
    // every issue carries the program's own error name
    expect(new Set(checkMandateLimits(limits({ maxPerOrder: 0n, allow: [] }), NOW).map((i) => i.code))).toEqual(new Set(['BadLimits']));
  });

  it('bounds the base an order can buy exactly as the program does: its quantity when open, the escrow at the lowest price when sealed', () => {
    expect(maxBaseForEscrow(1_300_000n, 1_000_000n, 1_000_000n)).toBe(1_300_000n);
    expect(maxBaseForEscrow(10n, 1_000_000n, 3n)).toBe(3_333_333n); // floor
    expect(maxBaseForEscrow(10n, 1n, 0n)).toBeNull();
    const cross = (disclosure: Disclosure) => ({ address: '11111111111111111111111111111112' as Address, data: { disclosure, priceScale: 1_000_000n, minPrice: 500_000n } as never });
    expect(mandateShareBound(cross(Disclosure.Open), 5n, 77n)).toBe(77n);
    expect(mandateShareBound(cross(Disclosure.Sealed), 5n, 77n)).toBe(10n);
  });

  it('takes the supply reference from the hard cap when there is one, else the declared supply, else nothing', () => {
    const view = (guards?: { maxMatched: bigint; totalSupply: bigint }) => ({ address: '11111111111111111111111111111112' as Address, data: {} as never, ...(guards ? { ext: { guards } as never } : {}) });
    expect(mandateSupplyReference(view())).toBe(0n);
    expect(mandateSupplyReference(view({ maxMatched: 0n, totalSupply: 900n }))).toBe(900n);
    expect(mandateSupplyReference(view({ maxMatched: 400n, totalSupply: 900n }))).toBe(400n);
  });

  it('checks an order in the program\'s order and names every refusal', async () => {
    const [creator, base, quote, other] = await Promise.all([key(), key(), key(), key()]);
    const mandate = { revoked: false, expiresAt: NOW + 100n, maxPerOrder: 1_000n, totalCap: 5_000n, committed: 0n, maxShareBps: 2_500, quoteMint: quote, quoteTokenProgram: other, allow: [{ kind: AllowKind.Creator, key: creator }] };
    const crossView = (o: { supply?: bigint } = {}) => ({
      address: other,
      data: { disclosure: Disclosure.Open, priceScale: 1_000_000n, minPrice: 1_000_000n, quoteMint: quote, quoteTokenProgram: other, creator, baseBound: true, baseMint: base } as never,
      ext: { guards: { maxMatched: 0n, totalSupply: o.supply ?? 10_000n } } as never,
    });
    const facts = (patch: Partial<Parameters<typeof checkMandateOrder>[0]> = {}) => ({ mandate, cross: crossView(), escrow: 500n, quantity: 500n, now: NOW, ...patch });
    expect(checkMandateOrder(facts())).toEqual([]);
    const codes = (p: Partial<Parameters<typeof checkMandateOrder>[0]>) => checkMandateOrder(facts(p)).map((i) => i.code);
    expect(codes({ mandate: { ...mandate, revoked: true } })).toEqual(['Revoked']);
    expect(codes({ now: NOW + 100n })).toEqual(['Expired']);
    expect(codes({ escrow: 1_001n })).toContain('OverPerOrderLimit');
    expect(codes({ mandate: { ...mandate, committed: 4_501n } })).toEqual(['OverTotalCap']);
    expect(codes({ mandate: { ...mandate, committed: 4_500n } })).toEqual([]);
    expect(codes({ vaultBalance: 499n })).toEqual(['VaultTooLow']);
    expect(codes({ mandate: { ...mandate, allow: [{ kind: AllowKind.Creator, key: other }] } })).toEqual(['NotAllowed']);
    expect(codes({ mandate: { ...mandate, allow: [{ kind: AllowKind.BaseMint, key: base }] } })).toEqual([]);
    expect(codes({ cross: crossView({ supply: 0n }) })).toEqual(['NoSupplyReference']);
    // 25% of a 10,000 supply is 2,500
    expect(codes({ escrow: 1_000n, quantity: 2_500n })).toEqual([]);
    expect(codes({ escrow: 1_000n, quantity: 2_501n })).toEqual(['OverShareLimit']);
    expect(codes({ signerLamports: MANDATE_MIN_SIGNER_LAMPORTS - 1n })).toEqual(['NeedRentFunding']);
    expect(codes({ signerLamports: MANDATE_MIN_SIGNER_LAMPORTS })).toEqual([]);
    // several at once, all named
    expect(codes({ mandate: { ...mandate, revoked: true, committed: 5_000n }, escrow: 1_001n })).toEqual(['Revoked', 'OverPerOrderLimit', 'OverTotalCap']);
  });

  it('refuses a mandate whose agent is its owner, with the program\'s name, before any transaction exists', async () => {
    const [owner, quote, token] = await Promise.all([key(), key(), key()]);
    const input = { owner: createNoopSigner(owner), agent: owner, id: 0n, quoteMint: quote, quoteTokenProgram: token, limits: { maxPerOrder: 1n, totalCap: 1n, maxShareBps: 1, expiresAt: NOW + 10n, allow: [{ kind: AllowKind.Cross, key: quote }] }, now: NOW };
    await expect(buildCreateMandate(input)).rejects.toBeInstanceOf(ProgramRefusal);
    await expect(buildCreateMandate(input)).rejects.toMatchObject({ issues: [{ code: 'AgentIsOwner' }] });
    const ok = await buildCreateMandate({ ...input, agent: quote });
    expect(ok.instruction.accounts?.map((a) => a.address)).toEqual(expect.arrayContaining([owner, quote, ok.mandate, ok.signer, ok.vault]));
  });
});

describe('conviction', () => {
  // the program: floor(amount x seconds / (86,400 x 10^decimals)), checked in 128 bits
  const reference = (amount: bigint, secs: bigint, decimals: number) => (amount * secs) / (86_400n * 10n ** BigInt(decimals));

  it('counts whole token-days, rounded down, equal to a 128-bit reference over a grid', () => {
    for (const decimals of [0, 6, 9]) for (const amount of [1n, 999_999n, 1_000_000n, 123_456_789_012n]) for (const days of [1n, 7n, 30n, 365n, 1_460n]) {
      const secs = days * DAY;
      expect(convictionTokenDays(amount, secs, decimals), `${amount} ${days}d ${decimals}dp`).toBe(reference(amount, secs, decimals));
    }
    expect(convictionTokenDays(100_000_000n, 30n * DAY, 6)).toBe(3_000n);
    expect(convictionTokenDays(1n, DAY, 6)).toBe(0n); // too small for a badge
    expect(convictionTokenDays(1n, 0n, 6)).toBe(0n);
  });

  it('never wraps: a lock whose token-days exceed a 64-bit number is null, not a small number', () => {
    expect(convictionTokenDays(1n << 40n, CONVICTION_MAX_LOCK_SECS, 0)).toBe(((1n << 40n) * CONVICTION_MAX_LOCK_SECS) / DAY);
    expect(convictionTokenDays((1n << 64n) - 1n, CONVICTION_MAX_LOCK_SECS, 0)).toBeNull();
    expect(convictionTokenDays((1n << 64n) - 1n, (1n << 62n), 0)).toBeNull();
  });

  it('accepts a lock from a day to four years and nothing outside', () => {
    expect(checkConvictionLock(1n, NOW + CONVICTION_MIN_LOCK_SECS, NOW)).toEqual([]);
    expect(checkConvictionLock(1n, NOW + CONVICTION_MIN_LOCK_SECS - 1n, NOW).map((i) => i.code)).toEqual(['BadUnlockTime']);
    expect(checkConvictionLock(1n, NOW + CONVICTION_MAX_LOCK_SECS, NOW)).toEqual([]);
    expect(checkConvictionLock(1n, NOW + CONVICTION_MAX_LOCK_SECS + 1n, NOW).map((i) => i.code)).toEqual(['BadUnlockTime']);
    expect(checkConvictionLock(0n, NOW + CONVICTION_MIN_LOCK_SECS, NOW).map((i) => i.code)).toEqual(['NothingToLock']);
  });

  it('builds lock_tokens only for a lock the program accepts', async () => {
    const [holder, mint, program] = await Promise.all([key(), key(), key()]);
    await expect(buildLockTokens({ holder: createNoopSigner(holder), mint, tokenProgram: program, nonce: 0n, amount: 1n, unlockTs: NOW, now: NOW })).rejects.toBeInstanceOf(ProgramRefusal);
    const ok = await buildLockTokens({ holder: createNoopSigner(holder), mint, tokenProgram: program, nonce: 3n, amount: 5n, unlockTs: NOW + 2n * DAY, now: NOW });
    expect(ok.instruction.accounts?.map((a) => a.address)).toEqual(expect.arrayContaining([holder, mint, ok.lock, ok.vault]));
  });
});

describe('baskets', () => {
  it('rounds a deposit up and a redemption down, and a round trip never returns more than was paid', () => {
    for (const units of [1n, 7n, 750_000n, 2_000_000n, 999_999_999n]) for (const shares of [1n, 999_999n, 1_000_000n, 1_500_000n, 123_456_789n]) {
      const paid = basketOwed(units, shares, true);
      const back = basketOwed(units, shares, false);
      expect(paid).toBe((units * shares + BASKET_SHARE_UNIT - 1n) / BASKET_SHARE_UNIT);
      expect(back).toBe((units * shares) / BASKET_SHARE_UNIT);
      expect(back).toBeLessThanOrEqual(paid);
      expect(paid - back).toBeLessThanOrEqual(1n);
    }
    expect(basketOwed(7n, 1_500_000n, true)).toBe(11n);
    expect(basketOwed(7n, 1_500_000n, false)).toBe(10n);
  });

  it('covers a supply exactly at the boundary', () => {
    expect(basketCovers(21n, 7n, 3_000_000n)).toBe(true);
    expect(basketCovers(20n, 7n, 3_000_000n)).toBe(false);
    expect(basketCovers(0n, 7n, 0n)).toBe(true);
  });

  it('refuses the terms the program refuses', () => {
    const c = (mint: string, units = 1n) => ({ mint: mint as Address, tokenProgram: '11111111111111111111111111111112' as Address, unitsPerShare: units });
    const A = '11111111111111111111111111111113';
    const B = '11111111111111111111111111111114';
    expect(checkBasketTerms('x', [c(A), c(B)])).toEqual([]);
    expect(checkBasketTerms('x', []).map((i) => i.code)).toEqual(['BadBasket']);
    expect(checkBasketTerms('x', [c(A), c(A)]).map((i) => i.code)).toEqual(['DuplicateComponent']);
    expect(checkBasketTerms('x', [c(A, 0n)]).map((i) => i.code)).toEqual(['BadBasket']);
    expect(checkBasketTerms('x'.repeat(33), [c(A)]).map((i) => i.code)).toEqual(['BadBasket']);
    expect(checkBasketTerms('é'.repeat(16), [c(A)])).toEqual([]); // 32 bytes
    expect(checkBasketTerms('é'.repeat(17), [c(A)]).map((i) => i.code)).toEqual(['BadBasket']); // 34 bytes
  });

  it('builds the vault accounts before create_basket, one per component', async () => {
    const [creator, a, b, program] = await Promise.all([key(), key(), key(), key()]);
    const built = await buildCreateBasket({ creator: createNoopSigner(creator), id: 0n, label: 'x', components: [{ mint: a, tokenProgram: program, unitsPerShare: 1n }, { mint: b, tokenProgram: program, unitsPerShare: 2n }] });
    expect(built.instructions).toHaveLength(3);
    expect(built.vaults).toHaveLength(2);
  });
});

describe('listing', () => {
  const lister = '11111111111111111111111111111115' as Address;
  const cross = (state: CrossState, noPrintReason: number | null) => ({ state, noPrintReason: noPrintReason === null ? none() : some(noPrintReason) }) as never;
  const listing = (releaseAfter: bigint, settled = false) => ({ releaseAfter, settled });

  it('decides release, slash or wait from the cross\'s state, the reason and the delay, as the program does', () => {
    const v = (state: CrossState, reason: number | null, o: { at?: bigint; after?: bigint; settled?: boolean } = {}) => listingVerdict({ listing: listing(o.after ?? 100n, o.settled), cross: cross(state, reason), now: o.at ?? 100n });
    expect(v(CrossState.Finalized, null)).toBe('release');
    expect(v(CrossState.Finalized, null, { at: 99n })).toBe('wait');
    expect(v(CrossState.NoPrint, NoPrintReason.NoCross)).toBe('release');
    expect(v(CrossState.NoPrint, NoPrintReason.SettlementExpired)).toBe('slash');
    expect(v(CrossState.NoPrint, NoPrintReason.SettlementExpired, { at: 1n })).toBe('slash'); // a slash has no delay
    expect(v(CrossState.Live, null)).toBe('wait');
    expect(v(CrossState.Cleared, null)).toBe('wait');
    expect(v(CrossState.Cleared, NoPrintReason.SettlementExpired)).toBe('wait'); // only a no-print is a fault
    expect(v(CrossState.Finalized, null, { settled: true })).toBe('settled');
    expect(v(CrossState.NoPrint, NoPrintReason.SettlementExpired, { settled: true })).toBe('settled');
  });

  it('checks the terms of a venue and of a listing', () => {
    expect(checkVenueTerms(1n, LISTING_MIN_RELEASE_DELAY_SECS)).toEqual([]);
    expect(checkVenueTerms(0n, LISTING_MIN_RELEASE_DELAY_SECS).map((i) => i.field)).toEqual(['minBond']);
    expect(checkVenueTerms(1n, LISTING_MIN_RELEASE_DELAY_SECS - 1n).map((i) => i.field)).toEqual(['releaseDelaySecs']);
    const facts = (o: { creator?: Address; state?: CrossState; amount?: bigint; encumbered?: bigint } = {}) => ({ lister, cross: { data: { creator: o.creator ?? lister, state: o.state ?? CrossState.Live } }, venue: { minBond: 100n }, bond: { amount: o.amount ?? 250n, encumbered: o.encumbered ?? 0n } });
    expect(checkListing(facts())).toEqual([]);
    expect(checkListing(facts({ creator: '11111111111111111111111111111116' as Address })).map((i) => i.code)).toEqual(['NotTheCreator']);
    expect(checkListing(facts({ state: CrossState.Cleared })).map((i) => i.code)).toEqual(['CrossNotLive']);
    expect(checkListing(facts({ encumbered: 150n }))).toEqual([]);
    expect(checkListing(facts({ encumbered: 151n })).map((i) => i.code)).toEqual(['BondTooSmall']);
  });

  it('refuses a venue with no bond before building it', async () => {
    const [creator, mint, program] = await Promise.all([key(), key(), key()]);
    await expect(buildCreateVenue({ creator: createNoopSigner(creator), id: 0n, bondMint: mint, bondTokenProgram: program, minBond: 0n, releaseDelaySecs: LISTING_MIN_RELEASE_DELAY_SECS, slashTo: creator })).rejects.toBeInstanceOf(ProgramRefusal);
  });
});

describe('bounty', () => {
  // a cross account the way cross_core leaves it after an honest clear, then broken one invariant at a time
  const honest = () => ({
    state: CrossState.Finalized,
    ordersOpen: 0,
    ordersTotal: 4,
    clearing: some({ price: 1_300_000n, matched: 1_000n, demand: 1_200n, supply: 1_000n, rationed: 0, marginalQuantity: 0n, marginalRemaining: 0n, marginalOrders: 0 }),
    noPrintReason: none(),
    minPrice: 1_000_000n,
    tick: 100_000n,
    ticks: 20,
    protocolFeeBps: 30,
    integratorFeeBps: 20,
    supplyMode: SupplyMode.Escrow,
    baseSold: 1_000n,
    baseBought: 1_000n,
    sellerPaid: 1_299n,
    buyerPaid: 1_300n,
    priceScale: 1_000_000n,
  });

  it('fires on none of the honest shapes, and each invariant on exactly the shape it names', () => {
    expect(brokenInvariants(honest() as never)).toEqual([]);
    const only = (patch: Record<string, unknown>) => brokenInvariants({ ...honest(), ...patch } as never);
    expect(only({ ordersOpen: 5 })).toEqual([0, 3]); // more open than ever placed; and a finalized cross with orders open
    expect(only({ state: CrossState.Cleared, clearing: none() })).toEqual([1]);
    expect(only({ state: CrossState.NoPrint, clearing: none() })).toEqual([2]);
    expect(only({ state: CrossState.NoPrint, clearing: none(), noPrintReason: some(NoPrintReason.NoCross) })).toEqual([]);
    expect(only({ state: CrossState.Finalized, ordersOpen: 1 })).toEqual([3]);
    expect(only({ state: CrossState.Cleared, clearing: some({ price: 1_350_000n, matched: 1_000n, demand: 1_200n, supply: 1_000n }) })).toEqual([4]);
    expect(only({ protocolFeeBps: 101 })).toEqual([5]);
    expect(only({ integratorFeeBps: 301 })).toEqual([5]);
    expect(only({ clearing: some({ price: 1_300_000n, matched: 1_001n, demand: 1_200n, supply: 1_000n }) })).toEqual([6]);
    expect(only({ sellerPaid: 1_301n })).toEqual([7]);
    expect(only({ state: CrossState.Live, clearing: honest().clearing })).toEqual([8]);
    expect(only({ baseBought: 1_001n, baseSold: 1_000n })).toEqual([9, 10]);
  });

  it('allows the dust the rounding leaves and no more (invariant 7)', () => {
    // sold 1,000 and delivered 990: 10 undelivered at 1.3 is 13 of quote the sellers were not paid for
    const c = (sellerPaid: bigint) => ({ ...honest(), baseBought: 990n, sellerPaid, buyerPaid: 1_287n });
    expect(crossViolates(7, c(1_287n + 13n) as never)).toBe(false);
    expect(crossViolates(7, c(1_287n + 14n) as never)).toBe(true);
  });

  it('is exact on the grid', () => {
    expect(onGrid(1_000_000n, 1_000_000n, 100_000n, 20)).toBe(true);
    expect(onGrid(2_900_000n, 1_000_000n, 100_000n, 20)).toBe(true);
    expect(onGrid(3_000_000n, 1_000_000n, 100_000n, 20)).toBe(false);
    expect(onGrid(1_050_000n, 1_000_000n, 100_000n, 20)).toBe(false);
    expect(onGrid(999_999n, 1_000_000n, 100_000n, 20)).toBe(false);
    expect(onGrid(1n, 0n, 0n, 20)).toBe(false);
  });

  it('checks the terms and the claim in the program\'s order', () => {
    const rewards = Array.from({ length: BOUNTY_INVARIANTS }, (_, i) => BigInt(i));
    expect(checkBountyTerms(rewards, NOW + 30n * DAY, NOW)).toEqual([]);
    expect(checkBountyTerms(rewards, NOW + 30n * DAY - 1n, NOW).map((i) => i.code)).toEqual(['CommitmentTooShort']);
    expect(checkBountyTerms(rewards.slice(1), NOW + 30n * DAY, NOW).map((i) => i.code)).toEqual(['BadRewards']);
    const bounty = { expiresAt: NOW + 10n, rewards, paidMask: 0b100 };
    expect(checkBountyClaim(bounty, 1, NOW)).toEqual([]);
    expect(checkBountyClaim(bounty, 0, NOW).map((i) => i.code)).toEqual(['NotCovered']);
    expect(checkBountyClaim(bounty, 2, NOW).map((i) => i.code)).toEqual(['AlreadyPaid']);
    expect(checkBountyClaim(bounty, 11, NOW).map((i) => i.code)).toEqual(['UnknownInvariant']);
    expect(checkBountyClaim(bounty, 1, NOW + 10n).map((i) => i.code)).toEqual(['Expired']);
  });

  it('builds create_bounty only for terms the program accepts', async () => {
    const [sponsor, mint, program] = await Promise.all([key(), key(), key()]);
    await expect(buildCreateBounty({ sponsor: createNoopSigner(sponsor), id: 0n, rewardMint: mint, tokenProgram: program, arbiter: sponsor, expiresAt: NOW, rewards: Array.from({ length: 11 }, () => 1n), now: NOW })).rejects.toBeInstanceOf(ProgramRefusal);
  });
});

describe('backing', () => {
  const att = (backingAtoms: bigint, postedTs: bigint) => ({ backingAtoms, postedTs });
  const v = (a: ReturnType<typeof att> | null, o: { supply?: bigint; now?: bigint; bps?: number; age?: bigint } = {}) => backingVerdict({ attestation: a, supply: o.supply ?? 1_000n, now: o.now ?? NOW, minCoverageBps: o.bps ?? 10_000, maxAgeSecs: o.age ?? 3_600n });

  it('is Missing without a statement, Stale one second past the age or dated in the future, Short one atom under, Backed otherwise', () => {
    expect(v(null)).toBe('Missing');
    expect(v(att(1_000n, NOW - 3_600n))).toBe('Backed');
    expect(v(att(1_000n, NOW - 3_601n))).toBe('Stale');
    expect(v(att(1_000n, NOW + 1n))).toBe('Stale');
    expect(v(att(1_000n, NOW))).toBe('Backed');
    expect(v(att(999n, NOW))).toBe('Short');
    // age is judged before coverage: an old and short statement is Stale
    expect(v(att(1n, NOW - 4_000n))).toBe('Stale');
  });

  it('measures coverage in 128 bits at the committed ratio, over and under 100%', () => {
    expect(v(att(1_500n, NOW), { bps: 15_000 })).toBe('Backed');
    expect(v(att(1_499n, NOW), { bps: 15_000 })).toBe('Short');
    expect(v(att(5n, NOW), { bps: 100, supply: 500n })).toBe('Backed'); // 1% of 500
    expect(v(att(4n, NOW), { bps: 100, supply: 500n })).toBe('Short');
    const big = (1n << 64n) - 1n;
    expect(v(att(big, NOW), { supply: big, bps: 20_000 })).toBe('Short');
    expect(v(att(big, NOW), { supply: big })).toBe('Backed');
  });

  it('states the backing an attester must post at least', () => {
    for (const [supply, bps] of [[1_000n, 10_000], [1_001n, 15_000], [7n, 100], [0n, 100]] as [bigint, number][]) {
      const need = backingRequired(supply, bps);
      expect(v(att(need, NOW), { supply, bps })).toBe('Backed');
      if (need > 0n) expect(v(att(need - 1n, NOW), { supply, bps })).toBe('Short');
    }
  });

  it('accepts the policy edges and refuses beyond them', () => {
    expect(checkBackingPolicy(100, 60n)).toEqual([]);
    expect(checkBackingPolicy(20_000, BACKING_MAX_AGE_SECS)).toEqual([]);
    expect(checkBackingPolicy(99, 60n).map((i) => i.field)).toEqual(['minCoverageBps']);
    expect(checkBackingPolicy(20_001, 60n).map((i) => i.field)).toEqual(['minCoverageBps']);
    expect(checkBackingPolicy(100, 59n).map((i) => i.field)).toEqual(['maxAgeSecs']);
    expect(checkBackingPolicy(100, BACKING_MAX_AGE_SECS + 1n).map((i) => i.field)).toEqual(['maxAgeSecs']);
    expect(checkBackingPolicy(1.5, 60n).map((i) => i.field)).toEqual(['minCoverageBps']);
  });
});

describe('graduation', () => {
  // the program's decide(), written differently: the best tally by sort, ties to the lowest venue
  const reference = (f: { lockedTotal: bigint; supply: bigint; quorumBps: number; tallies: bigint[]; minVolume: bigint; volume: bigint | null }): number | null => {
    if (f.lockedTotal === 0n) return null;
    if (f.lockedTotal * 10_000n < f.supply * BigInt(f.quorumBps)) return null;
    const ranked = f.tallies.map((t, i) => ({ t, i })).sort((a, b) => (a.t === b.t ? a.i - b.i : a.t > b.t ? -1 : 1));
    const top = ranked[0]!;
    if (top.t * 2n <= f.lockedTotal) return null;
    if (f.minVolume > 0n && (f.volume === null || f.volume < f.minVolume)) return null;
    return top.i;
  };

  it('agrees with the reference over every small tally, quorum and volume, and the verdict and the shortfall never disagree', () => {
    let passes = 0;
    for (let a = 0n; a <= 6n; a++) for (let b = 0n; b <= 6n; b++) for (let c = 0n; c <= 4n; c++) for (const supply of [10n, 15n]) for (const quorumBps of [1_000, 4_000, 10_000]) for (const [minVolume, volume] of [[0n, null], [5n, null], [5n, 4n], [5n, 5n]] as [bigint, bigint | null][]) {
      const f = { lockedTotal: a + b + c, supply, quorumBps, tallies: [a, b, c, 0n], minVolume, volume };
      const got = decideRound(f);
      expect(got, JSON.stringify(f, (_k, x) => (typeof x === 'bigint' ? Number(x) : x))).toBe(reference(f));
      expect(roundShortfall(f) === null).toBe(got !== null);
      if (got !== null) passes++;
    }
    expect(passes).toBeGreaterThan(100);
  });

  it('needs a strict majority of what was locked and the quorum of the live supply, at the exact edge', () => {
    const f = (tallies: bigint[], supply = 1_000n, quorumBps = 4_000) => decideRound({ lockedTotal: tallies.reduce((x, y) => x + y, 0n), supply, quorumBps, tallies, minVolume: 0n, volume: null });
    expect(f([201n, 199n])).toBe(0); // 400 locked is the 40% quorum of 1,000
    expect(f([200n, 200n])).toBeNull(); // a tie has no winner
    expect(f([0n, 201n, 199n])).toBe(1);
    expect(f([199n, 200n])).toBeNull(); // 399 is under the quorum
    expect(f([0n, 0n, 401n])).toBe(2);
    expect(f([0n, 0n, 0n, 401n])).toBe(3);
    expect(f([401n], 1_003n)).toBeNull(); // the supply grew: 40% of it is now above 401, so the quorum moved with it
    expect(f([401n], 1_002n)).toBe(0);
  });

  it('names the venues in the order cross_settle numbers them', () => {
    expect(GRADUATE_VENUES).toEqual(['damm_v2', 'dlmm', 'raydium_cpmm', 'metadao_futarchy']);
    expect(venueNumber('raydium_cpmm')).toBe(2);
    expect(venueNumber('orca')).toBeNull();
  });

  it('checks a charter and a vote against the program\'s limits', () => {
    expect(checkCharterTerms({ quorumBps: 1_000, windowSecs: 3n * DAY, minVolume: 0n, volumeAttester: null })).toEqual([]);
    expect(checkCharterTerms({ quorumBps: 10_000, windowSecs: 30n * DAY, minVolume: 1n, volumeAttester: '11111111111111111111111111111115' as Address })).toEqual([]);
    for (const t of [{ quorumBps: 999 }, { quorumBps: 10_001 }, { windowSecs: 3n * DAY - 1n }, { windowSecs: 30n * DAY + 1n }, { minVolume: 1n }]) {
      expect(checkCharterTerms({ quorumBps: 4_000, windowSecs: 7n * DAY, minVolume: 0n, volumeAttester: null, ...t }).map((i) => i.code), JSON.stringify(t, (_k, x) => (typeof x === 'bigint' ? Number(x) : x))).toEqual(['BadCharter']);
    }
    const round = { finalized: false, opensTs: 10n, closesTs: 20n };
    expect(checkVote({ round, venue: 1, amount: 1n, now: 10n })).toEqual([]);
    expect(checkVote({ round, venue: 1, amount: 1n, now: 20n }).map((i) => i.code)).toEqual(['NotVoting']);
    expect(checkVote({ round, venue: 1, amount: 1n, now: 9n }).map((i) => i.code)).toEqual(['NotVoting']);
    expect(checkVote({ round: { ...round, finalized: true }, venue: 1, amount: 1n, now: 15n }).map((i) => i.code)).toEqual(['NotVoting']);
    expect(checkVote({ round, venue: 4, amount: 1n, now: 15n }).map((i) => i.code)).toEqual(['UnknownVenue']);
    expect(checkVote({ round, venue: 1, amount: 0n, now: 15n }).map((i) => i.code)).toEqual(['NothingToDo']);
    expect(checkVote({ round, venue: 1, amount: 1n, now: 15n, existingVenue: 2 }).map((i) => i.code)).toEqual(['VenueLocked']);
    expect(checkVote({ round, venue: 2, amount: 1n, now: 15n, existingVenue: 2 })).toEqual([]);
  });

  it('refuses to build a charter with a volume gate and nobody to attest it', async () => {
    const [creator, cross] = await Promise.all([key(), key()]);
    await expect(buildInitCharter({ creator: createNoopSigner(creator), cross, quorumBps: 4_000, windowSecs: 7n * DAY, minVolume: 5n, volumeAttester: null })).rejects.toBeInstanceOf(ProgramRefusal);
    const ok = await buildInitCharter({ creator: createNoopSigner(creator), cross, quorumBps: 4_000, windowSecs: 7n * DAY, minVolume: 0n, volumeAttester: null });
    expect(ok.instruction.accounts?.map((a) => a.address)).toEqual(expect.arrayContaining([creator, cross, ok.charter]));
  });
});
