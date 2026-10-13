// Builders for the rules extension of cross_core (ADR-0450 to ADR-0462): creating a cross with rules, the draw, lockups,
// issuer neutrality, halt states and the lender feed, recurring series, pushed refunds and the arbiter.
//
// Every builder returns unsigned `@solana/kit` instructions, like the builders in `index.ts`. The builders of `index.ts`
// (`buildPlaceOrder`, `buildReveal`, `buildCancel`, `buildSettleBook`, `buildClaim`, `buildFinalize`) accept a cross with rules
// (`CrossView.ext`) and add the accounts its rules call for; the ones here are the instructions that exist only because of the rules.
//
// A cross created by the program that is deployed on devnet today has no rules tail: `readRuledCross` gives it `ext: null` and
// every builder treats it as a cross with every rule off. The instructions in this file need the extended program (HUMAN_TASKS H27).
import {
  type AccountMeta,
  type Address,
  type Instruction,
  type ReadonlyUint8Array,
  type TransactionSigner,
} from '@solana/kit';
import { getCreateAssociatedTokenIdempotentInstruction } from '@solana-program/token-2022';
import {
  FLAG_FEEDS_LENDERS,
  FLAG_GUARD_SCALED_UI,
  FLAG_RESUMES_HALT,
  type CrossExt,
  SLOT_HASHES,
  type SeriesConfigArgs,
  type RulesConfig,
  applicantAddress,
  arbiterRegistryAddress,
  auxShardIndexesFor,
  challengeAddress,
  classBookAddress,
  completeRules,
  getChallengeInsiderInstruction,
  getCloseApplicantInstruction,
  getCreateSeriesInstruction,
  getCrossDecoder,
  getDrawBeginInstruction,
  getDrawFinishInstruction,
  getExpireChallengeInstruction,
  getInitClassBookInstruction,
  getInitHaltStateInstruction,
  getInitLockVaultInstruction,
  getInitPrintFeedInstruction,
  getInitShardInstruction,
  getObservePriceInstruction,
  getPushRefundsInstruction,
  getReleaseLockedInstruction,
  getResolveChallengeInstruction,
  getSeriesDecoder,
  getSeriesWithdrawInstruction,
  getSetArbiterInstruction,
  getSetCorporateActionInstruction,
  getSetFeedPublishersInstruction,
  getSetHaltInstruction,
  getSetRulesInstruction,
  getSetSeriesActiveInstruction,
  getSpawnNextInstruction,
  getSyncPauseInstruction,
  haltStateAddress,
  lockVaultAddress,
  lockupAddress,
  printFeedAddress,
  readCrossExt,
  readonly,
  seriesAddress,
  usesClassBook,
  usesLocks,
  withAccounts,
  writable,
  type Series,
} from '@opening-cross/cross-core-client';
import {
  type CreateCrossInput,
  type CrossView,
  OrderSide,
  ata,
  baseVaultAddress,
  bookAddress,
  buildCreateCross,
  crossAddress,
  orderAddress,
  protocolAddress,
  quoteVaultAddress,
  shardAddress,
} from './index.js';

// ------------------------------------------------------------------ reading

/** A cross with its rules tail, as `CrossView` carries it. */
export type RuledCrossView = CrossView & { ext: CrossExt | null };

/** Decodes a cross account and its rules tail (null for a cross without rules). */
export function readRuledCross(address: Address, data: Uint8Array): RuledCrossView {
  return { address, data: getCrossDecoder().decode(data), ext: readCrossExt(data) };
}

// ------------------------------------------------------------------ creating a cross with rules

export type CreateRuledCrossInput = CreateCrossInput & {
  /** The rules, written by `set_rules` in the transaction that creates the cross. Leave out (or pass `{}`) for a cross without rules. */
  rules?: RulesConfig;
  /** Account that stands in the lender-feed slot when the rules set `FLAG_FEEDS_LENDERS`; defaults to the feed of the base mint. */
  feed?: Address;
};

export type RuledCreation = {
  cross: Address;
  /** Create the creator's quote token account if missing (the bond and `create_cross` read it): send first, on its own. */
  ensureCreatorQuote: Instruction;
  /** `create_cross` then `set_rules`: they must share one transaction, because the rules are only accepted in the slot the cross
   *  is created in. Together with the creator's signature they fit one transaction for the common rule sets (see `wireSize`). */
  atomic: Instruction[];
  create: Instruction;
  setRules: Instruction | null;
  /** The main shards (`init_shard`), one transaction each (a shard is about 6 KB). */
  shards: Instruction[];
  /** The ending-bucket and extension shards the rules call for, one transaction each. */
  auxShards: Instruction[];
  /** The class book, when the rules need one (reserved shares, a lottery, declared insiders). Absent otherwise. */
  classBook: Instruction | null;
  /** The lock vault, when the rules lock fills. Absent otherwise. */
  lockVault: Instruction | null;
};

/** The accounts `set_rules` reads after `cross`: the halt state a resume cross lifts, the lender feed, the bond accounts, the mint of
 *  a scaled-UI guard, the calendar that approves extra oracle feeds. */
export async function setRulesAccounts(input: {
  creator: Address;
  rules: ReturnType<typeof completeRules>;
  baseMint?: Address | undefined;
  quoteMint: Address;
  quoteTokenProgram: Address;
  cross: Address;
  calendar?: Address | null | undefined;
  feed?: Address | undefined;
}): Promise<AccountMeta[]> {
  const { rules: full, baseMint, quoteMint, quoteTokenProgram, cross } = input;
  const extra: AccountMeta[] = [];
  const haltSource = full.guards.haltSource;
  if ((full.flags & FLAG_RESUMES_HALT) !== 0 && haltSource) {
    const value = typeof haltSource === 'string' ? haltSource : haltSource.__option === 'Some' ? haltSource.value : null;
    if (!value) throw new Error('a resume cross names the halt state it lifts (guards.haltSource)');
    extra.push(readonly(value));
  }
  if ((full.flags & FLAG_FEEDS_LENDERS) !== 0) {
    if (!baseMint) throw new Error('a lender feed needs a base mint');
    extra.push(readonly(input.feed ?? (await printFeedAddress(baseMint))));
  }
  if (full.neutrality.bondQuote > 0n) {
    extra.push(writable(await ata(input.creator, quoteMint, quoteTokenProgram)), writable(await quoteVaultAddress(cross)), readonly(quoteMint), readonly(quoteTokenProgram));
  }
  if ((full.flags & FLAG_GUARD_SCALED_UI) !== 0) {
    if (!baseMint) throw new Error('a scaled-UI guard needs a base mint');
    extra.push(readonly(baseMint));
  }
  if (full.oracleSet.extraFeeds.length > 0 && input.calendar) extra.push(readonly(input.calendar));
  return extra;
}

/** `set_rules` for a cross created in the same transaction. */
export async function buildSetRules(input: {
  creator: TransactionSigner;
  cross: Address;
  rules: RulesConfig;
  baseMint?: Address | undefined;
  quoteMint: Address;
  quoteTokenProgram: Address;
  calendar?: Address | null | undefined;
  feed?: Address | undefined;
}): Promise<Instruction> {
  const full = completeRules(input.rules);
  const ix = getSetRulesInstruction({ creator: input.creator, cross: input.cross, ...full });
  return withAccounts(ix, await setRulesAccounts({ ...input, creator: input.creator.address, rules: full }));
}

/** Everything a cross with rules takes to create: the creation and rules in one transaction, then the shards, buckets, class book
 *  and lock vault the rules call for. With no `rules` this is `buildCreateCross` with empty extras. */
export async function buildCreateRuledCross(input: CreateRuledCrossInput): Promise<RuledCreation> {
  const { rules, feed, ...base } = input;
  const built = await buildCreateCross(base);
  const calendar = typeof input.calendar === 'string' ? input.calendar : null;
  const setRules = rules
    ? await buildSetRules({ creator: input.creator, cross: built.cross, rules, ...(input.baseMint ? { baseMint: input.baseMint } : {}), quoteMint: input.quoteMint, quoteTokenProgram: input.quoteTokenProgram, calendar, ...(feed ? { feed } : {}) })
    : null;
  const auxShards: Instruction[] = [];
  let classBook: Instruction | null = null;
  let lockVault: Instruction | null = null;
  if (rules) {
    const full = completeRules(rules);
    for (const index of auxShardIndexesFor(full.ending, Number(input.shards))) {
      auxShards.push(getInitShardInstruction({ payer: input.creator, cross: built.cross, shard: await shardAddress(built.cross, index), index }));
    }
    const classes = full.alloc.reserveBps.some((b) => b > 0) || full.alloc.lotteryUnit > 0n || full.neutrality.insiders.length > 0;
    if (classes) classBook = getInitClassBookInstruction({ payer: input.creator, cross: built.cross, classBook: await classBookAddress(built.cross) });
    const locks = full.alloc.minLockSecs > 0 || full.alloc.class1CliffSecs > 0 || full.alloc.class1VestSecs > 0 || full.neutrality.insiderCliffSecs > 0 || full.neutrality.insiderVestSecs > 0;
    if (locks) {
      if (!input.baseMint) throw new Error('lockups are refused on deferred-mint crosses: the lock vault needs the base mint');
      lockVault = getInitLockVaultInstruction({ payer: input.creator, cross: built.cross, baseMint: input.baseMint, lockVault: await lockVaultAddress(built.cross), baseTokenProgram: input.baseTokenProgram });
    }
  }
  return { cross: built.cross, ensureCreatorQuote: built.ensureCreatorQuote, atomic: setRules ? [built.create, setRules] : [built.create], create: built.create, setRules, shards: built.shards, auxShards, classBook, lockVault };
}

/** The accounts a cross with rules still lacks, as init instructions (an interrupted create leaves these undone). `exists` says whether an account is on chain. */
export async function buildMissingRuledAccounts(cross: RuledCrossView, payer: TransactionSigner, exists: (a: Address) => Promise<boolean>): Promise<Instruction[]> {
  const x = cross.ext;
  const out: Instruction[] = [];
  if (!x) return out;
  for (const index of auxShardIndexesFor(x.ending, Number(cross.data.shards))) {
    const shard = await shardAddress(cross.address, index);
    if (!(await exists(shard))) out.push(getInitShardInstruction({ payer, cross: cross.address, shard, index }));
  }
  if (usesClassBook(x)) {
    const classBook = await classBookAddress(cross.address);
    if (!(await exists(classBook))) out.push(getInitClassBookInstruction({ payer, cross: cross.address, classBook }));
  }
  if (usesLocks(x) && cross.data.baseBound) {
    const lockVault = await lockVaultAddress(cross.address);
    if (!(await exists(lockVault))) out.push(getInitLockVaultInstruction({ payer, cross: cross.address, baseMint: cross.data.baseMint, lockVault, baseTokenProgram: cross.data.baseTokenProgram }));
  }
  return out;
}

// ------------------------------------------------------------------ the draw (ADR-0452)

/** First step of a draw: records the slot. Anyone may send it, once the reveal window is over. */
export function buildDrawBegin(cross: Address): Instruction {
  return getDrawBeginInstruction({ cross });
}

/** Second step: at least 20 slots after `draw_begin` and before its samples leave the SlotHashes sysvar. Anyone may send it. */
export function buildDrawFinish(cross: Address): Instruction {
  return getDrawFinishInstruction({ cross, slotHashes: SLOT_HASHES });
}

// ------------------------------------------------------------------ lockups (ADR-0454)

/** Pays the vested part of a lockup to its owner (created token account if missing). Anyone may send it. */
export async function buildReleaseLocked(cross: CrossView, payer: TransactionSigner, owner: Address, nonce: bigint): Promise<Instruction[]> {
  const c = cross.data;
  const ownerBase = await ata(owner, c.baseMint, c.baseTokenProgram);
  return [
    getCreateAssociatedTokenIdempotentInstruction({ payer, ata: ownerBase, owner, mint: c.baseMint, tokenProgram: c.baseTokenProgram }),
    getReleaseLockedInstruction({
      cross: cross.address,
      owner,
      lockup: await lockupAddress(cross.address, owner, nonce),
      lockVault: await lockVaultAddress(cross.address),
      baseMint: c.baseMint,
      ownerBase,
      baseTokenProgram: c.baseTokenProgram,
    }),
  ];
}

// ------------------------------------------------------------------ pushed refunds (ADR-0457)

/** The most refund-only orders `push_refunds` takes in one transaction. */
export const MAX_PUSH_REFUNDS = 12;

/** `push_refunds` for these orders (three remaining accounts each: the order, its owner, the owner's token account for the escrowed mint). */
export async function buildPushRefunds(cross: CrossView, orders: readonly { owner: Address; nonce: bigint; side: OrderSide }[]): Promise<Instruction> {
  if (orders.length === 0) throw new Error('push_refunds needs at least one order');
  if (orders.length > MAX_PUSH_REFUNDS) throw new Error(`push_refunds takes at most ${MAX_PUSH_REFUNDS} orders per transaction`);
  const c = cross.data;
  const ix = getPushRefundsInstruction({
    cross: cross.address,
    quoteMint: c.quoteMint,
    quoteVault: await quoteVaultAddress(cross.address),
    ...(c.baseBound ? { baseMint: c.baseMint, baseVault: await baseVaultAddress(cross.address) } : {}),
    quoteTokenProgram: c.quoteTokenProgram,
    baseTokenProgram: c.baseTokenProgram,
  });
  const extra: AccountMeta[] = [];
  for (const o of orders) {
    const buy = o.side === OrderSide.Buy;
    const dest = await ata(o.owner, buy ? c.quoteMint : c.baseMint, buy ? c.quoteTokenProgram : c.baseTokenProgram);
    extra.push(writable(await orderAddress(cross.address, o.owner, o.nonce)), writable(o.owner), writable(dest));
  }
  return withAccounts(ix, extra);
}

// ------------------------------------------------------------------ identity limits and issuer neutrality (ADR-0453, ADR-0454)

/** Closes a finished identity-limit applicant record, returning its rent to the owner. Anyone may send it. */
export async function buildCloseApplicant(cross: Address, owner: Address): Promise<Instruction> {
  return getCloseApplicantInstruction({ cross, owner, applicant: await applicantAddress(cross, owner) });
}

/** Files a challenge that `subject` is an undeclared insider. `id` is the cross's challenge count (`ext.neutralState.challenges`). */
export async function buildChallengeInsider(input: { cross: Address; challenger: TransactionSigner; id: number; subject: Address; evidence: ReadonlyUint8Array }): Promise<Instruction> {
  if (input.evidence.length !== 32) throw new Error('evidence is the 32-byte hash of the document that supports the challenge');
  return getChallengeInsiderInstruction({ challenger: input.challenger, cross: input.cross, challenge: await challengeAddress(input.cross, input.id), subject: input.subject, evidence: input.evidence });
}

/** The arbiter's ruling on a challenge. An upheld ruling slashes up to the bond (half to the challenger, half to the protocol). */
export async function buildResolveChallenge(input: {
  cross: CrossView;
  arbiter: TransactionSigner;
  id: number;
  challenger: Address;
  feeRecipient: Address;
  upheld: boolean;
  slash: bigint;
}): Promise<Instruction> {
  const c = input.cross.data;
  return getResolveChallengeInstruction({
    arbiter: input.arbiter,
    registry: await arbiterRegistryAddress(),
    cross: input.cross.address,
    challenge: await challengeAddress(input.cross.address, input.id),
    challenger: input.challenger,
    feeRecipient: input.feeRecipient,
    quoteMint: c.quoteMint,
    quoteVault: await quoteVaultAddress(input.cross.address),
    challengerQuote: await ata(input.challenger, c.quoteMint, c.quoteTokenProgram),
    feeRecipientQuote: await ata(input.feeRecipient, c.quoteMint, c.quoteTokenProgram),
    quoteTokenProgram: c.quoteTokenProgram,
    upheld: input.upheld,
    slash: input.slash,
  });
}

/** Closes a challenge the arbiter left unanswered for 14 days (the deposit goes back to the challenger). Anyone may send it. */
export async function buildExpireChallenge(input: { cross: Address; id: number; challenger: Address }): Promise<Instruction> {
  return getExpireChallengeInstruction({ cross: input.cross, challenge: await challengeAddress(input.cross, input.id), challenger: input.challenger });
}

/** The protocol admin names the arbiter who rules on challenges (HUMAN_TASKS H28). */
export async function buildSetArbiter(admin: TransactionSigner, arbiter: Address): Promise<Instruction> {
  return getSetArbiterInstruction({ admin, protocol: await protocolAddress(), registry: await arbiterRegistryAddress(), arbiter });
}

// ------------------------------------------------------------------ halt states and the lender feed (ADR-0455)

export type BreakerSetupInput = { feedId: Uint8Array; windowSlots: number; moveBps: number };

/** Creates the halt state of a base mint. `venueSigner` may also halt and may run resume crosses; `breaker` arms the Pyth circuit breaker. */
export async function buildInitHaltState(input: { authority: TransactionSigner; baseMint: Address; venueSigner?: Address | null; breaker?: BreakerSetupInput | null }): Promise<{ halt: Address; instruction: Instruction }> {
  const halt = await haltStateAddress(input.baseMint);
  return {
    halt,
    instruction: getInitHaltStateInstruction({ authority: input.authority, baseMint: input.baseMint, protocol: await protocolAddress(), halt, venueSigner: input.venueSigner ?? null, breaker: input.breaker ?? null }),
  };
}

/** Halts crosses that name the halt state. Signed by its authority or venue signer. */
export async function buildSetHalt(signer: TransactionSigner, baseMint: Address): Promise<Instruction> {
  return getSetHaltInstruction({ signer, halt: await haltStateAddress(baseMint) });
}

/** Sets or clears the corporate-action flag of a halt state. */
export async function buildSetCorporateAction(signer: TransactionSigner, baseMint: Address, flag: boolean): Promise<Instruction> {
  return getSetCorporateActionInstruction({ signer, halt: await haltStateAddress(baseMint), flag });
}

/** Copies a Token-2022 pausable mint's pause flag into the halt state. Anyone may send it. */
export async function buildSyncPause(baseMint: Address): Promise<Instruction> {
  return getSyncPauseInstruction({ halt: await haltStateAddress(baseMint), baseMint });
}

/** Feeds a verified Pyth update to the circuit breaker. Anyone may send it. */
export async function buildObservePrice(baseMint: Address, priceUpdate: Address): Promise<Instruction> {
  return getObservePriceInstruction({ halt: await haltStateAddress(baseMint), priceUpdate });
}

/** Creates the lender print feed of a base/quote pair: only a listed publisher's print of at least `minMatched` moves it. */
export async function buildInitPrintFeed(input: { authority: TransactionSigner; baseMint: Address; quoteMint: Address; publishers: readonly Address[]; minMatched: bigint }): Promise<{ feed: Address; instruction: Instruction }> {
  const feed = await printFeedAddress(input.baseMint);
  return { feed, instruction: getInitPrintFeedInstruction({ authority: input.authority, baseMint: input.baseMint, quoteMint: input.quoteMint, protocol: await protocolAddress(), feed, publishers: [...input.publishers], minMatched: input.minMatched }) };
}

export async function buildSetFeedPublishers(input: { authority: TransactionSigner; baseMint: Address; publishers: readonly Address[]; minMatched: bigint }): Promise<Instruction> {
  return getSetFeedPublishersInstruction({ authority: input.authority, feed: await printFeedAddress(input.baseMint), publishers: [...input.publishers], minMatched: input.minMatched });
}

// ------------------------------------------------------------------ recurring series (ADR-0456)

export type SeriesView = { address: Address; data: Series };

export function readSeries(address: Address, bytes: Uint8Array): SeriesView {
  return { address, data: getSeriesDecoder().decode(bytes) };
}

/** Creates a series and the token accounts it holds the dust bond and the proceeds in. */
export async function buildCreateSeries(input: {
  authority: TransactionSigner;
  seriesId: bigint;
  baseMint: Address;
  quoteMint: Address;
  baseTokenProgram: Address;
  quoteTokenProgram: Address;
  config: SeriesConfigArgs;
}): Promise<{ series: Address; instructions: Instruction[] }> {
  const series = await seriesAddress(input.authority.address, input.seriesId);
  return {
    series,
    instructions: [
      getCreateSeriesInstruction({
        authority: input.authority,
        series,
        baseMint: input.baseMint,
        quoteMint: input.quoteMint,
        baseTokenProgram: input.baseTokenProgram,
        quoteTokenProgram: input.quoteTokenProgram,
        seriesId: input.seriesId,
        config: input.config,
      }),
      getCreateAssociatedTokenIdempotentInstruction({ payer: input.authority, ata: await ata(series, input.quoteMint, input.quoteTokenProgram), owner: series, mint: input.quoteMint, tokenProgram: input.quoteTokenProgram }),
      getCreateAssociatedTokenIdempotentInstruction({ payer: input.authority, ata: await ata(series, input.baseMint, input.baseTokenProgram), owner: series, mint: input.baseMint, tokenProgram: input.baseTokenProgram }),
    ],
  };
}

/** `spawn_next` for the series' next cross. The previous cross is required from the second one on. `feed` adds the lender feed of the base mint. */
export async function buildSpawnNext(series: SeriesView, payer: TransactionSigner, opts: { feed?: boolean } = {}): Promise<{ cross: Address; instruction: Instruction }> {
  const s = series.data;
  const cross = await crossAddress(series.address, s.nextIndex);
  const calendar = s.config.calendar.__option === 'Some' ? s.config.calendar.value : null;
  const ix = getSpawnNextInstruction({
    payer,
    protocol: await protocolAddress(),
    series: series.address,
    cross,
    book: await bookAddress(cross),
    baseMint: s.baseMint,
    quoteMint: s.quoteMint,
    quoteVault: await quoteVaultAddress(cross),
    baseVault: await baseVaultAddress(cross),
    seriesQuote: await ata(series.address, s.quoteMint, s.quoteTokenProgram),
    ...(s.lastCross.__option === 'Some' ? { previous: s.lastCross.value } : {}),
    ...(calendar ? { calendarAccount: calendar } : {}),
    baseTokenProgram: s.baseTokenProgram,
    quoteTokenProgram: s.quoteTokenProgram,
  });
  return { cross, instruction: opts.feed ? withAccounts(ix, [readonly(await printFeedAddress(s.baseMint))]) : ix };
}

export function buildSetSeriesActive(authority: TransactionSigner, series: Address, active: boolean): Instruction {
  return getSetSeriesActiveInstruction({ authority, series, active });
}

/** Moves `amount` of a mint out of the series' own token account to `to` (its proceeds, or unspent bond). */
export async function buildSeriesWithdraw(input: { authority: TransactionSigner; series: SeriesView; mint: Address; tokenProgram: Address; to: Address; amount: bigint }): Promise<Instruction> {
  return getSeriesWithdrawInstruction({ authority: input.authority, series: input.series.address, mint: input.mint, from: await ata(input.series.address, input.mint, input.tokenProgram), to: input.to, tokenProgram: input.tokenProgram, amount: input.amount });
}

/** What `challenge_insider` takes from the challenger, in lamports, on top of the new account's rent (`CHALLENGE_DEPOSIT`, neutral.rs). */
export const CHALLENGE_DEPOSIT_LAMPORTS = 10_000_000n;

/** An open challenge the arbiter has not ruled on can be closed by anyone after this long (`ARBITER_DEADLINE_SECS`, neutral.rs); the deposit goes back to the challenger and the bond is untouched. */
export const ARBITER_DEADLINE_SECS = 14n * 24n * 3600n;
