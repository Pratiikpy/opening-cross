// A cross's rules for the person about to bid, in plain language, and the checks an order must pass before the wallet is asked to sign.
// Pure: the caller supplies the clock, the wallet's standing and the figures read from GET /v1/crosses/:address/rules. Nothing here reads
// the network. The checks mirror what the program refuses (programs/cross_core/src/orders.rs `admit`, identity.rs `on_commit`, the
// cancel cutoff) so that a person reads the reason before signing, not an error code after.
import type { Market } from './units';
import { duration } from './treasury';
import { formatAtoms, formatPrice, shortAddress } from './units';

// ---------------------------------------------------------------------------------------------------- what the API serves

export type RulesJson = {
  flags: { resumesHalt: boolean; feedsLenders: boolean; standardGrid: boolean; guardScaledUi: boolean; /** Present on an API that knows the fifth rule flag (ADR-0656). */ governedGraduation?: boolean };
  guards: { minRaiseQuote: string; maxMatched: string; totalSupply: string; minFloatBps: number; maxFdvX100: number; anchorPrice: string; moveBps: number; gridEstimate: string; haltSource: string | null };
  ending: { endingSecs: number; buckets: number; cancelCutoffSecs: number; randomEnd: boolean; extensionMinSecs: number; extensionMaxSecs: number };
  identity: { capQuote: string; maxOrders: number };
  alloc: { reserveBps: number[]; smallCapQuote: string; lotteryUnit: string; minLockSecs: number; lockVestSecs: number; earlyUntilTs: string; priorityGate: string | null; class1CliffSecs: number; class1VestSecs: number };
  neutrality: { insiders: string[]; insiderCliffSecs: number; insiderVestSecs: number; bondQuote: string; challengeSecs: number };
  referral: { referrer: string; shareBps: number } | null;
  oracleSet: { extraFeeds: string[]; quorum: number; maxSpreadBps: number; offHoursWidenBps: number };
};

export type DrawState = { epoch: number; seedReady: boolean; endBucket: number | null; extensionPending: boolean; extensionUsed: boolean; pendingSlot: string | null };
export type RulesState = {
  draw: DrawState;
  neutrality: { bondHeld: string; slashed: string; openChallenges: number; challenges: number };
  clearing: { classQty: string[]; tickets: number; rho: number; clearedTs: string; insiderUb: string } | null;
  noPrintReason: string | null;
};
export type RulesCalls = {
  classBook: boolean;
  lockVault: boolean;
  needsDraw: boolean;
  drawOwed: 'end' | 'extension' | null;
  drawStatus: 'not-begun' | 'waiting' | 'ready' | 'void' | 'unknown';
  auxShards: number[];
  cancelDeadline: string;
  endingStartsAt: string | null;
};
/** GET /v1/crosses/:address/rules. `rules` is null for a cross without a rules tail. */
export type RulesRead = { cross: string; rules: RulesJson | null; note?: string; state?: RulesState; calls?: RulesCalls };

export type Imbalance3 = 'balanced' | 'demand-heavy' | 'supply-heavy';
/** GET /v1/crosses/:address/indicative. */
export type IndicativeRead = {
  cross: string;
  phase: 'open' | 'ending' | 'no-book';
  coarse?: boolean;
  indicative: { price: string | null; matched?: string; imbalance: Imbalance3 } | null;
  endsAt?: string;
  note: string;
};

/** The longest lock the program accepts: four years (programs/cross_core/src/lock.rs MAX_LOCK_SECS). */
export const MAX_LOCK_SECS = 4 * 365 * 24 * 60 * 60;

const bpsText = (bps: number): string => `${Number((bps / 100).toFixed(2))}%`;
const quote = (atoms: string | bigint, m: Market): string => `${formatAtoms(BigInt(atoms), m.quoteDecimals)} quote`;
const tokens = (atoms: string | bigint, m: Market): string => `${formatAtoms(BigInt(atoms), m.baseDecimals)} tokens`;
/** `2592000` is `30 days`; `400` is `6 minutes 40 seconds`: the two largest units, in words. */
const secs = (n: number | bigint): string => duration(String(n));
export const clock = (ts: bigint | string | number): string => `${new Date(Number(ts) * 1000).toISOString().replace('T', ' ').slice(0, 16)} UTC`;

// ---------------------------------------------------------------------------------------------------- the ending period

export type EndingNow =
  | { kind: 'none' }
  /** The ending period has not started; `startsAt` is when it does. */
  | { kind: 'before'; startsAt: bigint }
  /** Inside it: window `bucket` of `buckets` (0-based), which ends at `bucketEndsAt`. */
  | { kind: 'ending'; startsAt: bigint; bucket: number; buckets: number; bucketEndsAt: bigint }
  /** An extension has opened a second call: orders then go to the extension shards and cannot be cancelled. */
  | { kind: 'extension' };

/** Where `now` falls in the ending period (mirrors `placementAt`, packages/cross-core-client/src/ext.ts). */
export function endingNow(rules: RulesJson | null, state: RulesState | undefined, closeTs: bigint, now: bigint): EndingNow {
  if (!rules) return { kind: 'none' };
  if ((state?.draw.epoch ?? 0) > 0) return { kind: 'extension' };
  const e = rules.ending;
  if (e.endingSecs === 0) return { kind: 'none' };
  const startsAt = closeTs - BigInt(e.endingSecs);
  if (now < startsAt) return { kind: 'before', startsAt };
  const span = BigInt(e.endingSecs);
  const n = BigInt(e.buckets);
  const b = ((now - startsAt) * n) / span;
  const bucket = Number(b < n - 1n ? b : n - 1n);
  const bucketEndsAt = bucket === e.buckets - 1 ? closeTs : startsAt + (BigInt(bucket + 1) * span + n - 1n) / n;
  return { kind: 'ending', startsAt, bucket, buckets: e.buckets, bucketEndsAt };
}

/** The last second an order may be cancelled is just before this; `null` when the cross has no rules (it can be cancelled until the close). */
export const cancelDeadlineOf = (calls: RulesCalls | undefined, closeTs: bigint): bigint => (calls ? BigInt(calls.cancelDeadline) : closeTs);

// ---------------------------------------------------------------------------------------------------- the rules in words

export type Section = { id: string; title: string; lines: string[] };

export type DescribeContext = { market: Market; closeTs: bigint; gated: boolean; sealed: boolean; mintsAtSettlement: boolean; calls?: RulesCalls; state?: RulesState };

/**
 * Every rule the cross carries, as sentences a bidder can act on. A rule that is off is left out; a cross whose rules are all off gets one
 * line that says so. Amounts are the cross's own units. Nothing is paraphrased beyond what the program enforces.
 */
export function describeRules(r: RulesJson, c: DescribeContext): Section[] {
  const m = c.market;
  const out: Section[] = [];
  const add = (id: string, title: string, lines: string[]) => lines.length > 0 && out.push({ id, title, lines });

  // How the call ends.
  const e = r.ending;
  const ending: string[] = [];
  if (e.endingSecs > 0) {
    const start = c.closeTs - BigInt(e.endingSecs);
    ending.push(`The last ${secs(e.endingSecs)} of the call (from ${clock(start)}) is an ending period, cut into ${e.buckets} equal windows. An order lands in the window of the moment it is confirmed on the network.`);
    ending.push(
      e.randomEnd
        ? 'After the call closes, a draw picks the last window that counts. Orders in later windows are not counted and are refunded in full, so bidding at the last moment can cost the chance to trade; bidding early cannot. The draw uses the cluster’s own block hashes, not a verifiable random function.'
        : 'Every window counts: the ending period only separates orders by window so they can be audited.',
    );
    ending.push('While the ending period is open this app shows the indicative price only to the nearest band and the balance of demand only as a direction. That is a display rule of this app, not secrecy: the order accounts are public on chain.');
  }
  if (e.cancelCutoffSecs > 0 || e.endingSecs > 0) {
    const deadline = c.calls ? BigInt(c.calls.cancelDeadline) : c.closeTs - BigInt(e.endingSecs) - BigInt(e.cancelCutoffSecs);
    ending.push(`Orders can be cancelled until ${clock(deadline)}. After that an order cannot be withdrawn, but it is still refunded in full if the cross does not print or its window is not counted.`);
  }
  if (e.extensionMaxSecs > 0) {
    ending.push(`If the cross fails a print guard it reopens once, for a length drawn between ${secs(e.extensionMinSecs)} and ${secs(e.extensionMaxSecs)}. Orders placed in the extension cannot be cancelled. A second failure is final and everyone is refunded.`);
  }
  add('ending', 'How the call ends', ending);

  // When it will not print.
  const g = r.guards;
  const guards: string[] = [];
  if (BigInt(g.minRaiseQuote) > 0n) guards.push(`It does not print unless the amount raised at the clearing price is at least ${quote(g.minRaiseQuote, m)}. Declared insiders’ allocations are left out of that count.`);
  if (BigInt(g.maxMatched) > 0n) guards.push(`At most ${tokens(g.maxMatched, m)} are sold, however much is asked for. If demand is larger the price rises until demand fits, then buy orders at the clearing price are shared pro rata. The cap was published before the call and cannot change.`);
  if (g.minFloatBps > 0) guards.push(`It does not print unless the tokens sold are at least ${bpsText(g.minFloatBps)} of the total supply${BigInt(g.totalSupply) > 0n ? ` (${tokens(g.totalSupply, m)}, as declared)` : ' (read from the token at the clear)'}.`);
  if (g.maxFdvX100 > 0) guards.push(`It does not print if the fully diluted value at the clearing price is more than ${Number((g.maxFdvX100 / 100).toFixed(2))} times the amount sold.`);
  if (g.moveBps > 0 && BigInt(g.anchorPrice) > 0n) guards.push(`It does not print if the clearing price lands more than ${bpsText(g.moveBps)} from the reference price ${formatPrice(BigInt(g.anchorPrice), m)}. Nothing executes at a price the published bound excludes.`);
  if (g.haltSource) guards.push('It honours the halt state of the token: if trading is halted, a corporate action is flagged or the token is paused when the cross is cleared, it does not print and every order is refunded.');
  if (r.flags.guardScaledUi) guards.push('It does not print if the token’s scaled-amount multiplier has changed since the rules were set (a split or a dividend), because the price grid was drawn for the old multiplier.');
  const o = r.oracleSet;
  if (o.extraFeeds.length > 0 || o.offHoursWidenBps > 0 || o.maxSpreadBps > 0) {
    const bits: string[] = [];
    if (o.extraFeeds.length > 0) bits.push(`the reference is the median of ${o.extraFeeds.length + 1} oracle prices, and at least ${o.quorum} of them must be usable`);
    if (o.maxSpreadBps > 0) bits.push(`the usable prices may differ from one another by at most ${bpsText(o.maxSpreadBps)} or the cross does not print`);
    if (o.offHoursWidenBps > 0) bits.push(`the allowed distance from the oracle widens by ${bpsText(o.offHoursWidenBps)} while the market’s calendar is closed`);
    guards.push(`Oracle check: ${bits.join('; ')}.`);
  }
  if (guards.length > 0) guards.push('When it does not print, no one trades and every order is refunded in full; the reason is recorded on chain.');
  add('guards', 'When it will not print', guards);

  // Flags: the stock options.
  const flags: string[] = [];
  if (r.flags.standardGrid) flags.push(`The price grid follows the issuer’s published estimate${BigInt(g.gridEstimate) > 0n ? ` of ${formatPrice(BigInt(g.gridEstimate), m)}` : ''}: it contains it, starts no lower than half of it and moves in steps of at most 1% of it.`);
  if (r.flags.resumesHalt) flags.push('This is a resume cross. A halted token trades again only after a cross like this prints: it is the one-price auction that lifts the halt.');
  if (r.flags.feedsLenders) flags.push('If this cross prints with enough volume, its price is published to the lender price feed that lending markets read.');
  if (r.flags.governedGraduation) flags.push('The market opens only on the venue holders vote for. Holders lock tokens behind a venue (see the Graduation tab); the settlement program refuses a pool on any other venue, and a failed vote leaves the market without one.');
  add('flags', 'Market options', flags);

  // Per-wallet limits.
  const lim: string[] = [];
  const i = r.identity;
  if (c.gated || i.maxOrders > 0 || BigInt(i.capQuote) > 0n) {
    if (i.maxOrders > 0) lim.push(`Each verified wallet may have at most ${i.maxOrders} live order${i.maxOrders === 1 ? '' : 's'} in this cross${i.maxOrders === 1 ? ' (one application per identity)' : ''}. Cancelling an order frees its place.`);
    if (BigInt(i.capQuote) > 0n) lim.push(`Each verified wallet may have at most ${quote(i.capQuote, m)} escrowed in buy orders at once. The cap is on escrow because escrow is public at the moment of the order, sealed or open.`);
  }
  add('limits', 'Limits per wallet', lim);

  // Classes.
  const a = r.alloc;
  const cls: string[] = [];
  const anyReserve = a.reserveBps.some((x) => x > 0);
  if (anyReserve || BigInt(a.smallCapQuote) > 0n || a.minLockSecs > 0 || BigInt(a.earlyUntilTs) > 0n || a.priorityGate) {
    cls.push('Classes matter only at the margin: when more is asked for at the clearing price than is offered, the shortfall is shared by class. Orders priced better than the clearing price are always filled in full, and no class changes the price.');
    if (BigInt(a.smallCapQuote) > 0n) {
      cls.push(
        `Class 1, small verified buyer: an order of at most ${quote(a.smallCapQuote, m)}${a.reserveBps[0]! > 0 ? `, with ${bpsText(a.reserveBps[0]!)} of the contested volume set aside for the class` : ''}.${BigInt(a.lotteryUnit) > 0n ? ` The class is a lottery: every class-1 order is exactly one lot of ${tokens(a.lotteryUnit, m)}, and a draw decides which orders win a lot when the class is oversubscribed. A losing ticket is refunded in full.` : ' Within the class the volume is shared pro rata.'}${a.class1CliffSecs > 0 || a.class1VestSecs > 0 ? ` A class-1 fill is locked ${secs(a.class1CliffSecs)} and then vests over ${secs(a.class1VestSecs)}.` : ''}`,
      );
    }
    if (a.minLockSecs > 0) {
      cls.push(`Class 2, locked buyer: you accept a lockup of at least ${secs(a.minLockSecs)}${a.lockVestSecs > 0 ? `, then vesting over ${secs(a.lockVestSecs)}` : ''}${a.reserveBps[1]! > 0 ? `, and ${bpsText(a.reserveBps[1]!)} of the contested volume is set aside for the class` : ''}. The lock changes when you can sell, never what you pay or how much you get.`);
    }
    if (a.reserveBps[2]! > 0 || BigInt(a.earlyUntilTs) > 0n || a.priorityGate) {
      const ways: string[] = [];
      if (BigInt(a.earlyUntilTs) > 0n) ways.push(`place the order before ${clock(a.earlyUntilTs)}`);
      if (a.priorityGate) ways.push(`hold a pass of the priority gate ${shortAddress(a.priorityGate)}`);
      cls.push(`Class 3, priority: ${ways.length > 0 ? ways.join(' or ') : 'not open to anyone'}${a.reserveBps[2]! > 0 ? `; ${bpsText(a.reserveBps[2]!)} of the contested volume is set aside for the class` : ''}. Early commitment improves priority, never price.`);
    }
  }
  add('classes', 'Allocation when oversubscribed', cls);

  // Insiders, the bond and the challenge window.
  const n = r.neutrality;
  const ins: string[] = [];
  if (n.insiders.length > 0) {
    ins.push(`The issuer declared ${n.insiders.length} insider wallet${n.insiders.length === 1 ? '' : 's'}: ${n.insiders.map(shortAddress).join(', ')}. Their buys are locked${n.insiderCliffSecs > 0 || n.insiderVestSecs > 0 ? ` for ${secs(n.insiderCliffSecs)}, then vest over ${secs(n.insiderVestSecs)}` : ''} and are left out of the minimum raise, minimum volume and float checks, so an insider can never help the cross reach its minimum.`);
  }
  if (BigInt(n.bondQuote) > 0n) {
    ins.push(`The issuer posted a bond of ${quote(n.bondQuote, m)} behind that declaration. For ${secs(n.challengeSecs)} after the clear anyone may allege that another wallet was an undeclared insider (a deposit of 0.01 SOL and the hash of the evidence). The arbiter the protocol names rules; an upheld challenge slashes part of the bond, half to the challenger.`);
    if (c.state && (c.state.neutrality.openChallenges > 0 || c.state.neutrality.slashed !== '0')) {
      ins.push(`${c.state.neutrality.openChallenges} challenge${c.state.neutrality.openChallenges === 1 ? ' is' : 's are'} open; ${quote(c.state.neutrality.slashed, m)} of the bond has been slashed.`);
    }
  }
  add('insiders', 'Insiders and the bond', ins);

  if (r.referral) add('referral', 'Referral', [`${bpsText(r.referral.shareBps)} of the protocol fee goes to the wallet that brought this cross (${shortAddress(r.referral.referrer)}). It does not change what you pay.`]);

  if (out.length === 0) {
    out.push({ id: 'none', title: 'Rules', lines: ['This cross carries a rules record, and every rule in it is off: no ending period, guards, limits, classes, lockups or insiders. It behaves as a plain call auction.'] });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------- what this wallet may do

export type Standing = {
  /** Holds a pass of the cross's gate; null when it has not been checked. */
  gatePass: boolean | null;
  /** Holds a pass of the priority gate; null when not checked, and ignored when the cross names none. */
  priorityPass: boolean | null;
  /** The wallet’s live orders in this cross and the quote escrowed in its live buy orders (what the program’s applicant record holds). Null when not read. */
  usage: { orders: number; escrow: bigint } | null;
};

export type ClassId = 0 | 1 | 2 | 3;
export type ClassOption = {
  id: ClassId;
  label: string;
  /** Said once, under the label. */
  summary: string;
  /** False when the wallet cannot take this class now; `why` says so. */
  available: boolean;
  why: string | null;
};

const isInsider = (r: RulesJson, wallet: string): boolean => r.neutrality.insiders.includes(wallet);

/** The classes the wallet can choose for a buy, each with whether it qualifies now and, when it does not, why. */
export function classOptions(r: RulesJson, c: { wallet: string; now: bigint; market: Market; gated: boolean }, s: Standing): ClassOption[] {
  const a = r.alloc;
  const m = c.market;
  const options: ClassOption[] = [{ id: 0, label: 'General', summary: 'No reserve and no lock. Shares what the reserved classes leave.', available: true, why: null }];
  if (isInsider(r, c.wallet)) {
    return [{ ...options[0]!, summary: 'You are a declared insider of this cross. Your buy is locked, is left out of the minimum raise and takes no class.' }];
  }
  if (BigInt(a.smallCapQuote) > 0n) {
    const noPass = c.gated && s.gatePass === false;
    options.push({
      id: 1,
      label: 'Small verified buyer',
      summary: `An order of at most ${quote(a.smallCapQuote, m)}${BigInt(a.lotteryUnit) > 0n ? `, exactly one lot of ${tokens(a.lotteryUnit, m)}` : ''}.`,
      available: !noPass && c.gated,
      why: !c.gated ? 'This cross has no eligibility gate, so no wallet can be verified for this class.' : noPass ? 'This wallet holds no pass for the cross’s gate.' : null,
    });
  }
  if (a.minLockSecs > 0) {
    options.push({ id: 2, label: 'Locked buyer', summary: `You accept a lockup of at least ${secs(a.minLockSecs)}${a.lockVestSecs > 0 ? `, vesting over ${secs(a.lockVestSecs)}` : ''}, and the longest the program accepts is ${secs(MAX_LOCK_SECS)}.`, available: true, why: null });
  }
  if (a.reserveBps[2]! > 0 || BigInt(a.earlyUntilTs) > 0n || a.priorityGate) {
    const early = BigInt(a.earlyUntilTs) > 0n && c.now < BigInt(a.earlyUntilTs);
    const pass = a.priorityGate !== null && s.priorityPass === true;
    const unknown = !early && a.priorityGate !== null && s.priorityPass === null;
    options.push({
      id: 3,
      label: 'Priority',
      summary: [BigInt(a.earlyUntilTs) > 0n ? `Before ${clock(a.earlyUntilTs)}` : '', a.priorityGate ? `a pass of the priority gate ${shortAddress(a.priorityGate)}` : ''].filter(Boolean).join(', or ') + '.',
      available: early || pass || unknown,
      why: early || pass || unknown ? null : `${BigInt(a.earlyUntilTs) > 0n ? `The early window closed ${clock(a.earlyUntilTs)}` : 'There is no early window'}${a.priorityGate ? ' and this wallet holds no pass of the priority gate' : ', and the cross names no priority gate'}.`,
    });
  }
  return options;
}

export type Check = { id: string; level: 'block' | 'ack' | 'note'; message: string };

export type TicketInput = {
  rules: RulesJson;
  state?: RulesState;
  calls?: RulesCalls;
  wallet: string;
  side: 'buy' | 'sell';
  cls: ClassId;
  lockSecs: number;
  /** Quote escrowed by this order (buy) and the tokens it asks for. Null while the form is incomplete. */
  escrow: bigint | null;
  quantity: bigint | null;
  now: bigint;
  closeTs: bigint;
  market: Market;
  gated: boolean;
  standing: Standing;
};

/** What stops this order, what the person must accept first, and what they should know. Empty `block` means the program will take it. */
export function ticketChecks(t: TicketInput): Check[] {
  const out: Check[] = [];
  const { rules: r, market: m } = t;
  const a = r.alloc;
  const insider = isInsider(r, t.wallet);
  const buy = t.side === 'buy';

  if (insider && buy) out.push({ id: 'insider', level: 'note', message: `This wallet is a declared insider of the cross. Your fill is locked${r.neutrality.insiderCliffSecs > 0 || r.neutrality.insiderVestSecs > 0 ? ` for ${secs(r.neutrality.insiderCliffSecs)} and then vests over ${secs(r.neutrality.insiderVestSecs)}` : ''}, and it is left out of the minimum raise and volume.` });
  if (insider && buy && (t.cls !== 0 || t.lockSecs !== 0)) out.push({ id: 'insider-class', level: 'block', message: 'A declared insider takes no allocation class and no lockup of its own choosing.' });

  if (buy && !insider) {
    if (t.cls === 1) {
      if (BigInt(a.smallCapQuote) === 0n) out.push({ id: 'c1-none', level: 'block', message: 'This cross reserves nothing for small verified buyers.' });
      else if (t.escrow !== null && t.escrow > BigInt(a.smallCapQuote)) out.push({ id: 'c1-cap', level: 'block', message: `A small-buyer order may lock at most ${quote(a.smallCapQuote, m)}; this one locks ${quote(t.escrow, m)}. Reduce the amount or choose the general class.` });
      if (BigInt(a.lotteryUnit) > 0n && t.quantity !== null && t.quantity !== BigInt(a.lotteryUnit)) out.push({ id: 'c1-lot', level: 'block', message: `A class-1 order is exactly one lot: ${tokens(a.lotteryUnit, m)}. This one asks for ${tokens(t.quantity, m)}.` });
      if (t.gated && t.standing.gatePass === false) out.push({ id: 'c1-pass', level: 'block', message: 'Class 1 is for wallets holding a pass for the cross’s gate, and this wallet holds none.' });
      if (t.lockSecs !== 0) out.push({ id: 'c1-lock', level: 'block', message: 'Class 1 takes no lockup of its own choosing.' });
      if (BigInt(a.lotteryUnit) > 0n) out.push({ id: 'c1-lottery', level: 'note', message: 'A lottery ticket cannot be withdrawn once the draw needs it, and a losing ticket is refunded in full.' });
    }
    if (t.cls === 2) {
      if (a.minLockSecs === 0) out.push({ id: 'c2-none', level: 'block', message: 'This cross offers no locked class.' });
      else if (t.lockSecs < a.minLockSecs) out.push({ id: 'c2-short', level: 'block', message: `The lockup must be at least ${secs(a.minLockSecs)}; ${t.lockSecs === 0 ? 'none is set' : `${secs(t.lockSecs)} is too short`}.` });
      else if (t.lockSecs > MAX_LOCK_SECS) out.push({ id: 'c2-long', level: 'block', message: `The program accepts a lockup of at most ${secs(MAX_LOCK_SECS)}.` });
      else out.push({ id: 'c2-lock', level: 'note', message: `Your fill will be locked for ${secs(t.lockSecs)}${a.lockVestSecs > 0 ? ` and then vest over ${secs(a.lockVestSecs)}` : ''}. Release is a separate step that anyone may send once tokens have vested.` });
    }
    if (t.cls === 3) {
      const early = BigInt(a.earlyUntilTs) > 0n && t.now < BigInt(a.earlyUntilTs);
      const pass = a.priorityGate !== null && t.standing.priorityPass === true;
      const unknown = !early && a.priorityGate !== null && t.standing.priorityPass === null;
      if (a.reserveBps[2] === 0) out.push({ id: 'c3-none', level: 'block', message: 'This cross reserves nothing for priority buyers.' });
      else if (!early && !pass && !unknown) out.push({ id: 'c3-ineligible', level: 'block', message: 'You do not qualify for priority now: the early window is over and this wallet holds no pass of the priority gate.' });
      if (t.lockSecs !== 0) out.push({ id: 'c3-lock', level: 'block', message: 'Class 3 takes no lockup of its own choosing.' });
    }
    if (t.cls === 0 && t.lockSecs !== 0) out.push({ id: 'c0-lock', level: 'block', message: 'A lockup belongs to the locked class; choose it or remove the lockup.' });
  }

  // Per-wallet limits (the program's applicant record).
  const i = r.identity;
  const u = t.standing.usage;
  if ((i.maxOrders > 0 || BigInt(i.capQuote) > 0n) && !insider) {
    if (u === null) out.push({ id: 'limit-unread', level: 'note', message: 'This cross limits each wallet’s orders and escrow; your current usage could not be read, so the program will check it.' });
    else {
      if (i.maxOrders > 0 && u.orders >= i.maxOrders) out.push({ id: 'limit-orders', level: 'block', message: `This cross allows ${i.maxOrders} live order${i.maxOrders === 1 ? '' : 's'} per wallet and you have ${u.orders}. Cancel one first${t.calls ? ` (until ${clock(BigInt(t.calls.cancelDeadline))})` : ''}.` });
      if (buy && BigInt(i.capQuote) > 0n && t.escrow !== null && u.escrow + t.escrow > BigInt(i.capQuote)) {
        const room = BigInt(i.capQuote) > u.escrow ? BigInt(i.capQuote) - u.escrow : 0n;
        out.push({ id: 'limit-escrow', level: 'block', message: `This cross caps each wallet at ${quote(i.capQuote, m)} escrowed in buy orders. You have ${quote(u.escrow, m)} escrowed and this order adds ${quote(t.escrow, m)}; there is room for ${quote(room, m)} more.` });
      }
    }
  }

  // The ending period and the cancel cutoff.
  const ending = endingNow(r, t.state, t.closeTs, t.now);
  const deadline = cancelDeadlineOf(t.calls, t.closeTs);
  if (ending.kind === 'extension') {
    out.push({ id: 'extension', level: 'ack', message: 'This is the extension of the call. An order placed now cannot be cancelled. If the cross prints again it settles; if it does not, every order is refunded in full.' });
  } else if (t.now >= deadline && (r.ending.endingSecs > 0 || r.ending.cancelCutoffSecs > 0)) {
    out.push({ id: 'cutoff-passed', level: 'ack', message: `Cancellation closed at ${clock(deadline)}. If you place this order it stays until the cross settles. It is still refunded in full if the cross does not print${r.ending.randomEnd ? ' or its ending window is not counted' : ''}.` });
  } else if (r.ending.endingSecs > 0 || r.ending.cancelCutoffSecs > 0) {
    out.push({ id: 'cutoff', level: 'note', message: `You can cancel this order until ${clock(deadline)}, ${secs(deadline - t.now)} from now.` });
  }
  if (ending.kind === 'ending') {
    out.push({ id: 'window', level: 'note', message: `This order would land in ending window ${ending.buckets > 0 ? ending.bucket + 1 : 1} of ${ending.buckets}, which ends in ${secs(ending.bucketEndsAt - t.now > 0n ? ending.bucketEndsAt - t.now : 0n)}.${r.ending.randomEnd ? ' A draw after the call picks the last window that counts; a later window is refunded.' : ''}` });
  }
  return out;
}

export const blocked = (checks: Check[]): Check[] => checks.filter((c) => c.level === 'block');
export const needsAck = (checks: Check[]): Check[] => checks.filter((c) => c.level === 'ack');

/** The price band the app shows during the ending period, as a sentence. The API rounds to one of eight bands of the grid. */
export const imbalanceText = (i: Imbalance3): string => (i === 'balanced' ? 'About balanced' : i === 'demand-heavy' ? 'More wanted than offered' : 'More offered than wanted');

// ---------------------------------------------------------------------------------------------------- outcomes

/** Why a cross did not print, including the reasons the rules added. Unknown codes are returned as they are. */
export const RULE_NO_PRINT: Record<string, string> = {
  BelowMinimumRaise: 'the amount raised at the clearing price was below the minimum the issuer set',
  FloatTooLow: 'the share of the supply that would have been sold was below the issuer’s minimum float',
  FdvTooHigh: 'the clearing price implied a fully diluted value above the issuer’s ceiling',
  PriceMoved: 'the clearing price landed further from the issuer’s reference price than the cross allows',
  Halted: 'trading in the token was halted when the cross was cleared',
  CorporateAction: 'a corporate action on the token was flagged, or its scaled-amount multiplier changed, when the cross was cleared',
  IssuerPaused: 'the token was paused when the cross was cleared',
  OracleDisagreement: 'the oracle prices the issuer named disagreed with each other by more than the cross allows',
};

/** What a person’s own order did, once the cross has settled, from what the index and the rules say. */
export type OutcomeFacts = {
  side: 'buy' | 'sell';
  escrow: bigint;
  fill: bigint;
  quoteOut: bigint;
  baseOut: bigint;
  crossPrinted: boolean;
  /** The cross’s published cap on tokens sold; 0 or absent when none. */
  maxMatched?: bigint;
  matched?: bigint;
  rationed?: 'none' | 'buy' | 'sell';
  lotteryUnit?: bigint;
  cls?: number;
};

export type Outcome = { headline: string; lines: string[] };

/** The outcome of a settled order in words: filled, partly filled and why, or refunded in full and why. Never states a reason the data cannot support. */
export function explainOutcome(o: OutcomeFacts, m: Market): Outcome {
  const lines: string[] = [];
  if (!o.crossPrinted) {
    return { headline: 'Refunded in full', lines: ['The cross did not print, so no order traded and every order is refunded in full.'] };
  }
  if (o.fill === 0n) {
    const why: string[] = [];
    if (o.side === 'buy') why.push('Your limit was below the clearing price, the order was not revealed in time, it fell outside the counted ending window, or it lost the lottery for the contested volume. The index does not record which.');
    return { headline: 'Not filled, refunded in full', lines: [o.side === 'buy' ? `Your ${quote(o.quoteOut, m)} escrow came back whole.` : `Your ${tokens(o.baseOut, m)} came back whole.`, ...why] };
  }
  const partial = o.side === 'buy' ? o.quoteOut > 0n : o.baseOut > 0n;
  lines.push(partial ? (o.side === 'buy' ? `Filled ${tokens(o.fill, m)}; the unused ${quote(o.quoteOut, m)} of your escrow came back.` : `Sold ${tokens(o.fill, m)}; the unsold ${tokens(o.baseOut, m)} came back.`) : `Filled in full: ${tokens(o.fill, m)}.`);
  if (o.rationed && o.rationed !== 'none') lines.push(`More was ${o.rationed === 'buy' ? 'asked for' : 'offered'} at the clearing price than the other side could take, so orders at it were filled pro rata${o.cls ? ` and shared by class (class ${o.cls})` : ''}.`);
  if (o.maxMatched && o.maxMatched > 0n && o.matched !== undefined && o.matched >= o.maxMatched) lines.push(`The cross’s hard cap of ${tokens(o.maxMatched, m)} was reached, which limited what could be accepted.`);
  return { headline: partial ? 'Partly filled' : 'Filled', lines };
}
