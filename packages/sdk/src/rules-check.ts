// Every check `set_rules` makes (programs/cross_core/src/rules.rs), run before a transaction is built, so an issuer reads the reason
// before signing instead of a program error after. A refused `create_cross` plus `set_rules` costs the fee payer a transaction
// fee and nothing else (the pair is atomic), but a reason in words is worth more than `InvalidParams`.
//
// This mirrors the program; it does not replace it. The program is the authority: a rule set that passes here can still be refused
// (for a halt state that does not exist, a feed publisher list the creator is not on, a calendar that does not approve a feed),
// because those depend on chain state this function does not read.
import { type Address, type ReadonlyUint8Array, address } from '@solana/kit';
import { type RulesConfig, SupplyMode, MAX_BUCKETS, MAX_INSIDERS, MAX_REFERRAL_BPS, completeRules, FLAG_FEEDS_LENDERS, FLAG_GOVERNED_GRADUATION, FLAG_GUARD_SCALED_UI, FLAG_RESUMES_HALT, FLAG_STANDARD_GRID } from '@opening-cross/cross-core-client';

/** The longest lockup, vesting or cliff the program accepts: four years. */
export const MAX_LOCK_SECS = 4 * 365 * 24 * 60 * 60;
export const MIN_CHALLENGE_SECS = 3_600;
export const MAX_CHALLENGE_SECS = 30 * 24 * 3_600;
export const MAX_EXTENSION_SECS = 7 * 24 * 60 * 60;
export const MAX_MOVE_BPS = 50_000;
export const MAX_WIDEN_BPS = 5_000;
const SETTABLE_FLAGS = FLAG_RESUMES_HALT | FLAG_FEEDS_LENDERS | FLAG_STANDARD_GRID | FLAG_GUARD_SCALED_UI | FLAG_GOVERNED_GRADUATION;
const ZERO = address('11111111111111111111111111111111');

/** The parts of a cross's creation the rules are checked against. */
export type RuleContext = {
  supplyMode: SupplyMode | number;
  minPrice: bigint;
  tick: bigint;
  ticks: number;
  openTs: bigint;
  closeTs: bigint;
  referencePrice: bigint | null;
  gateMint: Address | null;
  /** Feed id (32 bytes) of the cross's own oracle guard, or null for none. */
  oracleFeedId: Uint8Array | null;
  calendar: Address | null;
};

export type RuleIssue = {
  /** Stable machine-readable code. */
  code: string;
  /** The rules field the issue is about, e.g. `ending.buckets`. */
  field: string;
  /** A sentence an issuer can act on. */
  message: string;
};

const eq32 = (a: ReadonlyUint8Array, b: ReadonlyUint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);
const isZero32 = (a: ReadonlyUint8Array) => a.every((x) => x === 0);

/** All issues with `rules` for a cross created with `ctx`; empty when the program's static checks would pass. */
export function checkRules(ctx: RuleContext, rules: RulesConfig = {}): RuleIssue[] {
  let r: ReturnType<typeof completeRules>;
  try {
    r = completeRules(rules);
  } catch (e) {
    return [{ code: 'MALFORMED', field: 'rules', message: e instanceof Error ? e.message : String(e) }];
  }
  const out: RuleIssue[] = [];
  const bad = (code: string, field: string, message: string) => out.push({ code, field, message });
  const mints = Number(ctx.supplyMode) !== SupplyMode.Escrow;
  const deferred = Number(ctx.supplyMode) === SupplyMode.DeferredMint;
  const g = r.guards;

  if ((r.flags & ~SETTABLE_FLAGS) !== 0) bad('FLAGS', 'flags', 'a flag outside the five a creator may set was given');
  if (g.maxMatched > 0n && !mints) bad('CAP_NEEDS_MINT', 'guards.maxMatched', 'a hard cap on the base delivered applies to crosses that mint their base token; an escrow cross sells what the seller escrowed');
  const haltSource = g.haltSource === null ? null : typeof g.haltSource === 'string' ? g.haltSource : g.haltSource.__option === 'Some' ? g.haltSource.value : null;
  if (((r.flags & (FLAG_RESUMES_HALT | FLAG_FEEDS_LENDERS)) !== 0 || haltSource) && deferred) bad('NOT_FOR_DEFERRED', 'flags', 'a halt state and the lender feed are keyed by the base mint, which a deferred-mint cross does not have yet');
  if ((r.flags & FLAG_RESUMES_HALT) !== 0 && !haltSource) bad('RESUME_NEEDS_HALT', 'guards.haltSource', 'a resume cross names the halt state it lifts');

  if (g.minFloatBps > 10_000) bad('FLOAT_RANGE', 'guards.minFloatBps', 'the minimum float is at most 10,000 basis points');
  if (g.maxFdvX100 !== 0 && g.maxFdvX100 < 100) bad('FDV_RANGE', 'guards.maxFdvX100', 'the maximum FDV-to-raise ratio is at least 1.00 (100), or 0 for none');
  if ((g.minFloatBps > 0 || g.maxFdvX100 > 0) && g.totalSupply === 0n && deferred) bad('SUPPLY_DECLARATION', 'guards.totalSupply', 'a deferred-mint cross has no mint to read the supply from, so a float or valuation guard needs the supply declared');

  if ((r.flags & FLAG_STANDARD_GRID) !== 0) {
    const top = BigInt(Math.max(ctx.ticks - 1, 0)) * ctx.tick + ctx.minPrice;
    if (g.gridEstimate === 0n) bad('GRID_ESTIMATE', 'guards.gridEstimate', 'the standard grid needs the published price estimate');
    else if (ctx.minPrice * 2n < g.gridEstimate || ctx.tick * 100n > g.gridEstimate || g.gridEstimate > top) {
      bad('GRID_POLICY', 'guards.gridEstimate', 'the standard grid starts no lower than half the estimate, has ticks of at most one percent of it, and contains it');
    }
  }
  if (g.moveBps > 0) {
    if (g.moveBps > MAX_MOVE_BPS) bad('MOVE_RANGE', 'guards.moveBps', `the price-move guard is at most ${MAX_MOVE_BPS} basis points`);
    const anchor = g.anchorPrice > 0n ? g.anchorPrice : (ctx.referencePrice ?? g.gridEstimate);
    if (anchor === 0n) bad('MOVE_ANCHOR', 'guards.anchorPrice', 'the price-move guard needs an anchor: an anchor price, a reopen reference price or a grid estimate');
  }

  const e = r.ending;
  if (e.endingSecs > 0) {
    const call = ctx.closeTs - ctx.openTs;
    if (!(e.buckets >= 1 && e.buckets <= MAX_BUCKETS && e.endingSecs >= e.buckets && BigInt(e.endingSecs) < call)) {
      bad('ENDING', 'ending', `the ending period is cut into 1 to ${MAX_BUCKETS} buckets of at least a second each and is shorter than the call (${call} s)`);
    }
    if (e.randomEnd && e.buckets < 2) bad('ENDING_DRAW', 'ending.randomEnd', 'a drawn ending needs at least two buckets');
  } else if (e.buckets !== 0 || e.randomEnd) bad('ENDING_OFF', 'ending', 'buckets and a drawn end are only available with an ending period');
  if (e.extensionMaxSecs > 0) {
    if (!(e.extensionMinSecs > 0 && e.extensionMinSecs <= e.extensionMaxSecs && e.extensionMaxSecs <= MAX_EXTENSION_SECS)) {
      bad('EXTENSION', 'ending.extensionMaxSecs', `an extension is between one second and ${MAX_EXTENSION_SECS / 86_400} days, and its minimum does not exceed its maximum`);
    }
  } else if (e.extensionMinSecs !== 0) bad('EXTENSION_OFF', 'ending.extensionMinSecs', 'an extension minimum needs an extension maximum');

  if ((r.identity.capQuote > 0n || r.identity.maxOrders > 0) && !ctx.gateMint) bad('IDENTITY_NEEDS_GATE', 'identity', 'per-identity limits count a wallet that holds the cross\'s gate pass, so the cross needs a gate');

  const a = r.alloc;
  const [r0 = 0, r1 = 0, r2 = 0] = a.reserveBps;
  const shares = r0 + r1 + r2;
  if (shares > 10_000) bad('RESERVE_SUM', 'alloc.reserveBps', 'the reserved shares add up to at most 10,000 basis points');
  if ((shares > 0 || a.lotteryUnit > 0n) && !mints) bad('CLASSES_NEED_MINT', 'alloc', 'allocation classes are for crosses that mint their base token: the unsold remainder is the issuer\'s');
  if (r0 > 0 && a.smallCapQuote === 0n) bad('CLASS1_CAP', 'alloc.smallCapQuote', 'a reserved share for small verified buyers needs the small-order cap');
  if (a.smallCapQuote > 0n && !ctx.gateMint) bad('CLASS1_GATE', 'alloc.smallCapQuote', 'the small-order cap applies to wallets that hold the gate pass, so the cross needs a gate');
  if (r1 > 0 && a.minLockSecs === 0) bad('CLASS2_LOCK', 'alloc.minLockSecs', 'a reserved share for locked buyers needs a minimum lockup');
  if (r2 > 0 && a.earlyUntilTs === 0n && !a.priorityGate) bad('CLASS3_PRIORITY', 'alloc.earlyUntilTs', 'a reserved share for priority buyers needs an early-commitment time or a priority gate');
  if (a.lotteryUnit > 0n && !(a.smallCapQuote > 0n && r0 > 0)) bad('LOTTERY', 'alloc.lotteryUnit', 'the lottery draws among small verified buyers, so it needs their cap and a reserved share for them');
  if (a.earlyUntilTs !== 0n && !(a.earlyUntilTs > ctx.openTs && a.earlyUntilTs < ctx.closeTs)) bad('EARLY_WINDOW', 'alloc.earlyUntilTs', 'the early-commitment time falls inside the call');
  for (const [field, v] of [['alloc.minLockSecs', a.minLockSecs], ['alloc.lockVestSecs', a.lockVestSecs], ['alloc.class1CliffSecs', a.class1CliffSecs], ['alloc.class1VestSecs', a.class1VestSecs], ['neutrality.insiderCliffSecs', r.neutrality.insiderCliffSecs], ['neutrality.insiderVestSecs', r.neutrality.insiderVestSecs]] as const) {
    if (v > MAX_LOCK_SECS) bad('LOCK_RANGE', field, 'a lockup, cliff or vesting period is at most four years');
  }
  if ((a.class1CliffSecs > 0 || a.class1VestSecs > 0) && a.smallCapQuote === 0n) bad('CLASS1_VESTING', 'alloc.class1VestSecs', 'identity-bound vesting applies to the small-buyer class, which needs its cap');
  const locks = a.minLockSecs > 0 || a.class1CliffSecs > 0 || a.class1VestSecs > 0 || r.neutrality.insiderCliffSecs > 0 || r.neutrality.insiderVestSecs > 0;
  if (locks && deferred) bad('LOCKS_NOT_FOR_DEFERRED', 'alloc', 'a locked fill is paid by a plain token transfer, which the transfer hook of a deferred-mint continuation would refuse; lockups are not available there');

  const n = r.neutrality;
  if (n.insiders.length > MAX_INSIDERS) bad('INSIDERS_COUNT', 'neutrality.insiders', `at most ${MAX_INSIDERS} insiders can be declared`);
  const seen = new Set<string>();
  for (const [i, ins] of n.insiders.entries()) {
    if (ins === ZERO) bad('INSIDER_ZERO', `neutrality.insiders[${i}]`, 'an insider is a wallet address');
    if (seen.has(ins)) bad('INSIDER_DUPLICATE', `neutrality.insiders[${i}]`, 'an insider is declared once');
    seen.add(ins);
  }
  if (n.bondQuote > 0n) {
    if (n.challengeSecs < MIN_CHALLENGE_SECS || n.challengeSecs > MAX_CHALLENGE_SECS) bad('CHALLENGE_WINDOW', 'neutrality.challengeSecs', `the challenge window is between ${MIN_CHALLENGE_SECS / 3_600} hour and ${MAX_CHALLENGE_SECS / 86_400} days`);
  } else if (n.challengeSecs !== 0) bad('CHALLENGE_WITHOUT_BOND', 'neutrality.challengeSecs', 'a challenge window belongs to a bond');

  if ((r.flags & FLAG_GUARD_SCALED_UI) !== 0 && deferred) bad('SCALED_UI_DEFERRED', 'flags', 'the scaled-UI guard reads the base mint, which a deferred-mint cross does not have yet');

  const os = r.oracleSet;
  const isDefault = os.extraFeeds.length === 0 && os.quorum === 0 && os.maxSpreadBps === 0 && os.offHoursWidenBps === 0;
  if (!isDefault) {
    if (!ctx.oracleFeedId) bad('ORACLE_SET_NEEDS_GUARD', 'oracleSet', 'extra oracle feeds, a quorum, a spread or an off-hours band widen the cross\'s own oracle guard, so the cross needs one');
    const sources = os.extraFeeds.length + 1;
    if (os.quorum < 1 || os.quorum > sources) bad('QUORUM', 'oracleSet.quorum', `the quorum is between 1 and the number of oracles (${sources})`);
    for (const [i, f] of os.extraFeeds.entries()) {
      if (isZero32(f) || (ctx.oracleFeedId && eq32(f, ctx.oracleFeedId)) || os.extraFeeds.slice(0, i).some((p) => eq32(p, f))) bad('FEED', `oracleSet.extraFeeds[${i}]`, 'an extra feed is a distinct, non-zero feed id');
    }
    if (os.offHoursWidenBps > MAX_WIDEN_BPS) bad('WIDEN', 'oracleSet.offHoursWidenBps', `the off-hours widening is at most ${MAX_WIDEN_BPS} basis points`);
    if (os.extraFeeds.length === 0 && (os.maxSpreadBps !== 0 || os.quorum !== 1)) bad('SPREAD', 'oracleSet.maxSpreadBps', 'a maximum spread needs at least one extra feed');
    if (os.offHoursWidenBps > 0 && !ctx.calendar) bad('WIDEN_NEEDS_CALENDAR', 'oracleSet.offHoursWidenBps', 'the off-hours band follows a calendar\'s sessions, so the cross needs a calendar');
  }

  const ref = r.referral;
  if (ref.shareBps > 0) {
    if (ref.shareBps > MAX_REFERRAL_BPS || ref.referrer === ZERO) bad('REFERRAL', 'referral', `a referral is a referrer wallet and a share of the protocol fee of at most ${MAX_REFERRAL_BPS} basis points (half)`);
  } else if (ref.referrer !== ZERO) bad('REFERRAL_ZERO', 'referral.referrer', 'a referrer needs a share');

  return out;
}
