// Cross rules: unsigned transactions for every instruction the rules extension added to cross_core (ADR-0450 to ADR-0462), and the
// reads that explain a cross's rules.
//
// The API never holds a key. Every transaction comes back unsigned with the named wallet as fee payer, and every check the program
// would make is made here first, so the caller reads a reason before signing instead of a program error after.
//
// The extended program is NOT deployed on devnet yet (docs/HUMAN_TASKS.md H27). Until it is, a rules transaction is refused by the
// deployed program ("InstructionFallbackNotFound"), and a cross created by the deployed program has no rules: `rules` is null and the
// rest of this file treats it as a cross with every rule off.
//
// Creating
//   POST /v1/tx/create-cross-ruled   { ...the create-cross body, rules?, feed? }  -> { cross, transactions, sizes, rules, issues: [], warnings }
//       `rules` is the JSON form of the rules (routes/rules-input.ts). The creation and `set_rules` share ONE transaction, because
//       the rules are only accepted in the slot the cross is created in; the transactions are sent in order, each after the one
//       before it has landed. 422 { reason: 'RULES_INVALID', issues: [{ code, field, message }] } when a rule the program would refuse is set;
//       422 { reason: 'TX_TOO_LARGE' } when the pair cannot fit one transaction.
//   POST /v1/tx/init-shards (server.ts) also creates the ending-bucket shards, class book and lock vault a cross with rules lacks.
// Trading
//   POST /v1/tx/place-order-ext      { ...the place-order body, class?, lockSecs? }  -> { transaction, signers, order, placement }
//       `class` 1 identity-verified small buyer, 2 accepts a lockup (`lockSecs`), 3 priority. The ending period is cut into buckets by the chain
//       clock and an open order names its bucket's shard: `placement.validUntil` is the last second the transaction is right for; build again after it.
//   POST /v1/tx/place-order, cancel, reveal, claim, finalize (server.ts) build the right accounts for a cross with rules by themselves.
//   POST /v1/tx/settle-ext           { cross, payer, oraclePrice?, oracleAccounts? }  -> { transactions }   (settle for a cross whose extra oracle feeds are not the default accounts)
// The draw (a drawn ending, a lottery, a drawn extension)
//   POST /v1/tx/draw-begin           { cross, payer }  -> { transaction, signers, purpose }
//   POST /v1/tx/draw-finish          { cross, payer }  -> { transaction, signers, purpose, earliestSlot }
// After the clear
//   POST /v1/tx/release-locked       { cross, owner, nonce, payer? }  -> { transaction, signers, releasable }
//   POST /v1/tx/push-refunds         { cross, payer, orders: [{ owner, nonce }] }  (1 to 12; refund-only orders)  -> { transaction, signers, orders }
//   POST /v1/tx/close-applicant      { cross, owner, payer? }
// Issuer neutrality
//   POST /v1/tx/challenge-insider    { cross, challenger, subject, evidence: <32-byte hex> }  -> { transaction, signers, id, challenge, depositLamports }
//   POST /v1/tx/resolve-challenge    { cross, arbiter, id, upheld, slash? }
//   POST /v1/tx/expire-challenge     { cross, id, payer }
//   POST /v1/tx/set-arbiter          { admin, arbiter }
// Halt states and the lender feed
//   POST /v1/tx/init-halt-state      { authority, baseMint, venueSigner?, breaker?: { feedId, windowSlots, moveBps } }
//   POST /v1/tx/set-halt             { signer, baseMint }
//   POST /v1/tx/set-corporate-action { signer, baseMint, flag }
//   POST /v1/tx/sync-pause           { payer, baseMint }
//   POST /v1/tx/observe-price        { payer, baseMint, priceUpdate }
//   POST /v1/tx/init-print-feed      { authority, baseMint, quoteMint, publishers: [address], minMatched }
//   POST /v1/tx/set-feed-publishers  { authority, baseMint, publishers: [address], minMatched }
// Recurring series
//   POST /v1/tx/create-series        { authority, seriesId, baseMint, quoteMint, baseTokenProgram, quoteTokenProgram, config }
//   POST /v1/tx/spawn-next           { series, payer, feed? }  -> { cross, transaction, signers }
//   POST /v1/tx/set-series-active    { authority, series, active }
//   POST /v1/tx/series-withdraw      { authority, series, mint, tokenProgram, to, amount }
// Reads
//   GET  /v1/crosses/:address/rules       the rules a cross carries, its draw and neutrality state, and what each rule calls for
//   GET  /v1/crosses/:address/indicative  the indicative clearing price, in coarse bands while the ending period is open
//   POST /v1/rules/check                  { ...the create-cross body, rules }  -> { ok, issues }  (no transaction)
import type { FastifyInstance, FastifyReply } from 'fastify';
import { type Address, createNoopSigner } from '@solana/kit';
import {
  type RuledCrossView,
  CROSS_DISCRIMINATOR,
  CrossState,
  CHALLENGE_DEPOSIT_LAMPORTS,
  FLAG_FEEDS_LENDERS,
  FLAG_GUARD_SCALED_UI,
  FLAG_RESUMES_HALT,
  FLAG_STANDARD_GRID,
  Disclosure,
  OrderSide,
  buildChallengeInsider,
  buildCloseApplicant,
  buildCreateSeries,
  buildDrawBegin,
  buildDrawFinish,
  buildExpireChallenge,
  buildInitHaltState,
  buildInitPrintFeed,
  buildObservePrice,
  buildPlaceOrder,
  buildPushRefunds,
  buildReleaseLocked,
  buildResolveChallenge,
  buildSeriesWithdraw,
  buildSetArbiter,
  buildSetCorporateAction,
  buildSetFeedPublishers,
  buildSetHalt,
  buildSetSeriesActive,
  buildSettleBook,
  buildSpawnNext,
  buildSyncPause,
  checkRules,
  coarseIndicative,
  paddedRules,
  drawProgress,
  drawPurpose,
  getChallengeDecoder,
  getLockupDecoder,
  getOrderDecoder,
  getSeriesDecoder,
  lockupAddress,
  orderAddress,
  orderPlacement,
  readRuledCross,
  usesClassBook,
  usesLocks,
  needsDraw,
  cancelDeadline,
  auxShardIndexesFor,
  CROSS_CORE_PROGRAM_ADDRESS,
  ORDER_DISCRIMINATOR,
  SERIES_DISCRIMINATOR,
  CHALLENGE_DISCRIMINATOR,
  LOCKUP_DISCRIMINATOR,
  challengeAddress,
} from '@opening-cross/sdk';
import { loadBook } from '@opening-cross/router';
import { referenceClearCapped } from '@opening-cross/verifier';
import { withChain } from '../chain-context.js';
import { createSafety, gate } from '../safety.js';
import { type Lifetime, RequestError, compile, createRuledCrossTxs } from '../tx.js';
import { addr, bool, hex32, i64, int, json, list, obj, only, opt, u64 } from './_inputs.js';
import { parseCreateParams, parseRules } from './rules-input.js';

type ChainAccount = { data: Uint8Array; owner: Address };

export type RulesTxDeps = {
  account: (a: Address) => Promise<ChainAccount | null>;
  lifetime: () => Promise<Lifetime>;
  network?: string;
  /** Unix seconds; defaults to the wall clock. Tests inject one. */
  clock?: () => number;
};

const send = (reply: FastifyReply, v: unknown, status = 200) => reply.code(status).type('application/json').send(json(v));
const CLOCK_SYSVAR = 'SysvarC1ock11111111111111111111111111111111' as Address;

const FLAG_NAMES: [number, string][] = [
  [FLAG_RESUMES_HALT, 'resumesHalt'],
  [FLAG_FEEDS_LENDERS, 'feedsLenders'],
  [FLAG_STANDARD_GRID, 'standardGrid'],
  [FLAG_GUARD_SCALED_UI, 'guardScaledUi'],
];
const NO_PRINT = ['NoCross', 'BelowMinimumVolume', 'ImbalanceTooHigh', 'SettlementExpired', 'OracleDivergence', 'OracleUnavailable', 'BelowMinimumRaise', 'FloatTooLow', 'FdvTooHigh', 'PriceMoved', 'Halted', 'CorporateAction', 'IssuerPaused', 'OracleDisagreement'];

export function registerRulesTx(app: FastifyInstance, d: RulesTxDeps): void {
  const now = () => BigInt(d.clock?.() ?? Math.floor(Date.now() / 1000));
  const safety = createSafety({ account: d.account, ...(d.clock && { now: () => d.clock!() * 1000 }) });

  // Every request runs inside a chain reader, so that the builders behind POST /v1/tx/settle and /v1/tx/finalize (server.ts) can read the
  // rules tail of the cross they build for. See chain-context.ts.
  app.addHook('onRequest', (_req, _reply, done) => {
    withChain(d.account, done, d.clock);
  });

  async function readCross(a: Address): Promise<RuledCrossView> {
    const acct = await d.account(a);
    if (!acct) throw new RequestError(404, `cross ${a} not found on chain`);
    if (acct.owner !== CROSS_CORE_PROGRAM_ADDRESS || acct.data.length < 8 || !(CROSS_DISCRIMINATOR as Uint8Array).every((b, i) => acct.data[i] === b)) throw new RequestError(404, `${a} is not an Opening Cross account`);
    return readRuledCross(a, acct.data);
  }
  const mustHaveRules = (c: RuledCrossView, what: string) => {
    if (!c.ext) throw new RequestError(422, `This cross has no rules, so ${what} does not apply to it.`, { reason: 'NO_RULES' });
    return c.ext;
  };
  async function slotNow(): Promise<bigint | null> {
    const clock = await d.account(CLOCK_SYSVAR).catch(() => null);
    return clock && clock.data.length >= 8 ? new DataView(clock.data.buffer, clock.data.byteOffset).getBigUint64(0, true) : null;
  }

  // ---------------------------------------------------------------- creating
  const mintGate = async (params: ReturnType<typeof parseCreateParams>) => {
    const warnings: Awaited<ReturnType<typeof safety.get>>['risks'] = [];
    for (const [role, mint] of [['base', params.baseMint], ['quote', params.quoteMint]] as const) {
      if (!mint) continue; // a deferred-mint cross has no base mint yet
      let v;
      try {
        v = await safety.get(mint);
      } catch (e) {
        if (e instanceof RequestError && (e.status === 404 || e.status === 422)) {
          throw new RequestError(422, `${role} mint ${mint}: ${e.message}`, { reason: e.status === 404 ? 'MINT_NOT_FOUND' : 'NOT_A_TOKEN_MINT', role, mint });
        }
        throw e;
      }
      const { blockers, warnings: soft } = gate(v);
      if (blockers.length > 0) throw new RequestError(422, `${role} mint ${mint} cannot be used in a cross: ${blockers.map((r) => r.message).join(' ')}`, { reason: 'MINT_NOT_CROSSABLE', code: blockers[0]!.code, role, mint, blockers });
      warnings.push(...soft.map((r) => ({ ...r, message: `${role} mint: ${r.message}` })));
    }
    return warnings;
  };
  const issuesOf = (params: ReturnType<typeof parseCreateParams>, rules: ReturnType<typeof parseRules>) =>
    checkRules(
      {
        supplyMode: params.supplyMode,
        minPrice: params.minPrice,
        tick: params.tick,
        ticks: params.ticks,
        openTs: params.openTs,
        closeTs: params.closeTs,
        referencePrice: params.referencePrice,
        gateMint: params.gateMint,
        oracleFeedId: params.oracle ? params.oracle.feedId : null,
        calendar: params.calendar,
      },
      rules,
    );

  app.post('/v1/rules/check', async (req, reply) => {
    const b = obj(req.body);
    const params = parseCreateParams(b);
    const issues = issuesOf(params, b.rules === undefined ? {} : parseRules(b.rules));
    return send(reply, { ok: issues.length === 0, issues });
  });

  app.post('/v1/tx/create-cross-ruled', async (req, reply) => {
    const b = obj(req.body);
    const { feed: feedRaw, rules: rulesRaw, ...createBody } = b;
    const params = parseCreateParams(createBody);
    const rules = rulesRaw === undefined || rulesRaw === null ? undefined : parseRules(rulesRaw);
    const feed = opt(feedRaw, (x) => addr(x, 'feed'));
    if (rules) {
      const issues = issuesOf(params, rules);
      if (issues.length > 0) throw new RequestError(422, `The rules cannot be created: ${issues.map((i) => `${i.field}: ${i.message}`).join(' ')}`, { reason: 'RULES_INVALID', issues });
    }
    const warnings = await mintGate(params);
    const out = await createRuledCrossTxs({ ...(params as Record<string, unknown>), ...(rules ? { rules } : {}), ...(feed ? { feed } : {}) } as Parameters<typeof createRuledCrossTxs>[0], await d.lifetime());
    return send(reply, { ...out, rules: rules ?? null, issues: [], warnings });
  });

  // ---------------------------------------------------------------- trading
  app.post('/v1/tx/place-order-ext', async (req, reply) => {
    const b = obj(req.body);
    const cross = await readCross(addr(b.cross, 'cross'));
    if (cross.data.state !== CrossState.Live) throw new RequestError(409, 'cross is not accepting orders');
    const owner = addr(b.owner, 'owner');
    const nonce = u64(b.nonce, 'nonce');
    const side = b.side === 'buy' ? OrderSide.Buy : b.side === 'sell' ? OrderSide.Sell : (() => { throw new RequestError(400, 'side must be "buy" or "sell"'); })();
    const cls = b.class === undefined ? 0 : int(b.class, 'class', 3);
    const lockSecs = b.lockSecs === undefined ? 0 : int(b.lockSecs, 'lockSecs', 0xffff_ffff);
    const x = cross.ext;
    if (!x && (cls !== 0 || lockSecs !== 0)) throw new RequestError(422, 'this cross has no rules, so it takes no allocation class and no lockup', { reason: 'NO_RULES' });
    if (side === OrderSide.Sell && (cls !== 0 || lockSecs !== 0)) throw new RequestError(422, 'allocation classes and lockups apply to buy orders only', { reason: 'CLASS_FOR_SELL' });
    if (x) {
      if (cls === 1 && x.alloc.smallCapQuote === 0n) throw new RequestError(422, 'this cross reserves nothing for small verified buyers (class 1)', { reason: 'CLASS_UNAVAILABLE' });
      if (cls === 2 && lockSecs < x.alloc.minLockSecs) throw new RequestError(422, `a class-2 buyer accepts a lockup of at least ${x.alloc.minLockSecs} seconds`, { reason: 'LOCK_TOO_SHORT', minLockSecs: x.alloc.minLockSecs });
      if (cls !== 2 && lockSecs !== 0) throw new RequestError(422, 'a lockup is accepted by class 2 only', { reason: 'LOCK_NEEDS_CLASS_2' });
      if (cls === 3 && x.alloc.reserveBps[2] === 0) throw new RequestError(422, 'this cross reserves nothing for priority buyers (class 3)', { reason: 'CLASS_UNAVAILABLE' });
    }
    if (await d.account(await orderAddress(cross.address, owner, nonce))) throw new RequestError(409, `nonce ${nonce} is already used by this owner in this cross`);
    const salt = opt(b.salt, (v) => hex32(v, 'salt'));
    if (cross.data.disclosure === Disclosure.Sealed && !salt) throw new RequestError(400, 'sealed cross: provide a 32-byte hex salt and keep it for the reveal');
    const escrow = opt(b.escrow, (v) => u64(v, 'escrow'));
    const at = now();
    const ix = await buildPlaceOrder({
      cross,
      owner: createNoopSigner(owner),
      nonce,
      side,
      price: u64(b.price, 'price'),
      quantity: u64(b.quantity, 'quantity'),
      ...(escrow !== null && { escrow }),
      ...(salt && { salt }),
      class: cls,
      lockSecs,
      now: at,
    }).catch((e: Error) => {
      throw new RequestError(400, e.message);
    });
    const placement = orderPlacement(cross, owner, nonce, at);
    let validUntil: bigint | null = null;
    if (x && x.ending.endingSecs > 0 && placement.bucket !== 255) {
      const start = cross.data.closeTs - BigInt(x.ending.endingSecs);
      const end = start + (BigInt(placement.bucket + 1) * BigInt(x.ending.endingSecs) + BigInt(x.ending.buckets) - 1n) / BigInt(x.ending.buckets);
      validUntil = placement.bucket === x.ending.buckets - 1 ? cross.data.closeTs - 1n : end - 1n;
    } else if (x && x.ending.endingSecs > 0) {
      validUntil = cross.data.closeTs - BigInt(x.ending.endingSecs) - 1n;
    }
    return send(reply, { ...compile(owner, [ix], await d.lifetime()), order: await orderAddress(cross.address, owner, nonce), placement: { ...placement, validUntil, cancelDeadline: x ? cancelDeadline(x, cross.data.closeTs) : cross.data.closeTs } });
  });

  app.post('/v1/tx/settle-ext', async (req, reply) => {
    const b = obj(req.body);
    const cross = await readCross(addr(b.cross, 'cross'));
    if (cross.data.state !== CrossState.Live) throw new RequestError(409, 'cross is already settled');
    const oraclePrice = opt(b.oraclePrice, (v) => addr(v, 'oraclePrice'));
    const oracleAccounts = opt(b.oracleAccounts, (v) => list(v, 'oracleAccounts', 2, (a, i) => addr(a, `oracleAccounts[${i}]`)));
    const payer = addr(b.payer, 'payer');
    const ixs = await buildSettleBook(cross, { ...(oraclePrice ? { oraclePrice } : {}), ...(oracleAccounts ? { oracleAccounts } : {}), now: now() }).catch((e: Error) => {
      throw new RequestError(400, e.message, /^DrawRequired/.test(e.message) ? { reason: 'DRAW_REQUIRED' } : undefined);
    });
    const lt = await d.lifetime();
    return send(reply, { transactions: ixs.map((ix) => compile(payer, [ix], lt)) });
  });

  // ---------------------------------------------------------------- the draw
  app.post('/v1/tx/draw-begin', async (req, reply) => {
    const b = obj(req.body);
    const cross = await readCross(addr(b.cross, 'cross'));
    const x = mustHaveRules(cross, 'a draw');
    if (cross.data.state !== CrossState.Live) throw new RequestError(409, 'cross is already settled', { reason: 'NOT_LIVE' });
    const purpose = drawPurpose(x, cross.data.revealEndTs, now());
    if (!purpose) {
      throw new RequestError(409, needsDraw(x) && now() < cross.data.revealEndTs ? `The draw can begin once the reveal window ends, at ${cross.data.revealEndTs}.` : 'Nothing is waiting for a draw.', { reason: 'NOTHING_TO_DRAW', revealEndTs: cross.data.revealEndTs });
    }
    const slot = await slotNow();
    if (x.draw.pendingSlot > 0n && slot !== null && drawProgress(x, slot) !== 'void') throw new RequestError(409, 'A draw has begun already; finish it, or wait for it to lapse and begin again.', { reason: 'DRAW_PENDING', pendingSlot: x.draw.pendingSlot });
    return send(reply, { ...compile(addr(b.payer, 'payer'), [buildDrawBegin(cross.address)], await d.lifetime()), purpose });
  });

  app.post('/v1/tx/draw-finish', async (req, reply) => {
    const b = obj(req.body);
    const cross = await readCross(addr(b.cross, 'cross'));
    const x = mustHaveRules(cross, 'a draw');
    if (cross.data.state !== CrossState.Live) throw new RequestError(409, 'cross is already settled', { reason: 'NOT_LIVE' });
    if (x.draw.pendingSlot === 0n) throw new RequestError(409, 'No draw has begun. Send draw-begin first.', { reason: 'NO_DRAW_PENDING' });
    const earliestSlot = x.draw.pendingSlot + 20n;
    const slot = await slotNow();
    const progress = slot === null ? null : drawProgress(x, slot);
    if (progress === 'waiting') throw new RequestError(409, `The draw finishes at slot ${earliestSlot} or later (now ${slot}).`, { reason: 'DRAW_TOO_EARLY', earliestSlot, slot });
    if (progress === 'void') throw new RequestError(409, 'The draw lapsed before it was finished; begin it again.', { reason: 'DRAW_VOID', pendingSlot: x.draw.pendingSlot });
    return send(reply, { ...compile(addr(b.payer, 'payer'), [buildDrawFinish(cross.address)], await d.lifetime()), purpose: x.draw.pendingPurpose === 1 ? 'end' : 'extension', earliestSlot });
  });

  // ---------------------------------------------------------------- after the clear
  app.post('/v1/tx/release-locked', async (req, reply) => {
    const b = obj(req.body);
    const cross = await readCross(addr(b.cross, 'cross'));
    const owner = addr(b.owner, 'owner');
    const nonce = u64(b.nonce, 'nonce');
    const payer = opt(b.payer, (v) => addr(v, 'payer')) ?? owner;
    const lockAddress = await lockupAddress(cross.address, owner, nonce);
    const acct = await d.account(lockAddress);
    if (!acct || acct.owner !== CROSS_CORE_PROGRAM_ADDRESS || !(LOCKUP_DISCRIMINATOR as Uint8Array).every((v, i) => acct.data[i] === v)) throw new RequestError(404, `no lockup for owner ${owner} with nonce ${nonce} in cross ${cross.address}: it was never created, or it has been released in full`, { reason: 'NO_LOCKUP' });
    const lock = getLockupDecoder().decode(acct.data);
    const releasable = releasableOf(lock, now());
    if (releasable === 0n) throw new RequestError(409, `Nothing has vested yet. The first release is at ${lock.startTs + BigInt(lock.cliffSecs)}.`, { reason: 'NOTHING_VESTED', unlocksAt: lock.startTs + BigInt(lock.cliffSecs) });
    const ixs = await buildReleaseLocked(cross, createNoopSigner(payer), owner, nonce);
    return send(reply, { ...compile(payer, ixs, await d.lifetime()), releasable, lockup: lockAddress });
  });

  app.post('/v1/tx/push-refunds', async (req, reply) => {
    const b = obj(req.body);
    const cross = await readCross(addr(b.cross, 'cross'));
    if (cross.data.state === CrossState.Live) throw new RequestError(409, 'cross has not settled yet', { reason: 'LIVE' });
    const orders = list(b.orders, 'orders', 12, (o, i) => {
      const r = obj(o, `orders[${i}]`);
      return { owner: addr(r.owner, `orders[${i}].owner`), nonce: u64(r.nonce, `orders[${i}].nonce`) };
    });
    if (orders.length === 0) throw new RequestError(400, 'orders must name at least one order');
    const withSide = [];
    for (const o of orders) {
      const a = await d.account(await orderAddress(cross.address, o.owner, o.nonce));
      if (!a || a.owner !== CROSS_CORE_PROGRAM_ADDRESS || !(ORDER_DISCRIMINATOR as Uint8Array).every((v, i) => a.data[i] === v)) throw new RequestError(404, `no open order for owner ${o.owner} with nonce ${o.nonce} in cross ${cross.address}`, { reason: 'NO_ORDER' });
      withSide.push({ ...o, side: getOrderDecoder().decode(a.data).side });
    }
    const ix = await buildPushRefunds(cross, withSide);
    return send(reply, { ...compile(addr(b.payer, 'payer'), [ix], await d.lifetime()), orders: withSide.length });
  });

  app.post('/v1/tx/close-applicant', async (req, reply) => {
    const b = obj(req.body);
    const cross = await readCross(addr(b.cross, 'cross'));
    const owner = addr(b.owner, 'owner');
    return send(reply, compile(opt(b.payer, (v) => addr(v, 'payer')) ?? owner, [await buildCloseApplicant(cross.address, owner)], await d.lifetime()));
  });

  // ---------------------------------------------------------------- issuer neutrality
  app.post('/v1/tx/challenge-insider', async (req, reply) => {
    const b = obj(req.body);
    const cross = await readCross(addr(b.cross, 'cross'));
    const x = mustHaveRules(cross, 'a challenge');
    if (x.neutrality.insiderCount === 0 && x.neutrality.bondQuote === 0n) throw new RequestError(422, 'This cross declared no insiders and posted no bond, so there is nothing to challenge.', { reason: 'NO_BOND' });
    const challenger = addr(b.challenger, 'challenger');
    const subject = addr(b.subject, 'subject');
    const evidence = hex32(b.evidence, 'evidence');
    const id = x.neutralState.challenges;
    const ix = await buildChallengeInsider({ cross: cross.address, challenger: createNoopSigner(challenger), id, subject, evidence });
    return send(reply, { ...compile(challenger, [ix], await d.lifetime()), id, challenge: await challengeAddress(cross.address, id), depositLamports: CHALLENGE_DEPOSIT_LAMPORTS });
  });

  const challengeOf = async (cross: RuledCrossView, id: number) => {
    const a = await d.account(await challengeAddress(cross.address, id));
    if (!a || a.owner !== CROSS_CORE_PROGRAM_ADDRESS || !(CHALLENGE_DISCRIMINATOR as Uint8Array).every((v, i) => a.data[i] === v)) throw new RequestError(404, `cross ${cross.address} has no challenge ${id}`, { reason: 'NO_CHALLENGE' });
    return getChallengeDecoder().decode(a.data);
  };

  app.post('/v1/tx/resolve-challenge', async (req, reply) => {
    const b = obj(req.body);
    const cross = await readCross(addr(b.cross, 'cross'));
    mustHaveRules(cross, 'a challenge');
    const id = int(b.id, 'id', 0xffff_ffff);
    const ch = await challengeOf(cross, id);
    if (ch.status !== 0) throw new RequestError(409, 'This challenge is already ruled on.', { reason: 'ALREADY_RESOLVED' });
    const upheld = bool(b.upheld, 'upheld');
    const slash = b.slash === undefined ? 0n : u64(b.slash, 'slash');
    const bond = cross.ext!.neutralState.bondHeld;
    if (upheld && slash > bond) throw new RequestError(422, `A slash is at most the bond held (${bond}).`, { reason: 'SLASH_OVER_BOND', bondHeld: bond });
    if (!upheld && slash !== 0n) throw new RequestError(422, 'A rejected challenge slashes nothing.', { reason: 'SLASH_ON_REJECT' });
    const arbiter = addr(b.arbiter, 'arbiter');
    const ix = await buildResolveChallenge({ cross, arbiter: createNoopSigner(arbiter), id, challenger: ch.challenger, feeRecipient: cross.data.feeRecipient, upheld, slash });
    return send(reply, compile(arbiter, [ix], await d.lifetime()));
  });

  app.post('/v1/tx/expire-challenge', async (req, reply) => {
    const b = obj(req.body);
    const cross = await readCross(addr(b.cross, 'cross'));
    mustHaveRules(cross, 'a challenge');
    const id = int(b.id, 'id', 0xffff_ffff);
    const ch = await challengeOf(cross, id);
    if (ch.status !== 0) throw new RequestError(409, 'This challenge is already ruled on.', { reason: 'ALREADY_RESOLVED' });
    const ix = await buildExpireChallenge({ cross: cross.address, id, challenger: ch.challenger });
    return send(reply, compile(addr(b.payer, 'payer'), [ix], await d.lifetime()));
  });

  app.post('/v1/tx/set-arbiter', async (req, reply) => {
    const b = obj(req.body);
    const admin = addr(b.admin, 'admin');
    return send(reply, compile(admin, [await buildSetArbiter(createNoopSigner(admin), addr(b.arbiter, 'arbiter'))], await d.lifetime()));
  });

  // ---------------------------------------------------------------- halt states and the lender feed
  const mintExists = async (mint: Address, what: string) => {
    if (!(await d.account(mint))) throw new RequestError(404, `no account exists at the ${what} ${mint}`, { reason: 'MINT_NOT_FOUND' });
  };

  app.post('/v1/tx/init-halt-state', async (req, reply) => {
    const b = obj(req.body);
    const authority = addr(b.authority, 'authority');
    const baseMint = addr(b.baseMint, 'baseMint');
    await mintExists(baseMint, 'base mint');
    const breaker = opt(b.breaker, (v) => {
      const r = obj(v, 'breaker');
      only(r, ['feedId', 'windowSlots', 'moveBps'], 'breaker');
      return { feedId: hex32(r.feedId, 'breaker.feedId'), windowSlots: int(r.windowSlots, 'breaker.windowSlots', 0xffff_ffff, 1), moveBps: int(r.moveBps, 'breaker.moveBps', 0xffff_ffff, 1) };
    });
    const built = await buildInitHaltState({ authority: createNoopSigner(authority), baseMint, venueSigner: opt(b.venueSigner, (v) => addr(v, 'venueSigner')), breaker });
    if (await d.account(built.halt)) throw new RequestError(409, `a halt state already exists for ${baseMint}: ${built.halt}`, { reason: 'HALT_EXISTS', halt: built.halt });
    return send(reply, { ...compile(authority, [built.instruction], await d.lifetime()), halt: built.halt });
  });

  app.post('/v1/tx/set-halt', async (req, reply) => {
    const b = obj(req.body);
    const signer = addr(b.signer, 'signer');
    return send(reply, compile(signer, [await buildSetHalt(createNoopSigner(signer), addr(b.baseMint, 'baseMint'))], await d.lifetime()));
  });
  app.post('/v1/tx/set-corporate-action', async (req, reply) => {
    const b = obj(req.body);
    const signer = addr(b.signer, 'signer');
    return send(reply, compile(signer, [await buildSetCorporateAction(createNoopSigner(signer), addr(b.baseMint, 'baseMint'), bool(b.flag, 'flag'))], await d.lifetime()));
  });
  app.post('/v1/tx/sync-pause', async (req, reply) => {
    const b = obj(req.body);
    return send(reply, compile(addr(b.payer, 'payer'), [await buildSyncPause(addr(b.baseMint, 'baseMint'))], await d.lifetime()));
  });
  app.post('/v1/tx/observe-price', async (req, reply) => {
    const b = obj(req.body);
    return send(reply, compile(addr(b.payer, 'payer'), [await buildObservePrice(addr(b.baseMint, 'baseMint'), addr(b.priceUpdate, 'priceUpdate'))], await d.lifetime()));
  });
  const publishers = (v: unknown) => {
    const p = list(v, 'publishers', 4, (x, i) => addr(x, `publishers[${i}]`));
    if (p.length === 0) throw new RequestError(400, 'publishers must name at least one wallet');
    if (new Set(p).size !== p.length) throw new RequestError(400, 'a publisher is listed once');
    return p;
  };
  app.post('/v1/tx/init-print-feed', async (req, reply) => {
    const b = obj(req.body);
    const authority = addr(b.authority, 'authority');
    const built = await buildInitPrintFeed({ authority: createNoopSigner(authority), baseMint: addr(b.baseMint, 'baseMint'), quoteMint: addr(b.quoteMint, 'quoteMint'), publishers: publishers(b.publishers), minMatched: u64(b.minMatched ?? '0', 'minMatched') });
    if (await d.account(built.feed)) throw new RequestError(409, `a print feed already exists for this base mint: ${built.feed}`, { reason: 'FEED_EXISTS', feed: built.feed });
    return send(reply, { ...compile(authority, [built.instruction], await d.lifetime()), feed: built.feed });
  });
  app.post('/v1/tx/set-feed-publishers', async (req, reply) => {
    const b = obj(req.body);
    const authority = addr(b.authority, 'authority');
    return send(reply, compile(authority, [await buildSetFeedPublishers({ authority: createNoopSigner(authority), baseMint: addr(b.baseMint, 'baseMint'), publishers: publishers(b.publishers), minMatched: u64(b.minMatched ?? '0', 'minMatched') })], await d.lifetime()));
  });

  // ---------------------------------------------------------------- series
  const seriesOf = async (a: Address) => {
    const acct = await d.account(a);
    if (!acct || acct.owner !== CROSS_CORE_PROGRAM_ADDRESS || !(SERIES_DISCRIMINATOR as Uint8Array).every((v, i) => acct.data[i] === v)) throw new RequestError(404, `no series at ${a}`, { reason: 'NO_SERIES' });
    return { address: a, data: getSeriesDecoder().decode(acct.data) };
  };
  app.post('/v1/tx/create-series', async (req, reply) => {
    const b = obj(req.body);
    const authority = addr(b.authority, 'authority');
    const config = parseSeriesConfig(obj(b.config, 'config'));
    const built = await buildCreateSeries({
      authority: createNoopSigner(authority),
      seriesId: u64(b.seriesId, 'seriesId'),
      baseMint: addr(b.baseMint, 'baseMint'),
      quoteMint: addr(b.quoteMint, 'quoteMint'),
      baseTokenProgram: addr(b.baseTokenProgram, 'baseTokenProgram'),
      quoteTokenProgram: addr(b.quoteTokenProgram, 'quoteTokenProgram'),
      config,
    });
    if (await d.account(built.series)) throw new RequestError(409, `a series with this id already exists: ${built.series}`, { reason: 'SERIES_EXISTS', series: built.series });
    return send(reply, { ...compile(authority, built.instructions, await d.lifetime()), series: built.series });
  });
  app.post('/v1/tx/spawn-next', async (req, reply) => {
    const b = obj(req.body);
    const series = await seriesOf(addr(b.series, 'series'));
    if (!series.data.active) throw new RequestError(409, 'This series is paused.', { reason: 'SERIES_PAUSED' });
    if (series.data.config.maxCrosses > 0n && series.data.nextIndex >= series.data.config.maxCrosses) throw new RequestError(409, 'This series has run its last cross.', { reason: 'SERIES_DONE' });
    const payer = addr(b.payer, 'payer');
    const built = await buildSpawnNext(series, createNoopSigner(payer), { feed: b.feed === undefined ? false : bool(b.feed, 'feed') });
    return send(reply, { ...compile(payer, [built.instruction], await d.lifetime()), cross: built.cross });
  });
  app.post('/v1/tx/set-series-active', async (req, reply) => {
    const b = obj(req.body);
    const authority = addr(b.authority, 'authority');
    return send(reply, compile(authority, [buildSetSeriesActive(createNoopSigner(authority), addr(b.series, 'series'), bool(b.active, 'active'))], await d.lifetime()));
  });
  app.post('/v1/tx/series-withdraw', async (req, reply) => {
    const b = obj(req.body);
    const authority = addr(b.authority, 'authority');
    const series = await seriesOf(addr(b.series, 'series'));
    if (series.data.authority !== authority) throw new RequestError(422, `Only the series' authority, ${series.data.authority}, can withdraw from it.`, { reason: 'NOT_THE_AUTHORITY' });
    const amount = u64(b.amount, 'amount');
    if (amount === 0n) throw new RequestError(400, 'amount must be above zero');
    const ix = await buildSeriesWithdraw({ authority: createNoopSigner(authority), series, mint: addr(b.mint, 'mint'), tokenProgram: addr(b.tokenProgram, 'tokenProgram'), to: addr(b.to, 'to'), amount });
    return send(reply, compile(authority, [ix], await d.lifetime()));
  });

  // ---------------------------------------------------------------- reads
  app.get('/v1/crosses/:address/rules', async (req, reply) => {
    const a = addr((req.params as { address: string }).address, 'address');
    const c = await readCross(a);
    const x = c.ext;
    if (!x) return send(reply, { cross: a, rules: null, note: 'This cross has no rules: it was created by the program as deployed before the rules extension, or its creator never set any.' });
    const slot = await slotNow();
    const at = now();
    const purpose = c.data.state === CrossState.Live ? drawPurpose(x, c.data.revealEndTs, at) : null;
    return send(reply, {
      cross: a,
      rules: {
        flags: Object.fromEntries(FLAG_NAMES.map(([bit, name]) => [name, (x.flags & bit) !== 0])),
        guards: { ...x.guards, haltSource: x.guards.haltSource.__option === 'Some' ? x.guards.haltSource.value : null },
        ending: x.ending,
        identity: x.identity,
        alloc: { ...x.alloc, priorityGate: x.alloc.priorityGate.__option === 'Some' ? x.alloc.priorityGate.value : null },
        neutrality: { ...x.neutrality, insiders: x.neutrality.insiders.slice(0, x.neutrality.insiderCount) },
        referral: x.referral.shareBps > 0 ? x.referral : null,
        oracleSet: { ...x.oracleSet, extraFeeds: x.oracleSet.extraFeeds.slice(0, x.oracleSet.extraCount).map((f) => Buffer.from(f).toString('hex')) },
      },
      state: {
        draw: { epoch: x.draw.epoch, seedReady: x.draw.seedReady, endBucket: x.draw.endBucket === 255 ? null : x.draw.endBucket, extensionPending: x.draw.extPending, extensionUsed: x.draw.extensionUsed, pendingSlot: x.draw.pendingSlot > 0n ? x.draw.pendingSlot : null },
        neutrality: x.neutralState,
        clearing: c.data.state === CrossState.Live ? null : x.clearing,
        noPrintReason: c.data.noPrintReason.__option === 'Some' ? (NO_PRINT[c.data.noPrintReason.value] ?? `Unknown(${c.data.noPrintReason.value})`) : null,
      },
      calls: {
        classBook: usesClassBook(x),
        lockVault: usesLocks(x),
        needsDraw: needsDraw(x),
        drawOwed: purpose,
        drawStatus: slot !== null && x.draw.pendingSlot > 0n ? drawProgress(x, slot) : x.draw.pendingSlot > 0n ? 'unknown' : 'not-begun',
        auxShards: auxShardIndexesFor(x.ending, c.data.shards),
        cancelDeadline: cancelDeadline(x, c.data.closeTs),
        endingStartsAt: x.ending.endingSecs > 0 ? c.data.closeTs - BigInt(x.ending.endingSecs) : null,
      },
    });
  });

  app.get('/v1/crosses/:address/indicative', async (req, reply) => {
    const a = addr((req.params as { address: string }).address, 'address');
    const c = await readCross(a);
    if (c.data.state !== CrossState.Live) throw new RequestError(409, 'The cross has settled: read the clearing from /v1/crosses/:address.', { reason: 'NOT_LIVE' });
    const x = c.ext;
    const at = now();
    const book = await loadBook(d.account, a, c.data);
    if (typeof book === 'string') return send(reply, { cross: a, phase: 'no-book', note: `This cross has no order book on chain, so it holds no orders (${book}).`, indicative: null });
    const orders = [];
    for (let i = 0; i < c.data.ticks; i++) {
      const price = c.data.minPrice + BigInt(i) * c.data.tick;
      if (book.buy[i]! > 0n) orders.push({ side: 'buy' as const, price, quantity: book.buy[i]! });
      if (book.sell[i]! > 0n) orders.push({ side: 'sell' as const, price, quantity: book.sell[i]! });
    }
    const cap = x && x.guards.maxMatched > 0n ? x.guards.maxMatched : null;
    const r = referenceClearCapped(orders, { min: c.data.minPrice, tick: c.data.tick, ticks: c.data.ticks }, c.data.referencePrice.__option === 'Some' ? c.data.referencePrice.value : null, cap);
    const endingOpen = !!x && x.ending.endingSecs > 0 && at >= c.data.closeTs - BigInt(x.ending.endingSecs) && at < c.data.closeTs;
    const sealed = c.data.disclosure === Disclosure.Sealed;
    const note = sealed
      ? 'Sealed bids carry no price until they are revealed; only revealed orders appear here.'
      : endingOpen
        ? 'The ending period is open: the price is shown to the nearest of eight bands and the imbalance as a direction only. The chain account is public, so this is the display rule for our apps, not secrecy; a cross that needs hidden books is sealed.'
        : 'Indicative until the call closes: later orders can move it.';
    if (!r) return send(reply, { cross: a, phase: endingOpen ? 'ending' : 'open', coarse: endingOpen, indicative: null, note });
    if (endingOpen) {
      const coarse = coarseIndicative({ minPrice: c.data.minPrice, tick: c.data.tick, ticks: c.data.ticks, price: r.price, demand: r.demand, supply: r.supply });
      return send(reply, { cross: a, phase: 'ending', coarse: true, indicative: { price: coarse.price, imbalance: coarse.imbalance }, endsAt: c.data.closeTs, note });
    }
    return send(reply, { cross: a, phase: 'open', coarse: false, indicative: { price: r.price, matched: r.matched, imbalance: r.demand > r.supply ? 'demand-heavy' : r.supply > r.demand ? 'supply-heavy' : 'balanced' }, note });
  });
}

/** `Lockup::releasable` (programs/cross_core/src/lock.rs). */
export function releasableOf(l: { amount: bigint; released: bigint; startTs: bigint; cliffSecs: number; vestSecs: number }, now: bigint): bigint {
  const unlock = l.startTs + BigInt(l.cliffSecs);
  let vested: bigint;
  if (now < unlock) vested = 0n;
  else if (l.vestSecs === 0) vested = l.amount;
  else {
    const part = (l.amount * (now - unlock)) / BigInt(l.vestSecs);
    vested = part > l.amount ? l.amount : part;
  }
  return vested > l.released ? vested - l.released : 0n;
}

/** A series' configuration as JSON: the creation parameters every cross it spawns shares, and the rules each carries. */
function parseSeriesConfig(c: Record<string, unknown>) {
  only(c, ['kind', 'disclosure', 'priceScale', 'grid', 'startTs', 'intervalSecs', 'calendar', 'callSecs', 'revealSecs', 'minMatched', 'maxImbalanceBps', 'integratorFeeBps', 'integrator', 'gateMint', 'shards', 'maxOrders', 'proceedsTo', 'oracle', 'maxCrosses', 'rules'], 'config');
  const names = (v: unknown, field: string, set: readonly string[]) => {
    const i = set.indexOf(String(v));
    if (i < 0) throw new RequestError(400, `${field} must be one of ${set.join(', ')}`);
    return i;
  };
  const g = obj(c.grid, 'config.grid');
  only(g, ['relative', 'minPrice', 'tick', 'ticks', 'tickBps', 'center'], 'config.grid');
  const i64s = (v: unknown, f: string) => i64(v, f);
  return {
    kind: names(c.kind, 'config.kind', ['launch', 'reopen', 'tender', 'recurring']),
    disclosure: names(c.disclosure, 'config.disclosure', ['sealed', 'open']),
    priceScale: u64(c.priceScale, 'config.priceScale'),
    grid: { relative: bool(g.relative, 'config.grid.relative'), minPrice: u64(g.minPrice ?? '0', 'config.grid.minPrice'), tick: u64(g.tick ?? '0', 'config.grid.tick'), ticks: int(g.ticks, 'config.grid.ticks', 65_535), tickBps: int(g.tickBps ?? 0, 'config.grid.tickBps', 65_535), center: u64(g.center ?? '0', 'config.grid.center') },
    startTs: i64s(c.startTs, 'config.startTs'),
    intervalSecs: i64s(c.intervalSecs ?? 0, 'config.intervalSecs'),
    calendar: opt(c.calendar, (v) => addr(v, 'config.calendar')),
    callSecs: i64s(c.callSecs, 'config.callSecs'),
    revealSecs: i64s(c.revealSecs, 'config.revealSecs'),
    minMatched: u64(c.minMatched ?? '0', 'config.minMatched'),
    maxImbalanceBps: opt(c.maxImbalanceBps, (v) => int(v, 'config.maxImbalanceBps', 10_000)),
    integratorFeeBps: int(c.integratorFeeBps ?? 0, 'config.integratorFeeBps', 300),
    integrator: addr(c.integrator, 'config.integrator'),
    gateMint: opt(c.gateMint, (v) => addr(v, 'config.gateMint')),
    shards: int(c.shards, 'config.shards', 32),
    maxOrders: int(c.maxOrders, 'config.maxOrders', 1_000_000),
    proceedsTo: addr(c.proceedsTo, 'config.proceedsTo'),
    oracle: opt(c.oracle, (o) => {
      const r = obj(o, 'config.oracle');
      return { feedId: hex32(r.feedId, 'config.oracle.feedId'), maxDivergenceBps: int(r.maxDivergenceBps, 'config.oracle.maxDivergenceBps', 10_000), maxStalenessSecs: int(r.maxStalenessSecs, 'config.oracle.maxStalenessSecs', 86_400) };
    }),
    maxCrosses: u64(c.maxCrosses ?? '0', 'config.maxCrosses'),
    rules: paddedRules(c.rules === undefined ? {} : parseRules(c.rules)),
  };
}
