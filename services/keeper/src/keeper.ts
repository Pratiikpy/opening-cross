// One keeper pass: discover candidate crosses, re-read each from chain, plan, execute.
//
// Discovery is only a hint (the indexer's table or a getProgramAccounts scan); every decision is
// made from account data fetched in this pass, never from the index. Sends are independent: one
// failure (often a competing keeper that got there first) never stops the rest of the pass.
//
// The duties beyond a cross's lifecycle (ADR-0703) are named in `KeeperDeps.duties` and are off unless named: batched refunds, closing unanswered insider
// challenges, releasing vested lockups, spawning recurring series and keeping halt states current. `dryRun` plans every action and sends none.
import type { Address, Instruction, TransactionSigner } from '@solana/kit';
import {
  CHALLENGE_DISCRIMINATOR,
  type Cross,
  type CrossExt,
  CrossState,
  OrderSide,
  OrderState,
  type Series,
  getAbandonSettlementInstruction,
  getChallengeDecoder,
  getCrossDecoder,
  getHaltStateDecoder,
  getLockupDecoder,
  getOrderDecoder,
  getSeriesDecoder,
  readCrossExt,
  readOrderExt,
  challengeAddress,
} from '@opening-cross/cross-core-client';
import {
  buildClaim,
  buildDrawBegin,
  buildDrawFinish,
  buildExpireChallenge,
  buildFinalizeWithAccounts,
  buildMissingRuledAccounts,
  buildMissingShards,
  buildObservePrice,
  buildPushRefunds,
  buildReleaseLocked,
  buildSettleBook,
  buildSpawnNext,
  buildSyncPause,
  crossAddress,
} from '@opening-cross/sdk';
import { calendarSessions } from '@opening-cross/indexer';
import { type Action, type OpenOrder, type Skip, plan } from './plan.js';
import { type ChallengeFacts, type HaltFacts, type LockFacts, type SeriesFacts, planExpiries, planHalt, planRelease, planSpawn } from './duties.js';
import { programPasses } from './program-passes.js';
import type { EntitlementSource } from './entitlements.js';
import type { PartnerFeeConfig } from './partner-fees.js';

export type AccountFetcher = (address: Address) => Promise<Uint8Array | null>;

/** The optional work beyond the lifecycle of a cross. A duty not named is not done. */
export type Duty = 'refunds' | 'challenges' | 'locks' | 'series' | 'halts' | 'graduation' | 'listings' | 'bounties' | 'backing' | 'partner-fees';
export const ALL_DUTIES: readonly Duty[] = ['refunds', 'challenges', 'locks', 'series', 'halts', 'graduation', 'listings', 'bounties', 'backing', 'partner-fees'];
/**
 * What a keeper does when nobody says otherwise: the duties that cost it nothing beyond transaction fees. `locks` pays for the owner's token account on a first release, `series` for the rent of every
 * cross it spawns and `listings` for the venue's slash account when a slash is the first thing to reach it, so those are asked for by name; `bounties` sends rewards to the keeper's own wallet, so the
 * operator asks for that too. `graduation` (finalize a closed vote, publish a passed one) and `backing` (halt an opted-in asset whose backing cannot be verified) are permissionless, cost a fee, and
 * the program refuses whatever is not due, so they are on. On a cluster without the Wave 3D programs discovery finds nothing and they do nothing.
 */
export const DEFAULT_DUTIES: readonly Duty[] = ['refunds', 'challenges', 'halts', 'graduation', 'backing'];

/** `all`, `none`, `default`, or a comma-separated list of duty names, in which `default` stands for the default duties (`default,locks`); an unknown name is an error, never silently ignored. */
export function parseDuties(text: string | undefined): Set<Duty> {
  const t = (text ?? 'default').trim();
  if (t === 'default') return new Set(DEFAULT_DUTIES);
  if (t === 'all') return new Set(ALL_DUTIES);
  if (t === 'none' || t === '') return new Set();
  const out = new Set<Duty>();
  for (const name of t.split(',').map((x) => x.trim()).filter(Boolean)) {
    if (name === 'default') {
      for (const d of DEFAULT_DUTIES) out.add(d);
      continue;
    }
    if (!(ALL_DUTIES as readonly string[]).includes(name)) throw new Error(`unknown keeper duty "${name}"; the duties are ${ALL_DUTIES.join(', ')}, or all, none, default`);
    out.add(name as Duty);
  }
  return out;
}

export type KeeperDeps = {
  payer: TransactionSigner;
  /** Unix seconds as the cluster sees it (the program compares against its own Clock). */
  now: () => Promise<bigint>;
  fetch: AccountFetcher;
  /** Candidate crosses that may need work. */
  crosses: () => Promise<Address[]>;
  /** Order account addresses believed open for a cross; each is re-read before use. */
  orders: (cross: Address) => Promise<Address[]>;
  /** Sends one transaction; resolves with its signature or rejects with the program's logs. */
  send: (ixs: Instruction[]) => Promise<string>;
  /** The cluster's current slot. Needed to time the two steps of a draw; without it a cross that is owed a draw is skipped with a reason. */
  slot?: () => Promise<bigint>;
  /** Pyth price update account for oracle-guarded crosses; null means the keeper cannot clear it. */
  oraclePrice?: (cross: Address) => Promise<Address | null>;
  /** Scopes the keeper to some crosses (for example one issuer's). Omitted, it serves every cross it discovers. */
  accept?: (cross: Cross) => boolean;
  /**
   * Whether a mint is, right now, in a state that stops transfers or settlement (paused, an active transfer hook, a
   * pending multiplier change inside the halt window). Null when it is fine. Omitted, the keeper does not look.
   * See `mintHaltCheck` in halt.ts for the token-safety implementation.
   */
  mintHalt?: (mint: Address) => Promise<MintHalt | null>;
  /**
   * What the keeper has already found impossible, kept by the caller across passes so a halted cross is not
   * re-sent every pass. Omitted, nothing is remembered and a halted mint is re-attempted each pass.
   */
  memory?: Map<string, Deferred>;
  /** Which optional duties to do (default none, so a keeper built before the duties existed behaves as it did). */
  duties?: ReadonlySet<Duty>;
  /** Plan everything, send nothing: the actions that would have been sent are in `PassResult.planned`. */
  dryRun?: boolean;
  /** Lockup accounts that may have something to release (duty `locks`). Each is re-read before use. */
  lockups?: () => Promise<Address[]>;
  /** Releases smaller than this many base atoms wait for more to vest (the last release is always sent). Default 1. */
  minRelease?: bigint;
  /** Series accounts (duty `series`). Each is re-read before use. */
  series?: () => Promise<Address[]>;
  /** Halt-state accounts (duty `halts`). Each is re-read before use. */
  halts?: () => Promise<Address[]>;
  /** Whether a mint's pausable extension is paused now; null when it cannot be told (duty `halts`). */
  mintPaused?: (mint: Address) => Promise<boolean | null>;
  /** A recent verified Pyth update for a breaker's feed (hex feed id), when the keeper can supply one (duty `halts`). */
  priceUpdate?: (feedId: string) => Promise<{ account: Address; publishTime: bigint } | null>;
  /** Graduation charter accounts (duty `graduation`). Each is re-read before use. */
  charters?: () => Promise<Address[]>;
  /** Listing accounts that may be released or slashed (duty `listings`). Each is re-read before use. */
  listings?: () => Promise<Address[]>;
  /** Bounty accounts (duty `bounties`). Each is re-read before use. */
  bounties?: () => Promise<Address[]>;
  /** Every cross a bounty claim should look at, finalized ones included (duty `bounties`); defaults to `crosses`. */
  bountyCrosses?: () => Promise<Address[]>;
  /** Backing policy accounts (duty `backing`). Each is re-read before use. */
  policies?: () => Promise<Address[]>;
  /**
   * Subscriptions from the billing service (ADR-0960). When given, the `series` duty spawns the next cross only for an issuer with a paid period. Only the keeper's own
   * spend is conditioned on it: settling, claims, refunds, finalizing and lock releases are never held back, and the program stays permissionless.
   */
  entitlement?: EntitlementSource;
  /** Series authorities the managed scheduler serves without a subscription (the operator's own issuers). */
  entitlementExempt?: ReadonlySet<string>;
  /** Crosses that may have a DBC continuation pool, finalized ones included (duty `partner-fees`); defaults to `bountyCrosses`, then `crosses`. */
  partnerCrosses?: () => Promise<Address[]>;
  /** When and how much to claim of the protocol's partner fees (duty `partner-fees`); see partner-fees.ts for the defaults. */
  partnerFees?: PartnerFeeConfig;
};

export type MintHalt = { code: string; message: string };
/** A step that cannot succeed until `sig` changes (the set of halts in force), or, for a frozen account, until a delay passes. */
export type Deferred = { sig: string; at: bigint };

/** Seconds before a step refused for a frozen token account is tried again; the issuer can thaw it at any time. */
const LAYOUT = 'LAYOUT';
const LAYOUT_RETRY_SECONDS = 3600n;
const FROZEN_RETRY_SECONDS = 600n;
const FROZEN = 'ACCOUNT_FROZEN';
/** A cross whose refund batch was refused is claimed order by order for this long. */
const PUSH_REFUSED = 'PUSH_REFUSED';
const PUSH_RETRY_SECONDS = 3600n;
/** Challenges examined per cross per pass: a cross with more is read in full over several passes only if the oldest are closed first. */
const MAX_CHALLENGES_READ = 256;
type Halt = MintHalt & { role: 'base' | 'quote'; mint: Address };

export type PassResult = {
  done: { action: Action; signature: string }[];
  failed: { action: Action; error: string }[];
  skipped: Skip[];
  /** Only in a dry run: the actions that would have been sent, in the order they would have been. */
  planned: Action[];
};

/** Lifecycle stages a cross can move through in one pass: settle/abandon → claims → finalize. */
const MAX_ROUNDS = 4;

export async function runOnce(d: KeeperDeps): Promise<PassResult> {
  const result: PassResult = { done: [], failed: [], skipped: [], planned: [] };
  const now = await d.now();
  const duties = d.duties ?? new Set<Duty>();
  // Crosses whose refund batch was refused in this pass when the caller keeps no memory across passes.
  const pushOff = new Set<Address>();
  // Halt states first: a pause the mint carries is in the halt state before the crosses that name it are cleared.
  if (duties.has('halts') && d.halts) await haltsPass(d, now, result);
  for (const address of await d.crosses()) {
    // Re-plan after every round that changed state, so one pass carries a cross as far as the
    // clock allows. Skips are reported from the final round only.
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const r = await advance(address, d, now, result, pushOff);
      if (!r.progressed) {
        result.skipped.push(...r.skipped);
        break;
      }
    }
  }
  if (duties.has('series') && d.series) await seriesPass(d, now, result);
  if (duties.has('locks') && d.lockups) await locksPass(d, now, result);
  await programPasses(d, now, result, perform);
  return result;
}

async function advance(address: Address, d: KeeperDeps, now: bigint, result: PassResult, pushOff: Set<Address>): Promise<{ progressed: boolean; skipped: Skip[] }> {
  const data = await d.fetch(address);
  if (!data) return { progressed: false, skipped: [] };
  const cross = getCrossDecoder().decode(data);
  if (d.accept && !d.accept(cross)) return { progressed: false, skipped: [] };
  const duties = d.duties ?? new Set<Duty>();
  const open: OpenOrder[] = [];
  for (const o of await d.orders(address)) {
    const od = await d.fetch(o);
    if (!od) continue; // claimed or cancelled since discovery
    const order = getOrderDecoder().decode(od);
    if (order.cross === address) open.push({ address: o, owner: order.owner, nonce: order.nonce, side: order.side === OrderSide.Buy ? 'buy' : 'sell', price: order.price, revealed: order.state === OrderState.Revealed });
  }
  const slot = d.slot ? await d.slot().catch(() => null) : null;
  const ext = readCrossExt(data);
  const memory = d.memory;
  const mark = `${address}|`;
  const pushKnown = memory?.get(`${mark}${PUSH_REFUSED}`);
  // push_refunds exists only in the extended program, and only a cross it created carries the rules tail: a cross of the earlier layout is claimed order by order, as before.
  const pushAllowed = duties.has('refunds') && ext !== null && !pushOff.has(address) && !(pushKnown && now - pushKnown.at < PUSH_RETRY_SECONDS);
  const p = plan(address, cross, open, now, { ext, slot }, { pushRefunds: pushAllowed });
  // Insider challenges the arbiter left unanswered are closed first: `finalize` waits for them.
  if (duties.has('challenges') && ext && ext.neutralState.openChallenges > 0 && (cross.state === CrossState.Cleared || cross.state === CrossState.NoPrint)) {
    const e = planExpiries(address, await readChallenges(address, ext, d), now);
    p.actions.unshift(...e.actions);
    p.skipped.push(...e.skipped);
  }
  const halts: Halt[] = [];
  if (d.mintHalt) {
    for (const [role, mint] of [['base', cross.baseBound ? cross.baseMint : null], ['quote', cross.quoteMint]] as const) {
      // A mint that cannot be read (closed, RPC down) must not stop the pass for every other cross: act as the keeper did
      // before the check existed. The on-chain program still refuses whatever cannot move.
      const h = mint ? await d.mintHalt(mint).catch(() => null) : null;
      if (mint && h) halts.push({ ...h, role, mint });
    }
  }
  const sig = halts.map((h) => `${h.code}:${h.mint}`).join(',');
  if (memory && halts.length === 0) {
    // Whatever was holding this cross back is gone; forget it so the steps are tried again (a frozen-account entry keeps its own delay).
    for (const [k, v] of memory) if (k.startsWith(mark) && v.sig !== FROZEN && v.sig !== LAYOUT && v.sig !== PUSH_REFUSED) memory.delete(k);
  }
  const why = (h: Halt) => `the ${h.role} mint ${h.mint} cannot move right now: ${h.message}`;
  let progressed = false;
  let held = 0;
  let frozen = 0;
  for (const action of p.actions) {
    // A halted mint stops a print outright: a price nobody can be paid at is not worth fixing on chain.
    if (action.kind === 'settle' && halts.length > 0) {
      p.skipped.push({ cross: address, code: halts[0]!.code, reason: `settlement is withheld while ${why(halts[0]!)}` });
      continue;
    }
    const key = `${mark}${action.kind}|${action.kind === 'claim' ? action.order.address : action.kind === 'expire-challenge' ? action.id : action.kind === 'push-refunds' ? action.orders[0]!.address : ''}`;
    const known = memory?.get(key);
    if (known?.sig === LAYOUT && now - known.at < LAYOUT_RETRY_SECONDS) {
      p.skipped.push({ cross: address, code: LAYOUT, reason: 'an account of this cross belongs to a different program than this one expects (an earlier layout), so it cannot be settled; checked again hourly' });
      continue;
    }
    if (known && ((known.sig === FROZEN && now - known.at < FROZEN_RETRY_SECONDS) || (known.sig !== FROZEN && halts.length > 0 && known.sig === sig))) {
      if (known.sig === FROZEN) frozen++;
      else held++;
      continue;
    }
    if (d.dryRun) {
      result.planned.push(action);
      continue;
    }
    try {
      // Re-read before each step: a previous step changes the cross.
      const fresh = await d.fetch(address);
      if (!fresh) throw new Error('cross disappeared');
      const view = { address, data: getCrossDecoder().decode(fresh), ext: readCrossExt(fresh) };
      let last = '';
      for (const ixs of await instructionsFor(action, view, d)) last = await d.send(ixs);
      result.done.push({ action, signature: last });
      memory?.delete(key);
      progressed = true;
    } catch (e) {
      const error = describe(e);
      // The program cannot read this account (written by an earlier layout): retrying cannot
      // succeed, so report it once as skipped with the reason rather than failing every pass.
      if (error.includes('AccountDidNotDeserialize')) p.skipped.push({ cross: address, reason: `the program cannot read this account (${error})` });
      // A cross created without its order-book shards can never be settled either; report it once instead of failing every pass.
      else if (error.includes('AccountOwnedByWrongProgram')) {
        // An account of an earlier program layout: the same step will be refused every pass, so it is remembered for an hour.
        memory?.set(key, { sig: LAYOUT, at: now });
        p.skipped.push({ cross: address, code: LAYOUT, reason: `an account of this cross belongs to a different program than this one expects, so it cannot be settled (${error})` });
      } else if (error.includes('AccountNotInitialized')) p.skipped.push({ cross: address, reason: `an account this cross needs was never created, so it cannot be settled (${error})` });
      // A refund batch the program refused (an order it counts as filled, or a destination account that does not exist): the orders are claimed one by one
      // from the next round on, and the batch is not tried again for an hour. Nothing is lost: the batch moved nothing.
      else if (action.kind === 'push-refunds') {
        result.failed.push({ action, error });
        memory?.set(`${mark}${PUSH_REFUSED}`, { sig: PUSH_REFUSED, at: now });
        progressed = true;
        pushOff.add(address);
      }
      // The step was refused while a mint is halted on chain: that is the cause, not a fault to retry every pass. Remember it
      // and try again only when the set of halts changes.
      else if (halts.length > 0) {
        memory?.set(key, { sig, at: now });
        held++;
      }
      // A token account holding or receiving this cross's tokens is frozen by the issuer; only the issuer can fix it.
      else if (/Account is frozen|custom program error: 0x11\b/.test(error)) {
        memory?.set(key, { sig: FROZEN, at: now });
        frozen++;
      } else result.failed.push({ action, error });
    }
  }
  if (held > 0) p.skipped.push({ cross: address, code: halts[0]?.code ?? 'MINT_HALTED', reason: `${held} step(s) held back, not retried until the halt changes: ${halts.map(why).join('; ')}` });
  if (frozen > 0) p.skipped.push({ cross: address, code: FROZEN, reason: `${frozen} step(s) refused because a token account is frozen by the issuer; retried after ${FROZEN_RETRY_SECONDS / 60n} minutes` });
  return { progressed, skipped: p.skipped };
}

/** The challenges filed against a cross, read from chain. A challenge account is closed when it is ruled on or expires, so a missing one is not open. */
async function readChallenges(cross: Address, ext: CrossExt, d: KeeperDeps): Promise<ChallengeFacts[]> {
  const out: ChallengeFacts[] = [];
  const total = Math.min(ext.neutralState.challenges, MAX_CHALLENGES_READ);
  for (let id = 0; id < total; id++) {
    const address = await challengeAddress(cross, id);
    const data = await d.fetch(address);
    if (!data || !(CHALLENGE_DISCRIMINATOR as Uint8Array).every((b, i) => data[i] === b)) continue;
    const c = getChallengeDecoder().decode(data);
    out.push({ id, address, challenger: c.challenger, filedTs: c.filedTs, open: c.status === 0 });
  }
  return out;
}

/** Runs one action that is not part of a cross's lifecycle loop. Returns whether anything was sent. */
export async function perform(d: KeeperDeps, result: PassResult, action: Action, build: () => Promise<Instruction[][]>): Promise<boolean> {
  if (d.dryRun) {
    result.planned.push(action);
    return false;
  }
  try {
    let last = '';
    for (const ixs of await build()) last = await d.send(ixs);
    result.done.push({ action, signature: last });
    return true;
  } catch (e) {
    result.failed.push({ action, error: describe(e) });
    return false;
  }
}

async function haltsPass(d: KeeperDeps, now: bigint, result: PassResult): Promise<void> {
  for (const address of await d.halts!()) {
    const data = await d.fetch(address);
    if (!data) continue;
    let halt;
    try {
      halt = getHaltStateDecoder().decode(data);
    } catch {
      continue; // not a halt state of this layout
    }
    const mintPaused = d.mintPaused ? await d.mintPaused(halt.baseMint).catch(() => null) : null;
    const breaker = halt.breaker.__option === 'Some' ? halt.breaker.value : null;
    const update = breaker && d.priceUpdate ? await d.priceUpdate(Buffer.from(breaker.feedId).toString('hex')).catch(() => null) : null;
    const facts: HaltFacts = { address, halt, mintPaused, update };
    const p = planHalt(facts, now);
    result.skipped.push(...p.skipped);
    for (const action of p.actions) {
      await perform(d, result, action, async () => {
        if (action.kind === 'sync-pause') return [[await buildSyncPause(action.baseMint)]];
        if (action.kind === 'observe-price') return [[await buildObservePrice(action.baseMint, action.priceUpdate)]];
        throw new Error(`unexpected halt action ${action.kind}`);
      });
    }
  }
}

async function seriesPass(d: KeeperDeps, now: bigint, result: PassResult): Promise<void> {
  for (const address of await d.series!()) {
    const data = await d.fetch(address);
    if (!data) continue;
    let series: Series;
    try {
      series = getSeriesDecoder().decode(data);
    } catch {
      continue;
    }
    let previous: SeriesFacts['previous'] = null;
    if (series.lastCross.__option === 'Some') {
      const prev = await d.fetch(series.lastCross.value);
      if (prev) {
        try {
          previous = { address: series.lastCross.value, state: getCrossDecoder().decode(prev).state };
        } catch {
          previous = null;
        }
      }
    }
    let sessionStarts: bigint[] | null = null;
    if (series.config.calendar.__option === 'Some') {
      const cal = await d.fetch(series.config.calendar.value);
      sessionStarts = cal ? (calendarSessions(cal)?.map((s) => s.startTs) ?? null) : null;
    }
    const p = planSpawn({ address, series, previous, sessionStarts }, now);
    result.skipped.push(...p.skipped);
    for (const action of p.actions) {
      if (action.kind !== 'spawn-next') continue;
      // Spawning is the managed scheduler: the keeper pays the rent of every cross it spawns, so it does that for subscribers (ADR-0960). Anyone else may spawn this cross.
      const held = await entitlementHold(d, series.authority, address);
      if (held) {
        result.skipped.push(held);
        continue;
      }
      const sent = await perform(d, result, action, async () => [[(await buildSpawnNext({ address, data: series }, d.payer, { feed: action.feed })).instruction]]);
      // The spawned cross has no shards yet: nobody can trade, and nothing can be cleared, until they exist. They follow the spawn, from the cross as it is on chain.
      if (sent) await initShards(d, result, await crossAddress(address, series.nextIndex), action);
    }
  }
}

/**
 * Whether the managed scheduler should spawn for `issuer`, when the keeper is given the billing service's entitlements: a skip saying why not, or null to go ahead.
 * Without entitlements configured the keeper spawns for every series it is scoped to, as before. The program is permissionless either way, so the skip says who else can do it.
 */
async function entitlementHold(d: KeeperDeps, issuer: Address, series: Address): Promise<Skip | null> {
  if (!d.entitlement || d.entitlementExempt?.has(issuer)) return null;
  try {
    const e = await d.entitlement(issuer);
    if (e.entitled) return null;
    return { cross: series, code: 'NOT_ENTITLED', reason: `${issuer} has no paid subscription period, so the managed scheduler does not spawn this series' next cross; spawn_next is permissionless, and anyone may send it` };
  } catch (e) {
    return { cross: series, code: 'ENTITLEMENT_UNKNOWN', reason: `the subscription of ${issuer} could not be checked (${e instanceof Error ? e.message : String(e)}); the managed scheduler waits rather than spend rent on a guess` };
  }
}

/** Creates the shards, class book and lock vault a freshly spawned cross lacks, one transaction each (shards are large). */
async function initShards(d: KeeperDeps, result: PassResult, cross: Address, parent: Action): Promise<void> {
  try {
    const data = await d.fetch(cross);
    if (!data) throw new Error('the spawned cross is not on chain');
    const view = { address: cross, data: getCrossDecoder().decode(data), ext: readCrossExt(data) };
    const exists = async (a: Address) => (await d.fetch(a)) !== null;
    const ixs = [...(await buildMissingShards(view, d.payer, exists)), ...(await buildMissingRuledAccounts(view, d.payer, exists))];
    for (const ix of ixs) await d.send([ix]);
  } catch (e) {
    result.failed.push({ action: parent, error: `the series spawned ${cross} but creating its shards failed: ${describe(e)}` });
  }
}

async function locksPass(d: KeeperDeps, now: bigint, result: PassResult): Promise<void> {
  for (const address of await d.lockups!()) {
    const data = await d.fetch(address);
    if (!data) continue; // released in full and closed
    let l;
    try {
      l = getLockupDecoder().decode(data);
    } catch {
      continue;
    }
    const facts: LockFacts = { address, cross: l.cross, owner: l.owner, nonce: l.nonce, amount: l.amount, released: l.released, startTs: l.startTs, cliffSecs: l.cliffSecs, vestSecs: l.vestSecs };
    const action = planRelease(facts, now, d.minRelease ?? 1n);
    if (!action || action.kind !== 'release-locked') continue;
    if (d.accept) {
      const c = await d.fetch(l.cross);
      if (!c || !d.accept(getCrossDecoder().decode(c))) continue;
    }
    await perform(d, result, action, async () => {
      const raw = await d.fetch(action.cross);
      if (!raw) throw new Error('cross disappeared');
      const view = { address: action.cross, data: getCrossDecoder().decode(raw), ext: readCrossExt(raw) };
      return [await buildReleaseLocked(view, d.payer, action.owner, action.nonce)];
    });
  }
}

/** Each inner array is one transaction. */
async function instructionsFor(a: Action, view: { address: Address; data: Cross; ext: ReturnType<typeof readCrossExt> }, d: KeeperDeps): Promise<Instruction[][]> {
  switch (a.kind) {
    case 'settle': {
      let oraclePrice: Address | undefined;
      if (view.data.oracle.__option === 'Some') {
        const p = d.oraclePrice ? await d.oraclePrice(a.cross) : null;
        if (!p) throw new Error('oracle-guarded cross: no Pyth price update available');
        oraclePrice = p;
      }
      // One shard merge per transaction keeps each well inside the compute limit.
      return (await buildSettleBook(view, { ...(oraclePrice ? { oraclePrice } : {}), now: await d.now() })).map((ix) => [ix]);
    }
    case 'draw-begin':
      return [[buildDrawBegin(a.cross)]];
    case 'draw-finish':
      return [[buildDrawFinish(a.cross)]];
    case 'abandon':
      return [[getAbandonSettlementInstruction({ cross: a.cross })]];
    case 'claim':
    {
      // A cross with rules pays from accounts that depend on the order's own tail (bucket, class, lockup), so read it.
      if (!view.ext) return [await buildClaim(view, d.payer, a.order.owner, a.order.nonce)];
      const raw = await d.fetch(a.order.address);
      if (!raw) throw new Error('order disappeared');
      const facts = { ext: readOrderExt(raw), isBuy: getOrderDecoder().decode(raw).side === OrderSide.Buy };
      return [await buildClaim(view, d.payer, a.order.owner, a.order.nonce, facts)];
    }
    case 'push-refunds':
      return [[await buildPushRefunds(view, a.orders.map((o) => ({ owner: o.owner, nonce: o.nonce, side: o.side === 'sell' ? OrderSide.Sell : OrderSide.Buy })))]];
    case 'expire-challenge':
      return [[await buildExpireChallenge({ cross: a.cross, id: a.id, challenger: a.challenger })]];
    case 'finalize': {
      // The accounts finalize pays into are opened first (one transaction finishes any cross), the referrer's among them when the rules name one: finalize refuses to run without it.
      return [await buildFinalizeWithAccounts(view, d.payer)];
    }
    default:
      throw new Error(`${a.kind} is not a step of a cross's lifecycle`);
  }
}

/** The program's own reason when the node returned simulation logs, else the error's first line. */
export function describe(e: unknown): string {
  type WithLogs = { context?: { logs?: string[] }; cause?: { context?: { logs?: string[] } } };
  const err = e as WithLogs | undefined;
  const logs = err?.cause?.context?.logs ?? err?.context?.logs;
  const reason = logs?.find((l) => l.includes('Error Code:'));
  if (reason) return reason.replace(/^Program log: /, '');
  return e instanceof Error ? e.message.split('\n')[0]! : String(e);
}
