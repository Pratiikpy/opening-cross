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
  CROSS_CORE_PROGRAM_ADDRESS,
  type Cross,
  type CreateCrossInstructionDataArgs,
  CrossState,
  Disclosure,
  OrderSide,
  SupplyMode,
  getCancelOrderInstruction,
  getClaimInstruction,
  getClearInstruction,
  getCommitOrderInstruction,
  getCreateCrossInstruction,
  getFinalizeInstruction,
  getInitShardInstruction,
  getMergeShardInstruction,
  getRevealOrderInstruction,
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

export type CrossView = { address: Address; data: Cross };

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
export async function buildCreateCross(input: CreateCrossInput): Promise<{ cross: Address; create: Instruction; shards: Instruction[] }> {
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
  return { cross, create, shards };
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
};

export async function buildPlaceOrder(input: PlaceOrderInput): Promise<Instruction> {
  const { cross, owner, nonce, side, price, quantity } = input;
  const c = cross.data;
  const sealed = c.disclosure === Disclosure.Sealed;
  const escrow = input.escrow ?? (side === OrderSide.Buy ? costCeil(quantity, price, c.priceScale) : quantity);
  const [order, orderBump] = await orderPda(cross.address, owner.address, nonce);
  let commitment: Uint8Array<ArrayBuffer> = new Uint8Array(32);
  if (sealed) {
    if (!input.salt) throw new Error('sealed crosses need a 32-byte salt');
    commitment = orderCommitment(cross.address, owner.address, nonce, side, price, quantity, input.salt);
  }
  const gateMint = c.gateMint.__option === 'Some' ? c.gateMint.value : null;
  return getCommitOrderInstruction({
    owner,
    protocol: await protocolAddress(),
    cross: cross.address,
    order,
    ...(sealed ? {} : { shard: await shardAddress(cross.address, shardIndexFor(owner.address, nonce, c.shards)) }),
    ...(gateMint ? { pass: await gatePassAddress(gateMint, owner.address) } : {}),
    ...(side === OrderSide.Buy
      ? { escrowMint: c.quoteMint, escrowVault: await quoteVaultAddress(cross.address), ownerEscrow: await ata(owner.address, c.quoteMint, c.quoteTokenProgram), escrowTokenProgram: c.quoteTokenProgram }
      : { escrowMint: c.baseMint, escrowVault: await baseVaultAddress(cross.address), ownerEscrow: await ata(owner.address, c.baseMint, c.baseTokenProgram), escrowTokenProgram: c.baseTokenProgram }),
    nonce,
    side,
    escrow,
    commitment,
    price: sealed ? 0n : price,
    quantity: sealed ? 0n : quantity,
    orderBump,
  });
}

export async function buildCancel(cross: CrossView, owner: TransactionSigner, nonce: bigint, side: OrderSide, revealed: boolean): Promise<Instruction> {
  const c = cross.data;
  return getCancelOrderInstruction({
    owner,
    cross: cross.address,
    order: await orderAddress(cross.address, owner.address, nonce),
    ...(revealed ? { shard: await shardAddress(cross.address, shardIndexFor(owner.address, nonce, c.shards)) } : {}),
    baseMint: c.baseMint,
    quoteMint: c.quoteMint,
    quoteVault: await quoteVaultAddress(cross.address),
    baseVault: await baseVaultAddress(cross.address),
    ...(side === OrderSide.Buy ? { ownerQuote: await ata(owner.address, c.quoteMint, c.quoteTokenProgram) } : { ownerBase: await ata(owner.address, c.baseMint, c.baseTokenProgram) }),
    baseTokenProgram: c.baseTokenProgram,
    quoteTokenProgram: c.quoteTokenProgram,
  });
}

export async function buildReveal(cross: CrossView, owner: TransactionSigner, nonce: bigint, price: bigint, quantity: bigint, salt: Uint8Array): Promise<Instruction> {
  return getRevealOrderInstruction({
    owner,
    cross: cross.address,
    order: await orderAddress(cross.address, owner.address, nonce),
    shard: await shardAddress(cross.address, shardIndexFor(owner.address, nonce, cross.data.shards)),
    price,
    quantity,
    salt,
  });
}

/** Merge instructions for every shard not yet merged, then the clear. Oracle-guarded crosses
 *  need `oraclePrice`: a Pyth `PriceUpdateV2` account for the pinned feed, normally posted in the
 *  same transaction (see Pyth's receiver SDK). */
export async function buildSettleBook(cross: CrossView, opts: { oraclePrice?: Address } = {}): Promise<Instruction[]> {
  const book = await bookAddress(cross.address);
  const ixs: Instruction[] = [];
  for (let i = 0; i < cross.data.shards; i++) {
    if ((cross.data.mergedMask >>> i) & 1) continue;
    ixs.push(getMergeShardInstruction({ cross: cross.address, book, shard: await shardAddress(cross.address, i) }));
  }
  if (cross.data.oracle.__option === 'Some' && !opts.oraclePrice) throw new Error('this cross has an oracle guard: pass a Pyth price update account');
  ixs.push(getClearInstruction({ cross: cross.address, book, ...(opts.oraclePrice ? { oraclePrice: opts.oraclePrice } : {}) }));
  return ixs;
}

/** Claim instructions for one order: creates the owner's base account if needed, then claims.
 *  Anyone may send them; proceeds always go to the order owner. */
export async function buildClaim(cross: CrossView, payer: TransactionSigner, owner: Address, nonce: bigint): Promise<Instruction[]> {
  const c = cross.data;
  const ixs: Instruction[] = [];
  const base = c.baseBound ? { baseMint: c.baseMint, ownerBase: await ata(owner, c.baseMint, c.baseTokenProgram) } : {};
  if (c.baseBound) {
    ixs.push(getCreateAssociatedTokenIdempotentInstruction({ payer, ata: base.ownerBase!, owner, mint: c.baseMint, tokenProgram: c.baseTokenProgram }));
  }
  ixs.push(
    getClaimInstruction({
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
    }),
  );
  return ixs;
}

export async function buildFinalize(cross: CrossView, payer: TransactionSigner): Promise<Instruction> {
  const c = cross.data;
  return getFinalizeInstruction({
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
}

export function isSettled(state: CrossState): boolean {
  return state === CrossState.Cleared || state === CrossState.NoPrint;
}
export * from './oracle.js';
export * from './allowlist.js';
