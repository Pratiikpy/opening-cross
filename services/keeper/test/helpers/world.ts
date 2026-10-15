// An in-memory chain for the keeper's duties: accounts are bytes in a map, and `send` applies the effect of each instruction the keeper sends to the accounts it
// touches (an order closes, a challenge account closes and the open count falls, a lockup releases, a halt state changes, a series spawns a cross), so a second pass
// reads what the first one did. It is the program's behaviour as far as the keeper depends on it, written from programs/cross_core/src and not the program itself.
import { type Address, type Instruction, type TransactionSigner, generateKeyPairSigner, none, some } from '@solana/kit';
import {
  CHALLENGE_DISCRIMINATOR,
  CLAIM_DISCRIMINATOR,
  CLEAR_DISCRIMINATOR,
  HALT_STATE_DISCRIMINATOR,
  CROSS_BODY_LEN,
  CROSS_CORE_PROGRAM_ADDRESS,
  CROSS_DISCRIMINATOR,
  CROSS_EXT_LEN,
  CrossState,
  EXPIRE_CHALLENGE_DISCRIMINATOR,
  FINALIZE_DISCRIMINATOR,
  HaltReason,
  INIT_SHARD_DISCRIMINATOR,
  OBSERVE_PRICE_DISCRIMINATOR,
  ORDER_BODY_LEN,
  ORDER_DISCRIMINATOR,
  PUSH_REFUNDS_DISCRIMINATOR,
  RELEASE_LOCKED_DISCRIMINATOR,
  SPAWN_NEXT_DISCRIMINATOR,
  SYNC_PAUSE_DISCRIMINATOR,
  challengeAddress,
  completeRules,
  getChallengeEncoder,
  getCrossDecoder,
  getCrossEncoder,
  getCrossExtEncoder,
  getHaltStateDecoder,
  getHaltStateEncoder,
  getLockupDecoder,
  getLockupEncoder,
  getOrderDecoder,
  getOrderEncoder,
  getSeriesDecoder,
  getSeriesEncoder,
  haltStateAddress,
  lockupAddress,
  readCrossExt,
} from '@opening-cross/cross-core-client';
import { calendarSessions } from '@opening-cross/indexer';
import { CLAIM_PARTNER_FEE_DISCRIMINATOR, CROSS_SETTLE_PROGRAM_ADDRESS } from '@opening-cross/cross-settle-client';
import { POOL_PARTNER_BASE_FEE_OFFSET, POOL_PARTNER_QUOTE_FEE_OFFSET } from '../../src/partner-fees.js';
import { ASSOCIATED_TOKEN_PROGRAM, ata, lockupReleasable, nextSeriesClose, orderAddress, paddedRules, seriesAddress } from '@opening-cross/sdk';
import { type KeeperDeps, parseDuties } from '../../src/index.js';

export const NOW = 1_800_000_000n;
export const DAY = 86_400n;
const ZERO = '11111111111111111111111111111111' as Address;
/** The program allocates an account's largest size; an option that turns Some later must not overflow the bytes it was created with. */
const padded = (b: ArrayLike<number>) => {
  const out = new Uint8Array(b.length + 64);
  out.set(b);
  return out;
};
const eq = (a: ArrayLike<number>, b: ArrayLike<number>) => Array.from(b).every((v, i) => a[i] === v);
export const key = async () => (await generateKeyPairSigner()).address;

export type CrossOpts = {
  state?: CrossState;
  /** The clearing price of a Cleared cross. */
  price?: bigint;
  rules?: Parameters<typeof completeRules>[0] | null;
  haltSource?: Address;
  insiders?: Address[];
  bond?: bigint;
  challengeSecs?: number;
  clearedTs?: bigint;
  /** Challenges filed so far, and how many of those are still open. */
  filed?: number;
  open?: number;
  baseMint?: Address;
  /** The fee rates the cross snapshotted and what buyers paid or sellers owed, so that `finalize` has fees to split. Default: a cross with no fees, which mints. */
  fees?: { protocolBps: number; integratorBps: number; buyerPaid?: bigint; feesAccrued?: bigint; escrow?: boolean };
};

export class World {
  accounts = new Map<string, Uint8Array>();
  sent: Instruction[][] = [];
  clock = NOW;
  crosses: Address[] = [];
  orderOf = new Map<string, Address[]>();
  lockups: Address[] = [];
  seriesList: Address[] = [];
  haltList: Address[] = [];
  /** Mints whose pausable extension is paused. */
  paused = new Set<string>();
  /** A verified oracle update per feed (hex). */
  updates = new Map<string, { account: Address; publishTime: bigint }>();
  /** Instructions whose send throws, by cross_core discriminator name. */
  refuse = new Set<string>();
  shards = new Set<string>();
  /** Partner-fee claims the chain accepted: the cross, the pool and the two destinations named, and what the pool held for the partner. */
  claims: { cross: Address; pool: Address; baseDestination: Address; quoteDestination: Address; base: bigint; quote: bigint }[] = [];
  base!: Address;
  quote!: Address;
  payer!: TransactionSigner;

  static async create(): Promise<World> {
    const w = new World();
    w.payer = await generateKeyPairSigner();
    w.base = await key();
    w.quote = await key();
    return w;
  }

  // ------------------------------------------------------------------------------------------------------------ builders

  async cross(o: CrossOpts = {}): Promise<Address> {
    const address = await key();
    const z = new Uint8Array(4096);
    z.set(CROSS_DISCRIMINATOR as Uint8Array, 0);
    const state = o.state ?? CrossState.Live;
    const body = getCrossEncoder().encode({
      ...getCrossDecoder().decode(z),
      state,
      baseBound: true,
      baseMint: o.baseMint ?? this.base,
      quoteMint: this.quote,
      protocolFeeBps: o.fees?.protocolBps ?? 0,
      integratorFeeBps: o.fees?.integratorBps ?? 0,
      buyerPaid: o.fees?.buyerPaid ?? 0n,
      feesAccrued: o.fees?.feesAccrued ?? 0n,
      ...(o.fees ? { supplyMode: o.fees.escrow ? 0 : 1 } : {}),
      creator: this.payer.address,
      feeRecipient: this.payer.address,
      integrator: this.payer.address,
      proceedsTo: this.payer.address,
      shards: 2,
      mergedMask: 3,
      openTs: NOW - 5000n,
      closeTs: NOW - 4000n,
      revealEndTs: NOW - 3000n,
      ordersOpen: 0,
      ordersTotal: 0,
      oracle: none(),
      clearing: state === CrossState.Cleared ? some({ price: o.price ?? 100n, matched: 1n, demand: 1n, supply: 1n, rationed: 0, marginalQuantity: 0n, marginalRemaining: 0n, marginalOrders: 0 }) : none(),
    } as never);
    const data = new Uint8Array(CROSS_BODY_LEN + (o.rules ? CROSS_EXT_LEN : 0));
    data.set(body);
    if (o.rules) {
      const r = completeRules(o.rules);
      const insiders = o.insiders ?? [];
      data.set(
        getCrossExtEncoder().encode({
          version: 1, rulesSet: true, createdSlot: 1n, flags: r.flags, guards: { ...r.guards, haltSource: o.haltSource ?? null }, ending: r.ending,
          draw: { epoch: 0, pendingSlot: 0n, pendingPurpose: 0, seed: new Uint8Array(32), seedEpoch: 0, seedReady: true, endBucket: 255, extPending: false, extensionUsed: false, auxMerged: 0n },
          identity: r.identity, alloc: { ...r.alloc, priorityGate: null },
          neutrality: { insiders: [...insiders, ...Array.from({ length: 8 - insiders.length }, () => ZERO)], insiderCount: insiders.length, insiderCliffSecs: 0, insiderVestSecs: 0, bondQuote: o.bond ?? 0n, challengeSecs: o.challengeSecs ?? (o.bond ? 3_600 : 0) },
          neutralState: { bondHeld: o.bond ?? 0n, slashed: 0n, openChallenges: o.open ?? 0, challenges: o.filed ?? 0 },
          clearing: { classQty: [0n, 0n, 0n], tickets: 0, rho: 0, clearedTs: o.clearedTs ?? 0n, insiderUb: 0n }, referral: r.referral,
          oracleSet: { extraFeeds: [new Uint8Array(32), new Uint8Array(32)] as never, extraCount: 0, quorum: 0, maxSpreadBps: 0, offHoursWidenBps: 0 },
        } as never),
        CROSS_BODY_LEN,
      );
    }
    this.accounts.set(address, data);
    this.crosses.push(address);
    return address;
  }

  /** An open order; `revealed` false is a sealed order that was never revealed. */
  async order(cross: Address, o: { side: 'buy' | 'sell'; price: bigint; revealed?: boolean }): Promise<Address> {
    const oz = new Uint8Array(512);
    oz.set(ORDER_DISCRIMINATOR as Uint8Array, 0);
    const list = this.orderOf.get(cross) ?? [];
    // The order lives at its program-derived address, which is where the keeper's instructions name it.
    const owner = await key();
    const address = await orderAddress(cross, owner, BigInt(list.length));
    const body = getOrderEncoder().encode({
      ...getOrderDecoder().decode(oz),
      cross,
      owner,
      nonce: BigInt(list.length),
      index: list.length,
      side: o.side === 'buy' ? 0 : 1,
      state: o.revealed === false ? 0 : 1,
      price: o.price,
      quantity: 10n,
      escrow: 1_000n,
    } as never);
    const data = new Uint8Array(ORDER_BODY_LEN + (readCrossExt(this.get(cross)) ? 32 : 0));
    data.set(body);
    if (data.length > ORDER_BODY_LEN) data.set([1, 0, 1], ORDER_BODY_LEN);
    this.accounts.set(address, data);
    this.orderOf.set(cross, [...list, address]);
    this.patchCross(cross, (c) => ({ ...c, ordersOpen: c.ordersOpen + 1, ordersTotal: c.ordersTotal + 1 }));
    return address;
  }

  async challenge(cross: Address, id: number, filedTs: bigint, status: 0 | 1 | 2 = 0): Promise<Address> {
    const address = await challengeAddress(cross, id);
    this.accounts.set(address, new Uint8Array(getChallengeEncoder().encode({ cross, id, challenger: await key(), subject: await key(), evidence: new Uint8Array(32), deposit: 10_000_000n, filedTs, status, slashed: 0n, bump: 255 } as never)));
    return address;
  }

  async lockup(o: { cross: Address; amount: bigint; released?: bigint; startTs: bigint; cliffSecs: number; vestSecs: number }): Promise<Address> {
    const owner = await key();
    const nonce = BigInt(this.lockups.length);
    const address = await lockupAddress(o.cross, owner, nonce);
    this.accounts.set(address, new Uint8Array(getLockupEncoder().encode({ cross: o.cross, owner, nonce, amount: o.amount, released: o.released ?? 0n, startTs: o.startTs, cliffSecs: o.cliffSecs, vestSecs: o.vestSecs, bump: 255 } as never)));
    this.lockups.push(address);
    return address;
  }

  async series(o: { startTs: bigint; intervalSecs?: bigint; callSecs?: bigint; nextIndex?: bigint; lastCross?: Address; lastCloseTs?: bigint; active?: boolean; maxCrosses?: bigint; calendar?: Address; rulesFlags?: number }): Promise<Address> {
    const authority = this.payer.address;
    const id = BigInt(this.seriesList.length + 1);
    const address = await seriesAddress(authority, id);
    const rules = paddedRules({ flags: o.rulesFlags ?? 0 });
    this.accounts.set(
      address,
      padded(getSeriesEncoder().encode({
        authority, seriesId: id, baseMint: this.base, quoteMint: this.quote, baseTokenProgram: ZERO, quoteTokenProgram: ZERO,
        config: { kind: 1, disclosure: 1, priceScale: 1_000_000n, grid: { relative: true, minPrice: 0n, tick: 0n, ticks: 20, tickBps: 50, center: 0n }, startTs: o.startTs, intervalSecs: o.intervalSecs ?? 3_600n, calendar: o.calendar ? some(o.calendar) : none(), callSecs: o.callSecs ?? 600n, revealSecs: 0n, minMatched: 0n, maxImbalanceBps: none(), integratorFeeBps: 0, integrator: authority, gateMint: none(), shards: 2, maxOrders: 64, proceedsTo: authority, oracle: none(), maxCrosses: o.maxCrosses ?? 0n, rules },
        nextIndex: o.nextIndex ?? 0n, lastCross: o.lastCross ? some(o.lastCross) : none(), lastCloseTs: o.lastCloseTs ?? 0n, lastPrice: 0n, active: o.active ?? true, bump: 255,
      } as never)),
    );
    this.seriesList.push(address);
    return address;
  }

  async halt(o: { baseMint?: Address; halted?: boolean; reason?: HaltReason; issuerUnpaused?: boolean; corporateAction?: boolean; breaker?: { feedId: Uint8Array; lastPublishTs?: bigint } }): Promise<Address> {
    const baseMint = o.baseMint ?? this.base;
    const address = await haltStateAddress(baseMint);
    this.accounts.set(
      address,
      padded(getHaltStateEncoder().encode({
        baseMint, authority: this.payer.address, venueSigner: none(), halted: o.halted ?? false, reason: o.reason ?? HaltReason.None, corporateAction: o.corporateAction ?? false, sinceTs: o.halted ? NOW - 100n : 0n, sinceSlot: 0n,
        issuerUnpaused: o.issuerUnpaused ?? false,
        breaker: o.breaker ? some({ feedId: o.breaker.feedId, windowSlots: 100, moveBps: 500, lastPrice: 0n, lastExponent: 0, lastSlot: 0n, lastPublishTs: o.breaker.lastPublishTs ?? 0n }) : none(),
        lastResumeCross: none(), lastResumePrice: 0n, lastResumeTs: 0n, bump: 255,
      } as never)),
    );
    this.haltList.push(address);
    return address;
  }

  // ------------------------------------------------------------------------------------------------------------ reading and patching

  get = (a: string): Uint8Array => {
    const d = this.accounts.get(a);
    if (!d) throw new Error(`no account ${a}`);
    return d;
  };
  patchCross(a: Address, f: (c: ReturnType<ReturnType<typeof getCrossDecoder>['decode']>) => object): void {
    const d = this.get(a);
    const next = f(getCrossDecoder().decode(d));
    d.set(getCrossEncoder().encode(next as never));
  }
  patchExt(a: Address, f: (x: NonNullable<ReturnType<typeof readCrossExt>>) => object): void {
    const d = this.get(a);
    d.set(getCrossExtEncoder().encode(f(readCrossExt(d)!) as never), CROSS_BODY_LEN);
  }

  // ------------------------------------------------------------------------------------------------------------ the chain's answer to what the keeper sends

  private async apply(ix: Instruction): Promise<void> {
    // The associated token program: creating an account that already exists changes nothing (the idempotent form, data byte 1).
    if (ix.programAddress === ASSOCIATED_TOKEN_PROGRAM && ix.data?.[0] === 1) {
      const created = ix.accounts![1]!.address;
      if (!this.accounts.has(created)) this.accounts.set(created, new Uint8Array(165));
      return;
    }
    // cross_settle's claim_partner_fee: DBC pays the partner's accrued fee straight into the two destinations, which must exist, and the pool's counters fall to zero.
    if (ix.programAddress === CROSS_SETTLE_PROGRAM_ADDRESS && ix.data && eq(ix.data, CLAIM_PARTNER_FEE_DISCRIMINATOR)) {
      const [cross, pool, baseDestination, quoteDestination] = [0, 4, 5, 6].map((i) => ix.accounts![i]!.address) as [Address, Address, Address, Address];
      for (const dest of [baseDestination, quoteDestination]) if (!this.accounts.has(dest)) throw new Error(`AccountNotInitialized: ${dest}`);
      const data = this.get(pool);
      const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
      const [base, quote] = [v.getBigUint64(POOL_PARTNER_BASE_FEE_OFFSET, true), v.getBigUint64(POOL_PARTNER_QUOTE_FEE_OFFSET, true)];
      v.setBigUint64(POOL_PARTNER_BASE_FEE_OFFSET, 0n, true);
      v.setBigUint64(POOL_PARTNER_QUOTE_FEE_OFFSET, 0n, true);
      this.claims.push({ cross, pool, baseDestination, quoteDestination, base, quote });
      return;
    }
    if (ix.programAddress !== CROSS_CORE_PROGRAM_ADDRESS || !ix.data) return;
    const is = (d: ArrayLike<number>) => eq(ix.data!, d);
    const at = (i: number) => ix.accounts![i]!.address;
    for (const name of this.refuse) {
      const d = { push_refunds: PUSH_REFUNDS_DISCRIMINATOR, expire_challenge: EXPIRE_CHALLENGE_DISCRIMINATOR, release_locked: RELEASE_LOCKED_DISCRIMINATOR, spawn_next: SPAWN_NEXT_DISCRIMINATOR, sync_pause: SYNC_PAUSE_DISCRIMINATOR, observe_price: OBSERVE_PRICE_DISCRIMINATOR }[name];
      if (d && is(d)) throw new Error(`${name} refused by the program (custom program error)`);
    }
    if (is(PUSH_REFUNDS_DISCRIMINATOR)) {
      const cross = at(0);
      const orders = new Set(this.orderOf.get(cross) ?? []);
      const closing = ix.accounts!.map((a) => a.address).filter((a) => orders.has(a));
      for (const o of closing) this.accounts.delete(o);
      this.patchCross(cross, (c) => ({ ...c, ordersOpen: c.ordersOpen - closing.length }));
    } else if (is(CLAIM_DISCRIMINATOR)) {
      const orders = new Set([...this.orderOf.values()].flat());
      const closing = ix.accounts!.map((a) => a.address).filter((a) => orders.has(a) && this.accounts.has(a));
      for (const o of closing) {
        const c = getOrderDecoder().decode(this.get(o)).cross;
        this.accounts.delete(o);
        this.patchCross(c, (x) => ({ ...x, ordersOpen: x.ordersOpen - 1 }));
      }
    } else if (is(CLEAR_DISCRIMINATOR)) {
      // The print guard: a cross whose rules name a halt state must be given it, and prints no price while the asset is halted or a corporate action is flagged.
      const cross = at(0);
      const x = readCrossExt(this.get(cross));
      let blocked = false;
      if (x && x.guards.haltSource.__option === 'Some') {
        const given = ix.accounts!.slice(2).find((a) => a.address === x.guards.haltSource.value && this.accounts.has(a.address) && eq(this.get(a.address), HALT_STATE_DISCRIMINATOR));
        if (!given) throw new Error('HaltMismatch: the halt state the rules name was not passed to clear');
        const h = getHaltStateDecoder().decode(this.get(given.address));
        blocked = h.halted || h.corporateAction;
      }
      this.patchCross(cross, (c) => ({ ...c, state: blocked ? CrossState.NoPrint : CrossState.Cleared, clearing: blocked ? none() : some({ price: 100n, matched: 1n, demand: 1n, supply: 1n, rationed: 0, marginalQuantity: 0n, marginalRemaining: 0n, marginalOrders: 0 }) }));
    } else if (is(FINALIZE_DISCRIMINATOR)) {
      const cross = at(1);
      const x = readCrossExt(this.get(cross));
      const c = getCrossDecoder().decode(this.get(cross));
      if (c.ordersOpen !== 0) throw new Error('OrdersOutstanding');
      // finalize pays the referrer out of the protocol fee and refuses to run when the referrer's quote account is not among its accounts (programs/cross_core/src/lib.rs).
      if (x && x.referral.shareBps > 0) {
        const totalBps = BigInt(c.protocolFeeBps + c.integratorFeeBps);
        const fees = c.supplyMode === 0 ? c.feesAccrued : (c.buyerPaid * totalBps) / 10_000n;
        const protocolFee = totalBps === 0n ? 0n : (fees * BigInt(c.protocolFeeBps)) / totalBps;
        if (protocolFee > 0n && (protocolFee * BigInt(x.referral.shareBps)) / 10_000n > 0n) {
          const want = await ata(x.referral.referrer, c.quoteMint, c.quoteTokenProgram);
          if (!ix.accounts!.some((a) => a.address === want) || !this.accounts.has(want)) throw new Error('ReferralAccountMissing');
        }
      }
      if (c.state === CrossState.Cleared && x && x.neutrality.bondQuote > 0n && (this.clock < x.clearing.clearedTs + BigInt(x.neutrality.challengeSecs) || x.neutralState.openChallenges > 0)) throw new Error('ChallengesOutstanding');
      this.patchCross(cross, (y) => ({ ...y, state: CrossState.Finalized }));
    } else if (is(EXPIRE_CHALLENGE_DISCRIMINATOR)) {
      const [cross, challenge] = [at(0), at(1)];
      const ch = this.accounts.get(challenge);
      if (!ch || !eq(ch, CHALLENGE_DISCRIMINATOR)) throw new Error('AccountNotInitialized');
      this.accounts.delete(challenge);
      this.patchExt(cross, (x) => ({ ...x, neutralState: { ...x.neutralState, openChallenges: x.neutralState.openChallenges - 1 } }));
    } else if (is(RELEASE_LOCKED_DISCRIMINATOR)) {
      const lockup = at(2);
      const l = getLockupDecoder().decode(this.get(lockup));
      const releasable = lockupReleasable(l, this.clock);
      if (releasable === 0n) throw new Error('NothingToRelease');
      this.get(lockup).set(getLockupEncoder().encode({ ...l, released: l.released + releasable } as never));
      if (l.released + releasable === l.amount) this.accounts.delete(lockup);
    } else if (is(SYNC_PAUSE_DISCRIMINATOR)) {
      const [halt, mint] = [at(0), at(1)];
      const h = getHaltStateDecoder().decode(this.get(halt));
      const next = this.paused.has(mint)
        ? h.halted ? h : { ...h, halted: true, reason: HaltReason.IssuerPause, sinceTs: this.clock, issuerUnpaused: false }
        : h.halted && h.reason === HaltReason.IssuerPause ? { ...h, issuerUnpaused: true } : h;
      this.get(halt).set(getHaltStateEncoder().encode(next as never));
    } else if (is(OBSERVE_PRICE_DISCRIMINATOR)) {
      const [halt, update] = [at(0), at(1)];
      const h = getHaltStateDecoder().decode(this.get(halt));
      const u = [...this.updates.values()].find((x) => x.account === update);
      if (h.breaker.__option !== 'Some' || !u) throw new Error('OracleUnavailable');
      if (this.clock - u.publishTime > 120n || u.publishTime <= h.breaker.value.lastPublishTs) throw new Error('OracleUnavailable');
      this.get(halt).set(getHaltStateEncoder().encode({ ...h, breaker: some({ ...h.breaker.value, lastPublishTs: u.publishTime }) } as never));
    } else if (is(SPAWN_NEXT_DISCRIMINATOR)) {
      const [series, cross] = [at(2), at(3)];
      const s = getSeriesDecoder().decode(this.get(series));
      this.accounts.set(cross, this.accounts.get(cross) ?? this.freshSpawned(series, s.nextIndex));
      const sessions = s.config.calendar.__option === 'Some' ? (calendarSessions(this.get(s.config.calendar.value))?.map((x) => x.startTs) ?? null) : null;
      const closeTs = nextSeriesClose(s.config, s.nextIndex, s.lastCloseTs, this.clock, sessions) ?? 0n;
      this.get(series).set(getSeriesEncoder().encode({ ...s, nextIndex: s.nextIndex + 1n, lastCross: some(cross), lastCloseTs: closeTs } as never));
      this.crosses.push(cross);
    } else if (is(INIT_SHARD_DISCRIMINATOR)) {
      this.shards.add(at(2));
      this.accounts.set(at(2), new Uint8Array(16));
    }
  }

  /** A cross as `spawn_next` makes it: the series' own address is its creator (ADR-0456). */
  private freshSpawned(series: Address, _index: bigint): Uint8Array {
    const z = new Uint8Array(4096);
    z.set(CROSS_DISCRIMINATOR as Uint8Array, 0);
    const body = getCrossEncoder().encode({ ...getCrossDecoder().decode(z), creator: series, state: CrossState.Live, baseBound: true, baseMint: this.base, quoteMint: this.quote, shards: 2, mergedMask: 0, openTs: this.clock, closeTs: this.clock + 600n, revealEndTs: this.clock + 600n, oracle: none(), clearing: none() } as never);
    const data = new Uint8Array(CROSS_BODY_LEN + CROSS_EXT_LEN);
    data.set(body);
    const r = completeRules({});
    data.set(
      getCrossExtEncoder().encode({
        version: 1, rulesSet: true, createdSlot: 1n, flags: r.flags, guards: { ...r.guards, haltSource: null }, ending: r.ending,
        draw: { epoch: 0, pendingSlot: 0n, pendingPurpose: 0, seed: new Uint8Array(32), seedEpoch: 0, seedReady: true, endBucket: 255, extPending: false, extensionUsed: false, auxMerged: 0n },
        identity: r.identity, alloc: { ...r.alloc, priorityGate: null }, neutrality: { insiders: Array.from({ length: 8 }, () => ZERO), insiderCount: 0, insiderCliffSecs: 0, insiderVestSecs: 0, bondQuote: 0n, challengeSecs: 0 },
        neutralState: { bondHeld: 0n, slashed: 0n, openChallenges: 0, challenges: 0 }, clearing: { classQty: [0n, 0n, 0n], tickets: 0, rho: 0, clearedTs: 0n, insiderUb: 0n }, referral: r.referral,
        oracleSet: { extraFeeds: [new Uint8Array(32), new Uint8Array(32)] as never, extraCount: 0, quorum: 0, maxSpreadBps: 0, offHoursWidenBps: 0 },
      } as never),
      CROSS_BODY_LEN,
    );
    return data;
  }

  // ------------------------------------------------------------------------------------------------------------ the keeper's dependencies

  deps(over: Omit<Partial<KeeperDeps>, 'duties'> & { duties?: string } = {}): KeeperDeps {
    const { duties, ...rest } = over;
    return {
      payer: this.payer,
      now: async () => this.clock,
      fetch: async (a) => this.accounts.get(a) ?? null,
      crosses: async () => this.crosses.filter((c) => this.accounts.has(c)),
      orders: async (c) => (this.orderOf.get(c) ?? []).filter((o) => this.accounts.has(o)),
      send: async (ixs) => {
        for (const ix of ixs) await this.apply(ix);
        this.sent.push(ixs);
        return `sig${this.sent.length}`;
      },
      lockups: async () => this.lockups,
      series: async () => this.seriesList,
      halts: async () => this.haltList,
      mintPaused: async (m) => this.paused.has(m),
      priceUpdate: async (feed) => this.updates.get(feed) ?? null,
      duties: parseDuties(duties ?? 'all'),
      ...rest,
    };
  }
}

