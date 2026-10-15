// Opening Cross SDK: addresses, commitments and instruction builders for every step of a cross.
// Builders return @solana/kit instructions; callers compose and sign transactions themselves.
import { sha256 } from '@noble/hashes/sha2.js';
import {
  type Address,
  type Instruction,
  type TransactionSigner,
  getAddressEncoder,
  getProgramDerivedAddress,
  getU64Encoder,
} from '@solana/kit';
import { findAssociatedTokenPda, getCreateAssociatedTokenIdempotentInstruction } from '@solana-program/token-2022';
import {
  AUX_END_BASE,
  AUX_EXT_BASE,
  CROSS_CORE_PROGRAM_ADDRESS,
  type Cross,
  type CreateCrossInstructionDataArgs,
  type CrossExt,
  CrossState,
  Disclosure,
  type OrderExt,
  OrderSide,
  SupplyMode,
  auxBit,
  auxShardIndexes,
  cancelExtras,
  claimExtras,
  clearExtras,
  commitExtras,
  drawPurpose,
  usesLocks,
  getCancelOrderInstruction,
  getClaimInstruction,
  getClearInstruction,
  getCommitOrderExtInstruction,
  getCommitOrderInstruction,
  getCreateCrossInstruction,
  getFinalizeInstruction,
  getInitShardInstruction,
  getMergeShardInstruction,
  getRevealOrderInstruction,
  lastBucket,
  placementAt,
  revealExtras,
  withAccounts,
  writable,
} from '@opening-cross/cross-core-client';
import { CROSS_GATE_PROGRAM_ADDRESS } from '@opening-cross/cross-gate-client';

export * from '@opening-cross/cross-core-client';

const enc = getAddressEncoder();
const u64 = getU64Encoder();
const text = (s: string) => new TextEncoder().encode(s);

// ------------------------------------------------------------------ addresses

export async function protocolAddress(): Promise<Address> {
  return (await getProgramDerivedAddress({ programAddress: CROSS_CORE_PROGRAM_ADDRESS, seeds: [text('protocol')] }))[0];
}
export async function crossAddress(creator: Address, crossId: bigint): Promise<Address> {
  return (await getProgramDerivedAddress({ programAddress: CROSS_CORE_PROGRAM_ADDRESS, seeds: [text('cross'), enc.encode(creator), u64.encode(crossId)] }))[0];
}
export async function bookAddress(cross: Address): Promise<Address> {
  return (await getProgramDerivedAddress({ programAddress: CROSS_CORE_PROGRAM_ADDRESS, seeds: [text('book'), enc.encode(cross)] }))[0];
}
export async function shardAddress(cross: Address, index: number): Promise<Address> {
  return (await getProgramDerivedAddress({ programAddress: CROSS_CORE_PROGRAM_ADDRESS, seeds: [text('shard'), enc.encode(cross), new Uint8Array([index])] }))[0];
}
export async function orderAddress(cross: Address, owner: Address, nonce: bigint): Promise<Address> {
  return (await orderPda(cross, owner, nonce))[0];
}
export async function orderPda(cross: Address, owner: Address, nonce: bigint) {
  return getProgramDerivedAddress({ programAddress: CROSS_CORE_PROGRAM_ADDRESS, seeds: [text('order'), enc.encode(cross), enc.encode(owner), u64.encode(nonce)] });
}
export async function quoteVaultAddress(cross: Address): Promise<Address> {
  return (await getProgramDerivedAddress({ programAddress: CROSS_CORE_PROGRAM_ADDRESS, seeds: [text('quote_vault'), enc.encode(cross)] }))[0];
}
export async function baseVaultAddress(cross: Address): Promise<Address> {
  return (await getProgramDerivedAddress({ programAddress: CROSS_CORE_PROGRAM_ADDRESS, seeds: [text('base_vault'), enc.encode(cross)] }))[0];
}
export async function gatePassAddress(gateMint: Address, owner: Address): Promise<Address> {
  return (await getProgramDerivedAddress({ programAddress: CROSS_GATE_PROGRAM_ADDRESS, seeds: [text('pass'), enc.encode(gateMint), enc.encode(owner)] }))[0];
}
export async function ata(owner: Address, mint: Address, tokenProgram: Address): Promise<Address> {
  return (await findAssociatedTokenPda({ owner, mint, tokenProgram }))[0];
}

/**
 * Shard an order writes to: `sha256(owner ‖ nonce)` read as a little-endian u32, modulo the shard count. It depends
 * only on what the order's owner already knows, so bidders placing at the same moment never race for a shard.
 * Mirrors `cross_core::shard_of`.
 */
export function shardIndexFor(owner: Address, nonce: bigint, shards: number): number {
  const h = sha256(concat([enc.encode(owner), u64.encode(nonce)]));
  return new DataView(h.buffer, h.byteOffset, 4).getUint32(0, true) % Math.max(shards, 1);
}

// ------------------------------------------------------------------ commitments

/** Mirrors `cross_core::commitment_of`: sha256(cross ‖ owner ‖ nonce ‖ side ‖ price ‖ quantity ‖ salt). */
export function orderCommitment(cross: Address, owner: Address, nonce: bigint, side: OrderSide, price: bigint, quantity: bigint, salt: Uint8Array): Uint8Array<ArrayBuffer> {
  if (salt.length !== 32) throw new Error('salt must be 32 bytes');
  return Uint8Array.from(sha256(concat([enc.encode(cross), enc.encode(owner), u64.encode(nonce), new Uint8Array([side === OrderSide.Buy ? 0 : 1]), u64.encode(price), u64.encode(quantity), salt])));
}

function concat(parts: ArrayLike<number>[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p as Uint8Array, o);
    o += p.length;
  }
  return out;
}

// ------------------------------------------------------------------ pricing

/** Quote atoms a buyer escrows to cover `quantity` at `price`: ceil(quantity · price / scale). */
export function costCeil(quantity: bigint, price: bigint, scale: bigint): bigint {
  return (quantity * price + scale - 1n) / scale;
}

// ------------------------------------------------------------------ instruction builders

/** A cross as read from chain. `ext` is the rules tail of a cross created by the extended program (`readCrossExt` of the account
 *  bytes); leave it out or null for a cross without rules, and every builder behaves exactly as it did before the rules existed. */
export type CrossView = { address: Address; data: Cross; ext?: CrossExt | null };

/** The auxiliary shard (an ending bucket, or an extension shard after a drawn extension) an order belongs to, or a main shard. */
export function shardIndexOfPlacement(owner: Address, nonce: bigint, shards: number, placement: { epoch: number; bucket: number }): number {
  if (placement.epoch > 0) return AUX_EXT_BASE + shardIndexFor(owner, nonce, Math.min(Math.max(shards, 1), 8));
  if (placement.bucket !== 255) return AUX_END_BASE + placement.bucket;
  return shardIndexFor(owner, nonce, shards);
}

export type CreateCrossInput = Omit<CreateCrossInstructionDataArgs, 'discriminator'> & {
  creator: TransactionSigner;
  /** Omit for deferred-mint crosses (the settlement adapter creates and binds it). */
  baseMint?: Address;
  quoteMint: Address;
  baseTokenProgram: Address;
  quoteTokenProgram: Address;
};

/** Create the cross and every shard. Returns instruction groups to send in order (shards are
 *  ~6 KB each, so they go in their own transactions). */
export async function buildCreateCross(input: CreateCrossInput): Promise<{ cross: Address; create: Instruction; shards: Instruction[]; ensureCreatorQuote: Instruction }> {
  const crossId = BigInt(input.crossId);
  const cross = await crossAddress(input.creator.address, crossId);
  const { creator, baseMint, quoteMint, baseTokenProgram, quoteTokenProgram, ...params } = input;
  const create = getCreateCrossInstruction({
    creator,
    protocol: await protocolAddress(),
    cross,
    book: await bookAddress(cross),
    ...(baseMint ? { baseMint, baseVault: await baseVaultAddress(cross) } : {}),
    quoteMint,
    quoteVault: await quoteVaultAddress(cross),
    creatorQuote: await ata(creator.address, quoteMint, quoteTokenProgram),
    ...(typeof params.calendar === 'string' ? { calendarAccount: params.calendar } : {}),
    baseTokenProgram,
    quoteTokenProgram,
    ...params,
  });
  const shards: Instruction[] = [];
  for (let i = 0; i < Number(input.shards); i++) {
    shards.push(getInitShardInstruction({ payer: creator, cross, shard: await shardAddress(cross, i), index: i }));
  }
  // create_cross reads the creator's quote account (the bond, if any, is paid from it), so it must exist even for an issuer
  // that has never held the quote token. Send this instruction first; it is a no-op when the account already exists.
  const ensureCreatorQuote = getCreateAssociatedTokenIdempotentInstruction({ payer: creator, ata: await ata(creator.address, quoteMint, quoteTokenProgram), owner: creator.address, mint: quoteMint, tokenProgram: quoteTokenProgram });
  return { cross, create, shards, ensureCreatorQuote };
}

/** Init instructions for the shards of `cross` that do not exist yet. A create that stopped after its first transaction (a dropped
 *  connection, a rate-limited RPC, an empty fee payer) leaves a cross without all its shards, and nothing can clear it. Any wallet may
 *  pay for them: init_shard has no authority check, the shard's address is derived from the cross and its index. */
export async function buildMissingShards(cross: CrossView, payer: TransactionSigner, exists: (address: Address) => Promise<boolean>): Promise<Instruction[]> {
  const ixs: Instruction[] = [];
  for (let i = 0; i < Number(cross.data.shards); i++) {
    const shard = await shardAddress(cross.address, i);
    if (!(await exists(shard))) ixs.push(getInitShardInstruction({ payer, cross: cross.address, shard, index: i }));
  }
  return ixs;
}

export type PlaceOrderInput = {
  cross: CrossView;
  owner: TransactionSigner;
  nonce: bigint;
  side: OrderSide;
  price: bigint;
  quantity: bigint;
  /** Defaults to the exact cost for buys and the quantity for sells. Sealed buyers may escrow
   *  more to hide their price. */
  escrow?: bigint;
  /** Required for sealed crosses; keep it — the reveal needs it. */
  salt?: Uint8Array;
  /** Allocation class of a buy (1 identity-verified small, 2 accepts a lockup, 3 priority). Only crosses with rules take one. */
  class?: number;
  /** Seconds of lockup a class-2 buyer accepts. Only crosses with rules take one. */
  lockSecs?: number;
  /** Unix seconds the order will be placed at. An ending period is cut into buckets by the chain clock, and an open order
   *  names the bucket's shard, so a transaction built for one bucket is refused if it lands in the next: build it again.
   *  Defaults to the wall clock. */
  now?: bigint;
};

/** The shard, epoch and ending bucket an order placed at `now` lands in. */
export function orderPlacement(cross: CrossView, owner: Address, nonce: bigint, now: bigint): { epoch: number; bucket: number; shardIndex: number } {
  const placement = placementAt(cross.ext ?? null, cross.data.closeTs, now);
  return { ...placement, shardIndex: shardIndexOfPlacement(owner, nonce, cross.data.shards, placement) };
}

export async function buildPlaceOrder(input: PlaceOrderInput): Promise<Instruction> {
  const { cross, owner, nonce, side, price, quantity } = input;
  const c = cross.data;
  const ext = cross.ext ?? null;
  const cls = input.class ?? 0;
  const lockSecs = input.lockSecs ?? 0;
  if (!ext && (cls !== 0 || lockSecs !== 0)) throw new Error('this cross has no rules, so it takes no allocation class and no lockup');
  if (side === OrderSide.Sell && (cls !== 0 || lockSecs !== 0)) throw new Error('allocation classes and lockups apply to buy orders only');
  const sealed = c.disclosure === Disclosure.Sealed;
  const escrow = input.escrow ?? (side === OrderSide.Buy ? costCeil(quantity, price, c.priceScale) : quantity);
  const [order, orderBump] = await orderPda(cross.address, owner.address, nonce);
  let commitment: Uint8Array<ArrayBuffer> = new Uint8Array(32);
  if (sealed) {
    if (!input.salt) throw new Error('sealed crosses need a 32-byte salt');
    commitment = orderCommitment(cross.address, owner.address, nonce, side, price, quantity, input.salt);
  }
  const gateMint = c.gateMint.__option === 'Some' ? c.gateMint.value : null;
  const now = input.now ?? BigInt(Math.floor(Date.now() / 1000));
  const shardIndex = orderPlacement(cross, owner.address, nonce, now).shardIndex;
  const accounts = {
    owner,
    protocol: await protocolAddress(),
    cross: cross.address,
    order,
    ...(sealed ? {} : { shard: await shardAddress(cross.address, shardIndex) }),
    ...(gateMint ? { pass: await gatePassAddress(gateMint, owner.address) } : {}),
    ...(side === OrderSide.Buy
      ? { escrowMint: c.quoteMint, escrowVault: await quoteVaultAddress(cross.address), ownerEscrow: await ata(owner.address, c.quoteMint, c.quoteTokenProgram), escrowTokenProgram: c.quoteTokenProgram }
      : { escrowMint: c.baseMint, escrowVault: await baseVaultAddress(cross.address), ownerEscrow: await ata(owner.address, c.baseMint, c.baseTokenProgram), escrowTokenProgram: c.baseTokenProgram }),
  };
  const args = { nonce, side, escrow, commitment, price: sealed ? 0n : price, quantity: sealed ? 0n : quantity, orderBump };
  const ix = cls === 0 && lockSecs === 0 ? getCommitOrderInstruction({ ...accounts, ...args }) : getCommitOrderExtInstruction({ ...accounts, ...args, class: cls, lockSecs });
  return withAccounts(ix, await commitExtras(ext, cross.address, owner.address, { class: cls, now, gateProgram: CROSS_GATE_PROGRAM_ADDRESS }));
}

/** What a cross with rules needs to know about an order to route it: the order's tail (its ending bucket or extension epoch) and its side. */
export type OrderFacts = { ext: OrderExt; isBuy: boolean };

const shardOfOrder = (cross: CrossView, owner: Address, nonce: bigint, order?: OrderFacts) =>
  cross.ext && order ? shardIndexOfPlacement(owner, nonce, cross.data.shards, order.ext) : shardIndexFor(owner, nonce, cross.data.shards);

export async function buildCancel(cross: CrossView, owner: TransactionSigner, nonce: bigint, side: OrderSide, revealed: boolean, order?: OrderFacts): Promise<Instruction> {
  const c = cross.data;
  if (cross.ext && !order) throw new Error('cancelling an order of a cross with rules needs the order (its ending bucket and side)');
  const ix = getCancelOrderInstruction({
    owner,
    cross: cross.address,
    order: await orderAddress(cross.address, owner.address, nonce),
    ...(revealed ? { shard: await shardAddress(cross.address, shardOfOrder(cross, owner.address, nonce, order)) } : {}),
    baseMint: c.baseMint,
    quoteMint: c.quoteMint,
    quoteVault: await quoteVaultAddress(cross.address),
    baseVault: await baseVaultAddress(cross.address),
    ...(side === OrderSide.Buy ? { ownerQuote: await ata(owner.address, c.quoteMint, c.quoteTokenProgram) } : { ownerBase: await ata(owner.address, c.baseMint, c.baseTokenProgram) }),
    baseTokenProgram: c.baseTokenProgram,
    quoteTokenProgram: c.quoteTokenProgram,
  });
  return withAccounts(ix, await cancelExtras(cross.ext ?? null, cross.address, owner.address, { revealed, isBuy: side === OrderSide.Buy }));
}

export async function buildReveal(cross: CrossView, owner: TransactionSigner, nonce: bigint, price: bigint, quantity: bigint, salt: Uint8Array, order?: OrderFacts): Promise<Instruction> {
  if (cross.ext && !order) throw new Error('revealing an order of a cross with rules needs the order (its ending bucket and side)');
  const ix = getRevealOrderInstruction({
    owner,
    cross: cross.address,
    order: await orderAddress(cross.address, owner.address, nonce),
    shard: await shardAddress(cross.address, shardOfOrder(cross, owner.address, nonce, order)),
    price,
    quantity,
    salt,
  });
  return withAccounts(ix, await revealExtras(cross.ext ?? null, cross.address, order?.isBuy ?? false));
}

/** Merge instructions for every shard not yet merged, then the clear. Oracle-guarded crosses
 *  need `oraclePrice`: a Pyth `PriceUpdateV2` account for the pinned feed, normally posted in the
 *  same transaction (see Pyth's receiver SDK).
 *
 *  A cross with rules also merges the ending buckets up to the last counted one and the shards of a drawn extension, and its clear
 *  reads the accounts its rules name (`clearExtras`): pass `oracleAccounts` for every extra oracle feed it names, in order.
 *  A cross whose rules call for a draw (a drawn ending, a lottery, a drawn extension) cannot clear before the draw finishes:
 *  this throws `DrawRequired` until `draw_begin` and `draw_finish` have run (`buildDrawBegin`, `buildDrawFinish`). */
export async function buildSettleBook(cross: CrossView, opts: { oraclePrice?: Address; oracleAccounts?: readonly Address[]; now?: bigint; allowUndrawn?: boolean } = {}): Promise<Instruction[]> {
  const book = await bookAddress(cross.address);
  const x = cross.ext ?? null;
  const ixs: Instruction[] = [];
  if (x) {
    const now = opts.now ?? BigInt(Math.floor(Date.now() / 1000));
    const purpose = drawPurpose(x, cross.data.revealEndTs, now);
    if (purpose && !opts.allowUndrawn) throw new Error(`DrawRequired: this cross needs its ${purpose === 'end' ? 'ending' : 'extension'} draw to finish before it can clear (draw_begin, then draw_finish at least 20 slots later)`);
  }
  for (let i = 0; i < cross.data.shards; i++) {
    if ((cross.data.mergedMask >>> i) & 1) continue;
    ixs.push(getMergeShardInstruction({ cross: cross.address, book, shard: await shardAddress(cross.address, i) }));
  }
  if (x) {
    const merged = x.draw.auxMerged;
    if (x.ending.endingSecs > 0) {
      for (let b = 0; b <= lastBucket(x); b++) {
        const index = AUX_END_BASE + b;
        if ((merged & auxBit(index)) === 0n) ixs.push(getMergeShardInstruction({ cross: cross.address, book, shard: await shardAddress(cross.address, index) }));
      }
    }
    if (x.draw.epoch > 0) {
      for (const index of auxShardIndexes(x, Number(cross.data.shards)).filter((i) => i >= AUX_EXT_BASE)) {
        if ((merged & auxBit(index)) === 0n) ixs.push(getMergeShardInstruction({ cross: cross.address, book, shard: await shardAddress(cross.address, index) }));
      }
    }
  }
  if (cross.data.oracle.__option === 'Some' && !opts.oraclePrice) throw new Error('this cross has an oracle guard: pass a Pyth price update account');
  const clear = getClearInstruction({ cross: cross.address, book, ...(opts.oraclePrice ? { oraclePrice: opts.oraclePrice } : {}) });
  const calendar = cross.data.calendar.__option === 'Some' ? cross.data.calendar.value : null;
  ixs.push(withAccounts(clear, await clearExtras(x, cross.address, cross.data.baseMint, { ...(opts.oracleAccounts ? { oracleAccounts: opts.oracleAccounts } : {}), calendar })));
  return ixs;
}

/** Claim instructions for one order: creates the owner's base account if needed, then claims.
 *  Anyone may send them; proceeds always go to the order owner. A cross with lockups pays a locked buy into its lock vault: pass
 *  the order's facts (side and tail) so the vault and the lockup record go along. */
export async function buildClaim(cross: CrossView, payer: TransactionSigner, owner: Address, nonce: bigint, order?: OrderFacts): Promise<Instruction[]> {
  const c = cross.data;
  if (cross.ext && usesLocks(cross.ext) && !order) throw new Error('claiming on a cross with lockups needs the order (its side and lock terms)');
  const ixs: Instruction[] = [];
  const base = c.baseBound ? { baseMint: c.baseMint, ownerBase: await ata(owner, c.baseMint, c.baseTokenProgram) } : {};
  if (c.baseBound) {
    ixs.push(getCreateAssociatedTokenIdempotentInstruction({ payer, ata: base.ownerBase!, owner, mint: c.baseMint, tokenProgram: c.baseTokenProgram }));
  }
  const claim = getClaimInstruction({
    payer,
    cross: cross.address,
    owner,
    order: await orderAddress(cross.address, owner, nonce),
    quoteVault: await quoteVaultAddress(cross.address),
    ownerQuote: await ata(owner, c.quoteMint, c.quoteTokenProgram),
    ...base,
    ...(c.supplyMode === SupplyMode.Escrow ? { baseVault: await baseVaultAddress(cross.address) } : {}),
    quoteMint: c.quoteMint,
    baseTokenProgram: c.baseTokenProgram,
    quoteTokenProgram: c.quoteTokenProgram,
  });
  ixs.push(cross.ext && order ? withAccounts(claim, await claimExtras(cross.address, owner, nonce, order)) : claim);
  return ixs;
}

export async function buildFinalize(cross: CrossView, payer: TransactionSigner): Promise<Instruction> {
  const c = cross.data;
  const ix = getFinalizeInstruction({
    payer,
    cross: cross.address,
    ...(c.baseBound ? { baseMint: c.baseMint } : {}),
    ...(c.supplyMode === SupplyMode.Escrow
      ? { baseVault: await baseVaultAddress(cross.address), proceedsBase: await ata(c.proceedsTo, c.baseMint, c.baseTokenProgram) }
      : {}),
    quoteMint: c.quoteMint,
    quoteVault: await quoteVaultAddress(cross.address),
    feeRecipientQuote: await ata(c.feeRecipient, c.quoteMint, c.quoteTokenProgram),
    integratorQuote: await ata(c.integrator, c.quoteMint, c.quoteTokenProgram),
    proceedsQuote: await ata(c.proceedsTo, c.quoteMint, c.quoteTokenProgram),
    baseTokenProgram: c.baseTokenProgram,
    quoteTokenProgram: c.quoteTokenProgram,
  });
  // A referral share is paid to the referrer's quote account, passed after the named accounts.
  const x = cross.ext ?? null;
  return x && x.referral.shareBps > 0 ? withAccounts(ix, [writable(await ata(x.referral.referrer, c.quoteMint, c.quoteTokenProgram))]) : ix;
}

/** Finalize pays the protocol fee, the integrator fee, the proceeds and a named referrer's share into token accounts that must exist; a quote mint the
 *  fee recipient has never held has no such account yet. This creates whichever are missing (idempotent, paid by `payer`) and
 *  then finalizes, so one transaction finishes any cross, not only crosses whose accounts someone prepared. */
export async function buildFinalizeWithAccounts(cross: CrossView, payer: TransactionSigner): Promise<Instruction[]> {
  const c = cross.data;
  const ensure = async (owner: Address, mint: Address, tokenProgram: Address) => getCreateAssociatedTokenIdempotentInstruction({ payer, ata: await ata(owner, mint, tokenProgram), owner, mint, tokenProgram });
  // A cross whose rules name a referrer pays it a share of the protocol fee at finalize, so its account must exist too (ReferralAccountMissing otherwise).
  const referrer = cross.ext && cross.ext.referral.shareBps > 0 ? cross.ext.referral.referrer : null;
  const owners = [...new Set<Address>([c.feeRecipient, c.integrator, c.proceedsTo, ...(referrer ? [referrer] : [])])];
  const ixs: Instruction[] = [];
  for (const owner of owners) ixs.push(await ensure(owner, c.quoteMint, c.quoteTokenProgram));
  if (c.supplyMode === SupplyMode.Escrow) ixs.push(await ensure(c.proceedsTo, c.baseMint, c.baseTokenProgram));
  ixs.push(await buildFinalize(cross, payer));
  return ixs;
}

export function isSettled(state: CrossState): boolean {
  return state === CrossState.Cleared || state === CrossState.NoPrint;
}
export * from './oracle.js';
export * from './allowlist.js';
export * from './rules.js';
export * from './rules-check.js';
export * from './size.js';
export * from './series-schedule.js';
export * from './programs/index.js';
