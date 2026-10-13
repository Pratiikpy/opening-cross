// Rules, extension tails and the accounts they call for (ADR-0450 to ADR-0459).
//
// A cross created by the current program carries a `CrossExt` after the `Cross` struct, and an order on a cross with
// order-level rules carries an `OrderExt` after the `Order` struct. Neither is visible to the generated account
// decoders (they read the struct and ignore the bytes after it), so these helpers read them, derive the extra
// accounts a rule-bearing cross needs (passed as remaining accounts, in the order the program defines) and mirror the
// program's arithmetic so a client can preview what the program will decide.
//
// A cross created before the tail existed has no tail and every rule off: `readCrossExt` returns null for it and
// every helper below treats null as "no rules".
import {
  type AccountMeta,
  AccountRole,
  type Address,
  type Instruction,
  type ReadonlyUint8Array,
  address,
  getAddressEncoder,
  getProgramDerivedAddress,
  getU32Encoder,
  getU64Encoder,
  isFixedSize,
  type Decoder,
} from '@solana/kit';
import { CROSS_CORE_PROGRAM_ADDRESS } from './generated/programs/crossCore.js';
import { getCrossDecoder } from './generated/accounts/cross.js';
import { getOrderDecoder } from './generated/accounts/order.js';
import { type CrossExt, getCrossExtDecoder } from './generated/types/crossExt.js';
import { type OrderExt, getOrderExtDecoder } from './generated/types/orderExt.js';
import type { GuardRulesArgs } from './generated/types/guardRules.js';
import type { EndingRulesArgs } from './generated/types/endingRules.js';
import type { IdentityRulesArgs } from './generated/types/identityRules.js';
import type { AllocationRulesArgs } from './generated/types/allocationRules.js';
import type { RulesInputArgs } from './generated/types/rulesInput.js';
import type { NeutralityInputArgs } from './generated/types/neutralityInput.js';
import type { ReferralRulesArgs } from './generated/types/referralRules.js';
import type { OracleSetInputArgs } from './generated/types/oracleSetInput.js';

const enc = getAddressEncoder();
const u64 = getU64Encoder();
const u32 = getU32Encoder();
const text = (s: string) => new TextEncoder().encode(s);

/** Version byte that marks a tail written by the program. */
export const EXT_VERSION = 1;
/** Order tail value for "placed before the ending period". */
export const NO_BUCKET = 255;
export const AUX_END_BASE = 32;
export const AUX_EXT_BASE = 40;
export const MAX_BUCKETS = 8;
export const MAX_EXT_SHARDS = 8;
export const MAX_INSIDERS = 8;
export const MAX_REFERRAL_BPS = 5_000;

export const FLAG_RESUMES_HALT = 1 << 1;
export const FLAG_FEEDS_LENDERS = 1 << 2;
export const FLAG_STANDARD_GRID = 1 << 3;
export const FLAG_GUARD_SCALED_UI = 1 << 4;
export const ORDER_INSIDER = 1;

const maxSize = (d: Decoder<unknown>, what: string): number => {
  const size = isFixedSize(d) ? d.fixedSize : d.maxSize;
  if (size === undefined) throw new Error(`${what} has no fixed maximum size`);
  return size;
};
/** Bytes of the `Cross` struct with its discriminator: where the tail starts. */
export const CROSS_BODY_LEN: number = maxSize(getCrossDecoder(), 'Cross');
/** Bytes reserved for the cross tail. */
export const CROSS_EXT_LEN: number = maxSize(getCrossExtDecoder(), 'CrossExt');
export const ORDER_BODY_LEN: number = maxSize(getOrderDecoder(), 'Order');
export const ORDER_EXT_LEN: number = maxSize(getOrderExtDecoder(), 'OrderExt');

/** The tail of a cross account, or null for a cross without rules (a legacy cross, or one whose rules were never set). */
export function readCrossExt(account: Uint8Array): CrossExt | null {
  if (account.length < CROSS_BODY_LEN + 2 || account[CROSS_BODY_LEN] !== EXT_VERSION) return null;
  const ext = getCrossExtDecoder().decode(account.subarray(CROSS_BODY_LEN));
  return ext.rulesSet ? ext : null;
}

/** The tail exactly as stored (rules possibly unset): only the creator's own tooling needs this. */
export function readCrossExtRaw(account: Uint8Array): CrossExt | null {
  if (account.length < CROSS_BODY_LEN + 2 || account[CROSS_BODY_LEN] !== EXT_VERSION) return null;
  return getCrossExtDecoder().decode(account.subarray(CROSS_BODY_LEN));
}

/** The tail of an order account, or the defaults (epoch 0, no bucket) for an order without one. */
export function readOrderExt(account: Uint8Array): OrderExt {
  if (account.length < ORDER_BODY_LEN + 2 || account[ORDER_BODY_LEN] !== EXT_VERSION) {
    return { version: 0, epoch: 0, bucket: NO_BUCKET, class: 0, flags: 0, lockCliff: 0, lockVest: 0, placedTs: 0n, ticket: 0 };
  }
  return getOrderExtDecoder().decode(account.subarray(ORDER_BODY_LEN));
}

// ------------------------------------------------------------------ what the rules call for

export const usesIdentity = (x: CrossExt | null | undefined): boolean => !!x && (x.identity.capQuote > 0n || x.identity.maxOrders > 0);
export const usesClassBook = (x: CrossExt | null | undefined): boolean =>
  !!x && (x.alloc.reserveBps.some((b) => b > 0) || x.alloc.lotteryUnit > 0n || x.neutrality.insiderCount > 0);
export const needsDraw = (x: CrossExt | null | undefined): boolean => !!x && (x.ending.randomEnd || x.alloc.lotteryUnit > 0n);
export const orderTail = (x: CrossExt | null | undefined): boolean =>
  !!x && (x.ending.endingSecs > 0 || x.ending.extensionMaxSecs > 0 || usesClassBook(x) || x.alloc.minLockSecs > 0 || x.alloc.class1VestSecs > 0 || x.alloc.class1CliffSecs > 0);
/** Whether the clear reads the base mint: for a halt state, for the supply, or for a scaled-UI multiplier. */
export const readsMintAtClear = (x: CrossExt | null | undefined): boolean =>
  !!x &&
  (x.guards.haltSource.__option === 'Some' ||
    (x.guards.totalSupply === 0n && (x.guards.minFloatBps > 0 || x.guards.maxFdvX100 > 0)) ||
    (x.flags & FLAG_GUARD_SCALED_UI) !== 0);
export const hasFlag = (x: CrossExt | null | undefined, flag: number): boolean => !!x && (x.flags & flag) !== 0;
export const usesLocks = (x: CrossExt | null | undefined): boolean =>
  !!x &&
  (x.alloc.minLockSecs > 0 ||
    x.alloc.class1CliffSecs > 0 ||
    x.alloc.class1VestSecs > 0 ||
    x.neutrality.insiderCliffSecs > 0 ||
    x.neutrality.insiderVestSecs > 0);

/** Last counted ending bucket: the drawn one, or the final bucket when nothing was drawn. */
export function lastBucket(x: CrossExt): number {
  return x.draw.endBucket === NO_BUCKET ? Math.max(x.ending.buckets - 1, 0) : x.draw.endBucket;
}

/** Epoch and ending bucket an order placed at `now` belongs to. Mirrors `CrossExt::placement`. */
export function placementAt(x: CrossExt | null | undefined, closeTs: bigint, now: bigint): { epoch: number; bucket: number } {
  if (!x) return { epoch: 0, bucket: NO_BUCKET };
  if (x.draw.epoch > 0) return { epoch: x.draw.epoch, bucket: NO_BUCKET };
  if (x.ending.endingSecs === 0) return { epoch: 0, bucket: NO_BUCKET };
  const start = closeTs - BigInt(x.ending.endingSecs);
  if (now < start) return { epoch: 0, bucket: NO_BUCKET };
  const b = ((now - start) * BigInt(x.ending.buckets)) / BigInt(x.ending.endingSecs);
  return { epoch: 0, bucket: Number(b < BigInt(x.ending.buckets - 1) ? b : BigInt(x.ending.buckets - 1)) };
}

/** Time from which an order can no longer be cancelled. */
export function cancelDeadline(x: CrossExt | null | undefined, closeTs: bigint): bigint {
  if (!x) return closeTs;
  return closeTs - BigInt(x.ending.endingSecs) - BigInt(x.ending.cancelCutoffSecs);
}

/** Auxiliary shard indexes that must exist and be merged before the cross can clear (ending buckets, extension shards). */
export function auxShardIndexes(x: CrossExt | null | undefined, mainShards: number): number[] {
  if (!x) return [];
  return auxShardIndexesFor(x.ending, mainShards);
}

export function auxShardIndexesFor(ending: { endingSecs: number; buckets: number; extensionMaxSecs: number }, mainShards: number): number[] {
  const out: number[] = [];
  if (ending.endingSecs > 0) for (let b = 0; b < ending.buckets; b++) out.push(AUX_END_BASE + b);
  if (ending.extensionMaxSecs > 0) for (let j = 0; j < Math.min(Math.max(mainShards, 1), MAX_EXT_SHARDS); j++) out.push(AUX_EXT_BASE + j);
  return out;
}

/** Bit of an auxiliary shard in `draw.auxMerged`. */
export const auxBit = (index: number): bigint => (index >= AUX_EXT_BASE ? 1n << BigInt(8 + index - AUX_EXT_BASE) : 1n << BigInt(index - AUX_END_BASE));

// ------------------------------------------------------------------ addresses

const pda = async (seeds: ReadonlyUint8Array[], program: Address = CROSS_CORE_PROGRAM_ADDRESS) => (await getProgramDerivedAddress({ programAddress: program, seeds }))[0];

export const classBookAddress = (cross: Address) => pda([text('classes'), enc.encode(cross)]);
export const applicantAddress = (cross: Address, owner: Address) => pda([text('applicant'), enc.encode(cross), enc.encode(owner)]);
export const lockVaultAddress = (cross: Address) => pda([text('lock_vault'), enc.encode(cross)]);
export const lockupAddress = (cross: Address, owner: Address, nonce: bigint) => pda([text('lock'), enc.encode(cross), enc.encode(owner), u64.encode(nonce)]);
export const haltStateAddress = (baseMint: Address) => pda([text('halt'), enc.encode(baseMint)]);
export const printFeedAddress = (baseMint: Address) => pda([text('print_feed'), enc.encode(baseMint)]);
export const arbiterRegistryAddress = () => pda([text('arbiter')]);
export const challengeAddress = (cross: Address, id: number) => pda([text('challenge'), enc.encode(cross), u32.encode(id)]);
export const seriesAddress = (authority: Address, seriesId: bigint) => pda([text('series'), enc.encode(authority), u64.encode(seriesId)]);
/** The `cross_gate` pass of `owner` for `gateMint`; `gateProgram` is `CROSS_GATE_PROGRAM_ADDRESS` from `@opening-cross/cross-gate-client`. */
export const gatePassAddressOf = (gateProgram: Address, gateMint: Address, owner: Address) => pda([text('pass'), enc.encode(gateMint), enc.encode(owner)], gateProgram);
export const SLOT_HASHES = address('SysvarS1otHashes111111111111111111111111111');

// ------------------------------------------------------------------ instructions with extra accounts

export const writable = (a: Address): AccountMeta => ({ address: a, role: AccountRole.WRITABLE });
export const readonly = (a: Address): AccountMeta => ({ address: a, role: AccountRole.READONLY });

/** Appends remaining accounts to a generated instruction. */
export function withAccounts<I extends Instruction>(ix: I, extra: readonly AccountMeta[]): I {
  return extra.length === 0 ? ix : ({ ...ix, accounts: [...((ix.accounts as readonly AccountMeta[] | undefined) ?? []), ...extra] } as I);
}

/** Remaining accounts of `commit_order` / `commit_order_ext`: the applicant record (identity limits), the class book
 *  (classes, insiders), the priority pass (class 3 outside the early window). */
export async function commitExtras(x: CrossExt | null, cross: Address, owner: Address, opts: { class?: number; now: bigint; gateProgram: Address }): Promise<AccountMeta[]> {
  const out: AccountMeta[] = [];
  if (usesIdentity(x)) out.push(writable(await applicantAddress(cross, owner)));
  if (usesClassBook(x)) out.push(writable(await classBookAddress(cross)));
  const early = x !== null && x.alloc.earlyUntilTs > 0n && opts.now < x.alloc.earlyUntilTs;
  if ((opts.class ?? 0) === 3 && x?.alloc.priorityGate.__option === 'Some' && !early) {
    out.push(readonly(await gatePassAddressOf(opts.gateProgram, x.alloc.priorityGate.value, owner)));
  }
  return out;
}

/** Remaining accounts of `cancel_order`. */
export async function cancelExtras(x: CrossExt | null, cross: Address, owner: Address, order: { revealed: boolean; isBuy: boolean }): Promise<AccountMeta[]> {
  const out: AccountMeta[] = [];
  if (usesIdentity(x)) out.push(writable(await applicantAddress(cross, owner)));
  if (usesClassBook(x) && order.revealed && order.isBuy) out.push(writable(await classBookAddress(cross)));
  return out;
}

/** Remaining accounts of `reveal_order`. */
export async function revealExtras(x: CrossExt | null, cross: Address, isBuy: boolean): Promise<AccountMeta[]> {
  return usesClassBook(x) && isBuy ? [writable(await classBookAddress(cross))] : [];
}

/** Remaining accounts of `claim`: the lock vault and the lockup record of a locked buy. */
export async function claimExtras(cross: Address, owner: Address, nonce: bigint, order: { isBuy: boolean; ext: OrderExt }): Promise<AccountMeta[]> {
  const locked = order.isBuy && (order.ext.lockCliff > 0 || order.ext.lockVest > 0);
  return locked ? [writable(await lockVaultAddress(cross)), writable(await lockupAddress(cross, owner, nonce))] : [];
}

/** Remaining accounts of `clear`, in the order the program reads them: halt state, base mint, class book, lender feed, the extra
 *  oracle accounts (one per extra feed, in order), the calendar when the oracle band widens off hours. */
export async function clearExtras(x: CrossExt | null, cross: Address, baseMint: Address, opts: { oracleAccounts?: readonly Address[]; calendar?: Address | null } = {}): Promise<AccountMeta[]> {
  const { oracleAccounts, calendar } = opts;
  const out: AccountMeta[] = [];
  if (!x) return out;
  if (x.guards.haltSource.__option === 'Some') out.push(writable(x.guards.haltSource.value));
  if (readsMintAtClear(x)) out.push(readonly(baseMint));
  if (usesClassBook(x)) out.push(readonly(await classBookAddress(cross)));
  if (hasFlag(x, FLAG_FEEDS_LENDERS)) out.push(writable(await printFeedAddress(baseMint)));
  for (const feed of oracleAccounts ?? []) out.push(readonly(feed));
  if (x.oracleSet.offHoursWidenBps > 0 && calendar) out.push(readonly(calendar));
  return out;
}

// ------------------------------------------------------------------ rules input

export type RulesConfig = {
  flags?: number;
  guards?: Partial<GuardRulesArgs>;
  ending?: Partial<EndingRulesArgs>;
  identity?: Partial<IdentityRulesArgs>;
  alloc?: Partial<AllocationRulesArgs>;
  neutrality?: Partial<Omit<NeutralityInputArgs, 'insiders'>> & { insiders?: readonly Address[] };
  referral?: Partial<ReferralRulesArgs>;
  oracleSet?: Partial<Omit<OracleSetInputArgs, 'extraFeeds'>> & { extraFeeds?: readonly Uint8Array[] };
};

const ZERO_ADDRESS = address('11111111111111111111111111111111');

/** Fills every rule the caller left out with its "off" value, in the shape `set_rules` takes (the insiders and extra feeds
 *  unpadded: the program pads them, and `create_cross` plus `set_rules` must fit one 1,232-byte transaction). */
export function completeRules(r: RulesConfig = {}) {
  const insiders = [...(r.neutrality?.insiders ?? [])];
  if (insiders.length > MAX_INSIDERS) throw new Error(`a cross can declare at most ${MAX_INSIDERS} insiders`);
  return {
    flags: r.flags ?? 0,
    guards: { minRaiseQuote: 0n, maxMatched: 0n, totalSupply: 0n, minFloatBps: 0, maxFdvX100: 0, anchorPrice: 0n, moveBps: 0, gridEstimate: 0n, haltSource: null, multiplierBits: 0n, ...r.guards } satisfies GuardRulesArgs,
    ending: { endingSecs: 0, buckets: 0, cancelCutoffSecs: 0, randomEnd: false, extensionMinSecs: 0, extensionMaxSecs: 0, ...r.ending } satisfies EndingRulesArgs,
    identity: { capQuote: 0n, maxOrders: 0, ...r.identity } satisfies IdentityRulesArgs,
    alloc: {
      reserveBps: [0, 0, 0] as [number, number, number],
      smallCapQuote: 0n,
      lotteryUnit: 0n,
      minLockSecs: 0,
      lockVestSecs: 0,
      earlyUntilTs: 0n,
      priorityGate: null,
      class1CliffSecs: 0,
      class1VestSecs: 0,
      ...r.alloc,
    } satisfies AllocationRulesArgs,
    neutrality: {
      insiderCliffSecs: 0,
      insiderVestSecs: 0,
      bondQuote: 0n,
      challengeSecs: 0,
      ...r.neutrality,
      insiders,
    } satisfies NeutralityInputArgs,
    referral: { referrer: ZERO_ADDRESS, shareBps: 0, ...r.referral } satisfies ReferralRulesArgs,
    oracleSet: oracleSetOf(r.oracleSet),
  };
}

/** The same rules in the padded fixed-size form a `Series` stores (`create_series` takes its rules this way: the account
 *  is fixed-size, so the lists are padded with zeros and counted). `set_rules` takes `completeRules` instead. */
export function paddedRules(r: RulesConfig = {}): RulesInputArgs {
  const c = completeRules(r);
  const o = c.oracleSet;
  const feeds = [...o.extraFeeds];
  return {
    flags: c.flags,
    guards: c.guards,
    ending: c.ending,
    identity: c.identity,
    alloc: c.alloc,
    neutrality: {
      insiders: [...c.neutrality.insiders, ...Array.from({ length: MAX_INSIDERS - c.neutrality.insiders.length }, () => ZERO_ADDRESS)],
      insiderCount: c.neutrality.insiders.length,
      insiderCliffSecs: c.neutrality.insiderCliffSecs,
      insiderVestSecs: c.neutrality.insiderVestSecs,
      bondQuote: c.neutrality.bondQuote,
      challengeSecs: c.neutrality.challengeSecs,
    },
    referral: c.referral,
    oracleSet: {
      extraFeeds: [...feeds, ...Array.from({ length: 2 - feeds.length }, () => new Uint8Array(32))] as unknown as RulesInputArgs['oracleSet']['extraFeeds'],
      extraCount: feeds.length,
      quorum: o.quorum,
      maxSpreadBps: o.maxSpreadBps,
      offHoursWidenBps: o.offHoursWidenBps,
    },
  };
}

/** Coarse view of an indicative price for the final window (ADR-0452): the nearest of `bands` evenly spaced prices of the
 *  grid, and the imbalance banded to one of "balanced", "demand-heavy" or "supply-heavy" at a `thresholdBps` of the smaller
 *  side. Interfaces show this, never the fine figures, while the ending is open. The chain of an open cross is public by
 *  construction; this is the rule for the interfaces we ship, and a cross that needs the information hidden is sealed. */
export function coarseIndicative(input: { minPrice: bigint; tick: bigint; ticks: number; price: bigint | null; demand: bigint; supply: bigint }, bands = 8, thresholdBps = 2_000) {
  const span = BigInt(Math.max(input.ticks - 1, 1)) * input.tick;
  const step = span / BigInt(Math.max(bands, 1)) || 1n;
  const price = input.price === null ? null : input.minPrice + ((input.price - input.minPrice + step / 2n) / step) * step;
  const [lo, hi] = input.demand < input.supply ? [input.demand, input.supply] : [input.supply, input.demand];
  const heavy = lo === 0n ? hi > 0n : (hi - lo) * 10_000n > lo * BigInt(thresholdBps);
  return { price, imbalance: !heavy ? ('balanced' as const) : input.demand > input.supply ? ('demand-heavy' as const) : ('supply-heavy' as const) };
}

function oracleSetOf(o: RulesConfig['oracleSet']): OracleSetInputArgs {
  const feeds = [...(o?.extraFeeds ?? [])];
  if (feeds.length > 2) throw new Error('a cross can name at most two extra oracle feeds');
  return {
    extraFeeds: feeds,
    quorum: o?.quorum ?? (feeds.length > 0 || (o?.offHoursWidenBps ?? 0) > 0 ? 1 : 0),
    maxSpreadBps: o?.maxSpreadBps ?? 0,
    offHoursWidenBps: o?.offHoursWidenBps ?? 0,
  };
}
