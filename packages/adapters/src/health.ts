// Liquidity health of a Meteora pool (ADR-0486 and ADR-0920, rows D9, X8, W9): depth, slippage at set sizes and persistence.
//
// Two layers live here.
//
// 1. The constant-product helpers (`quoteOut`, `slippageBps`, `depthAtSlippage`, `persistence`): a full-range DAMM v2 pool opened by the
//    adapter is full range, so its two vaults satisfy x * y = k and every figure is exact integer arithmetic on the vault balances.
//
// 2. Pool engines (ADR-0920): decoders for the on-chain accounts of a DAMM v2 pool and a DLMM pair (and its bin arrays), and a quote engine for
//    each that re-runs the venue's own swap arithmetic. DAMM v2 is priced with the cp-amm SDK's pure swap functions, which include the fee
//    scheduler, the dynamic fee and compounding pools. DLMM is a port of the swap loop in Meteora's `dlmm-sdk` ts-client (`swapQuote`,
//    `swapExactInQuoteAtBin`, `updateReference`, `updateVolatilityAccumulator`), with limit-order liquidity and both fee-collection modes.
//    Nothing here performs I/O: callers read the accounts and pass the bytes in.
//
// What is not modelled is stated where it matters: a DLMM bin array that is not passed in is treated as holding no liquidity, and the
// token-2022 transfer fee of a mint enters only through `withTransferFees`.
import BN from 'bn.js';
import { type Address, getAddressDecoder } from '@solana/kit';
import { CpAmm, type PoolState, deriveCustomizablePoolAddress, getLiquidityHandler, isSwapEnabled, swapQuoteExactInput } from '@meteora-ag/cp-amm-sdk';
import { Connection, PublicKey } from '@solana/web3.js';
import { DLMM_PROGRAM_ADDRESS, binPriceQ64, dlmmAddresses } from './dlmm.js';

const BPS = 10_000n;

export type Reserves = { reserveIn: bigint; reserveOut: bigint };

function check(r: Reserves) {
  if (r.reserveIn <= 0n || r.reserveOut <= 0n) throw new Error('both reserves must be positive');
}

/** Output of a constant-product swap of `amountIn` with the fee taken from the input (rounded down, as a pool rounds in its own favour). */
export function quoteOut(r: Reserves, amountIn: bigint, feeBps: number): bigint {
  check(r);
  if (amountIn < 0n) throw new Error('amountIn must not be negative');
  if (feeBps < 0 || feeBps >= 10_000) throw new Error('feeBps must be within [0, 10,000)');
  const net = (amountIn * (BPS - BigInt(feeBps))) / BPS;
  return (net * r.reserveOut) / (r.reserveIn + net);
}

/**
 * Slippage of a swap against the pool's mid price, in basis points, rounded up: how much worse than the mid price the
 * trader's average price is, fee included. Zero for a zero-size trade.
 */
export function slippageBps(r: Reserves, amountIn: bigint, feeBps: number): bigint {
  if (amountIn === 0n) return 0n;
  const out = quoteOut(r, amountIn, feeBps);
  // mid price gives amountIn * reserveOut / reserveIn; slippage = 1 - out / ideal.
  const ideal = (amountIn * r.reserveOut) / r.reserveIn;
  if (ideal === 0n) return BPS;
  if (out >= ideal) return 0n;
  return ((ideal - out) * BPS + ideal - 1n) / ideal;
}

/** The largest input whose slippage stays within `maxSlippageBps`, found by bisection on the monotone slippage curve. */
export function depthAtSlippage(r: Reserves, maxSlippageBps: bigint, feeBps: number): bigint {
  check(r);
  if (maxSlippageBps < 0n || maxSlippageBps >= BPS) throw new Error('maxSlippageBps must be within [0, 10,000)');
  if (slippageBps(r, 1n, feeBps) > maxSlippageBps && r.reserveIn < 1_000_000n) return 0n;
  let lo = 0n;
  let hi = r.reserveIn * 1_000n;
  while (lo < hi) {
    const mid = (lo + hi + 1n) / 2n;
    if (slippageBps(r, mid, feeBps) <= maxSlippageBps) lo = mid;
    else hi = mid - 1n;
  }
  return lo;
}

export type DepthSnapshot = { timestamp: number; reserveA: bigint; reserveB: bigint };

/**
 * Persistence: the share of the observed time, weighted by the gap to the next snapshot, during which the pool could absorb a
 * sell of `sizeIn` token A within `maxSlippageBps`. Snapshots must be in time order; the last one carries no weight.
 */
export function persistence(snapshots: DepthSnapshot[], sizeIn: bigint, maxSlippageBps: bigint, feeBps: number): number {
  let ok = 0;
  let total = 0;
  for (let i = 0; i + 1 < snapshots.length; i++) {
    const s = snapshots[i]!;
    const gap = snapshots[i + 1]!.timestamp - s.timestamp;
    if (gap < 0) throw new Error('snapshots must be in time order');
    total += gap;
    if (s.reserveA > 0n && s.reserveB > 0n && slippageBps({ reserveIn: s.reserveA, reserveOut: s.reserveB }, sizeIn, feeBps) <= maxSlippageBps) ok += gap;
  }
  return total === 0 ? 0 : ok / total;
}

// ---------------------------------------------------------------------------------------------------------------------
// Pool engines (ADR-0920)
// ---------------------------------------------------------------------------------------------------------------------

const U64_MAX = (1n << 64n) - 1n;
const Q64 = 1n << 64n;
const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

/** The Clock sysvar (`SysvarC1ock11111111111111111111111111111111`): the chain's own slot, epoch and time. */
export type ChainClock = { slot: bigint; epoch: bigint; unixTimestamp: bigint };
export const CLOCK_SYSVAR_ADDRESS = 'SysvarC1ock11111111111111111111111111111111';
export function decodeClock(data: Uint8Array): ChainClock {
  if (data.length < 40) throw new Error('the Clock sysvar is 40 bytes');
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return { slot: v.getBigUint64(0, true), epoch: v.getBigUint64(16, true), unixTimestamp: v.getBigInt64(32, true) };
}

/** A token-2022 transfer fee on one mint: `bps` of the amount moved, at most `maxFee` atoms (`spl-token-2022` `TransferFee::calculate_fee`). */
export type TransferFee = { bps: number; maxFee: bigint };
export function transferFeeOf(amount: bigint, fee: TransferFee | undefined): bigint {
  if (!fee || amount <= 0n || fee.bps <= 0) return 0n;
  const raw = ceilDiv(amount * BigInt(fee.bps), BPS);
  return raw > fee.maxFee ? fee.maxFee : raw;
}

/** Result of selling `amountIn` into a pool. `consumed` is what the pool took of it and `partial` is true when it could take no more. */
export type PoolSwap = { consumed: bigint; out: bigint; fee: bigint; partial: boolean };

/**
 * A pool seen through one interface. Token A is DAMM's token A and DLMM's token X; `aToB` means selling token A for token B.
 * `midQ64` is the price of one atom of A in atoms of B, Q64.64.
 */
export type PoolEngine = {
  kind: 'damm-v2' | 'dlmm';
  swap(aToB: boolean, amountIn: bigint): PoolSwap;
  /** The largest sell of one token that stays within `maxSlippageBps` of the mid price (`engineDepth` on this engine). */
  depth(aToB: boolean, maxSlippageBps: bigint): DepthResult;
  midQ64: bigint;
  reserveA: bigint;
  reserveB: bigint;
};
/** An engine without its depth method: what a venue supplies; `withDepth` completes it. */
type BareEngine = Omit<PoolEngine, 'depth'>;
function withDepth(bare: BareEngine): PoolEngine {
  const e: PoolEngine = { ...bare, depth: (aToB, limit) => engineDepth(e, aToB, limit) };
  return e;
}

/** Slippage of selling `amountIn`, in basis points rounded up, against the pool's mid price, fee included. A trade the pool cannot fully absorb is 10,000. */
export function engineSlippageBps(e: BareEngine, aToB: boolean, amountIn: bigint): bigint {
  if (amountIn <= 0n) return 0n;
  const r = e.swap(aToB, amountIn);
  if (r.partial || r.consumed < amountIn) return BPS;
  const ideal = aToB ? (amountIn * e.midQ64) / Q64 : (amountIn * Q64) / e.midQ64;
  if (ideal === 0n) return BPS;
  if (r.out >= ideal) return 0n;
  return ((ideal - r.out) * BPS + ideal - 1n) / ideal;
}

/** Output atoms below which integer rounding alone moves the slippage by more than a basis point: sizes under this are not meaningful. */
const DUST_OUT = 10_000n;

export type DepthResult = { maxIn: bigint; out: bigint; slippageBps: bigint };

/**
 * The largest input whose slippage stays within `maxSlippageBps`. Slippage grows with size above rounding dust, so the search doubles
 * from the smallest meaningful size until the limit is crossed and then bisects. Zero when even the smallest meaningful trade is over
 * the limit (the pool's fee or its distance from mid is above it).
 */
export function engineDepth(e: BareEngine, aToB: boolean, maxSlippageBps: bigint): DepthResult {
  if (maxSlippageBps < 0n || maxSlippageBps >= BPS) throw new Error('maxSlippageBps must be within [0, 10,000)');
  const mid = e.midQ64;
  if (mid <= 0n) return { maxIn: 0n, out: 0n, slippageBps: 0n };
  let lo = aToB ? ceilDiv(DUST_OUT * Q64, mid) : ceilDiv(DUST_OUT * mid, Q64);
  if (lo < 1n) lo = 1n;
  if (lo > U64_MAX || engineSlippageBps(e, aToB, lo) > maxSlippageBps) return { maxIn: 0n, out: 0n, slippageBps: 0n };
  let hi = lo * 2n;
  while (hi <= U64_MAX && engineSlippageBps(e, aToB, hi) <= maxSlippageBps) {
    lo = hi;
    hi *= 2n;
  }
  if (hi > U64_MAX) hi = U64_MAX + 1n;
  // lo satisfies the limit, hi does not (or is past the largest amount a transfer can carry).
  while (hi - lo > 1n) {
    const m = (lo + hi) / 2n;
    if (engineSlippageBps(e, aToB, m) <= maxSlippageBps) lo = m;
    else hi = m;
  }
  const r = e.swap(aToB, lo);
  return { maxIn: lo, out: r.out, slippageBps: engineSlippageBps(e, aToB, lo) };
}

/** The same pool as seen by a trader who pays the token-2022 transfer fee of each mint: the pool receives the input less the input mint's fee, and the trader receives the output less the output mint's fee. */
export function withTransferFees(e: PoolEngine, feeA: TransferFee | undefined, feeB: TransferFee | undefined): PoolEngine {
  if (!feeA && !feeB) return e;
  return withDepth({
    ...e,
    swap(aToB, amountIn) {
      const feeIn = aToB ? feeA : feeB;
      const feeOut = aToB ? feeB : feeA;
      // The pool sees what is left of the input after its mint's fee; a partial fill is grossed back up by the same fee.
      const netIn = amountIn - transferFeeOf(amountIn, feeIn);
      const r = e.swap(aToB, netIn);
      return { consumed: r.partial ? r.consumed + transferFeeOf(r.consumed, feeIn) : amountIn, out: r.out - transferFeeOf(r.out, feeOut), fee: r.fee, partial: r.partial };
    },
  });
}

// ---- DLMM -----------------------------------------------------------------------------------------------------------

export const DLMM_BINS_PER_ARRAY = 70;
const LB_PAIR_DISCRIMINATOR = [33, 11, 49, 98, 181, 101, 177, 13];
const BIN_ARRAY_DISCRIMINATOR = [92, 142, 92, 220, 5, 148, 70, 181];
const LB_PAIR_SIZE = 8 + 896;
const BIN_SIZE = 144;
const BIN_ARRAY_SIZE = 8 + 8 + 8 + 32 + DLMM_BINS_PER_ARRAY * BIN_SIZE;
const FEE_PRECISION = 1_000_000_000n;
const MAX_FEE_RATE = 100_000_000n;
const BASIS_POINT_MAX = 10_000n;

export type DlmmPairType = 'permissionless' | 'permissioned' | 'customizable-permissionless' | 'permissionless-v2';
export type LbPairState = {
  params: {
    baseFactor: number;
    filterPeriod: number;
    decayPeriod: number;
    reductionFactor: number;
    variableFeeControl: number;
    maxVolatilityAccumulator: number;
    minBinId: number;
    maxBinId: number;
    protocolShare: number;
    baseFeePowerFactor: number;
    /** 0 undetermined, 1 liquidity mining, 2 limit order. */
    functionType: number;
    /** 0 fee on the input, 1 fee on token Y only. */
    collectFeeMode: number;
  };
  vars: { volatilityAccumulator: number; volatilityReference: number; indexReference: number; lastUpdateTimestamp: bigint };
  activeId: number;
  binStep: number;
  /** 0 enabled, 1 disabled. */
  status: number;
  pairType: DlmmPairType;
  /** 0 slot, 1 timestamp. */
  activationType: number;
  activationPoint: bigint;
  preActivationDuration: bigint;
  preActivationSwapAddress: Address;
  creatorPoolOnOffControl: boolean;
  tokenXMint: Address;
  tokenYMint: Address;
  reserveX: Address;
  reserveY: Address;
  /** True when at least one liquidity-mining reward has been set up on the pair. */
  hasRewards: boolean;
  creator: Address;
  /** The pair's oracle account (volatility observations); a swap names it. */
  oracle: Address;
  protocolFeeX: bigint;
  protocolFeeY: bigint;
};

const PAIR_TYPES: DlmmPairType[] = ['permissionless', 'permissioned', 'customizable-permissionless', 'permissionless-v2'];
const addressDecoder = getAddressDecoder();
const isDiscriminated = (data: Uint8Array, d: number[]) => data.length >= 8 && d.every((b, i) => data[i] === b);
const viewOf = (data: Uint8Array) => new DataView(data.buffer, data.byteOffset, data.byteLength);
const u128 = (v: DataView, o: number) => v.getBigUint64(o, true) | (v.getBigUint64(o + 8, true) << 64n);

/** Decodes a DLMM `LbPair` account (Meteora `lb_clmm`, layout of `idls/dlmm.json`). */
export function decodeLbPair(data: Uint8Array): LbPairState {
  if (data.length < LB_PAIR_SIZE || !isDiscriminated(data, LB_PAIR_DISCRIMINATOR)) throw new Error('not a DLMM LbPair account');
  const v = viewOf(data);
  const P = 8;
  const addr = (o: number) => addressDecoder.decode(data.subarray(P + o, P + o + 32));
  const zero = '11111111111111111111111111111111';
  const rewardMint = (i: number) => addr(256 + i * 144);
  const pairType = PAIR_TYPES[data[P + 67]!];
  if (!pairType) throw new Error(`unknown DLMM pair type ${data[P + 67]}`);
  return {
    params: {
      baseFactor: v.getUint16(P + 0, true),
      filterPeriod: v.getUint16(P + 2, true),
      decayPeriod: v.getUint16(P + 4, true),
      reductionFactor: v.getUint16(P + 6, true),
      variableFeeControl: v.getUint32(P + 8, true),
      maxVolatilityAccumulator: v.getUint32(P + 12, true),
      minBinId: v.getInt32(P + 16, true),
      maxBinId: v.getInt32(P + 20, true),
      protocolShare: v.getUint16(P + 24, true),
      baseFeePowerFactor: data[P + 26]!,
      functionType: data[P + 27]!,
      collectFeeMode: data[P + 28]!,
    },
    vars: {
      volatilityAccumulator: v.getUint32(P + 32, true),
      volatilityReference: v.getUint32(P + 36, true),
      indexReference: v.getInt32(P + 40, true),
      lastUpdateTimestamp: v.getBigInt64(P + 48, true),
    },
    activeId: v.getInt32(P + 68, true),
    binStep: v.getUint16(P + 72, true),
    status: data[P + 74]!,
    pairType,
    activationType: data[P + 78]!,
    creatorPoolOnOffControl: data[P + 79]! === 1,
    tokenXMint: addr(80),
    tokenYMint: addr(112),
    reserveX: addr(144),
    reserveY: addr(176),
    protocolFeeX: v.getBigUint64(P + 208, true),
    protocolFeeY: v.getBigUint64(P + 216, true),
    hasRewards: rewardMint(0) !== zero || rewardMint(1) !== zero,
    preActivationSwapAddress: addr(744),
    activationPoint: v.getBigUint64(P + 808, true),
    preActivationDuration: v.getBigUint64(P + 816, true),
    creator: addr(840),
    oracle: addr(544),
  };
}

export type DlmmBin = {
  amountX: bigint;
  amountY: bigint;
  /** Price of the bin, Y atoms per X atom, Q64.64. Zero for a bin nothing was ever added to. */
  price: bigint;
  openOrderAmount: bigint;
  processedOrderRemaining: bigint;
  /** True when the resting limit orders in the bin sell token X. */
  orderAskSide: boolean;
};
export type DlmmBinArray = { index: number; lbPair: Address; bins: DlmmBin[] };

/** Decodes a DLMM `BinArray` account: 70 bins of 144 bytes after a 56-byte header. */
export function decodeBinArray(data: Uint8Array): DlmmBinArray {
  if (data.length < BIN_ARRAY_SIZE || !isDiscriminated(data, BIN_ARRAY_DISCRIMINATOR)) throw new Error('not a DLMM BinArray account');
  const v = viewOf(data);
  const bins: DlmmBin[] = [];
  for (let i = 0; i < DLMM_BINS_PER_ARRAY; i++) {
    const o = 56 + i * BIN_SIZE;
    bins.push({
      amountX: v.getBigUint64(o, true),
      amountY: v.getBigUint64(o + 8, true),
      price: u128(v, o + 16),
      openOrderAmount: v.getBigUint64(o + 112, true),
      processedOrderRemaining: v.getBigUint64(o + 128, true),
      orderAskSide: data[o + 140]! === 1,
    });
  }
  return { index: Number(v.getBigInt64(8, true)), lbPair: addressDecoder.decode(data.subarray(24, 56)), bins };
}

/** The chain's own test for whether a pair accepts swaps now (`lb_clmm` rejects a pair that is disabled or, for the permissioned and customizable kinds, not yet activated). */
export function dlmmSwapStatus(pair: LbPairState, clock: Pick<ChainClock, 'slot' | 'unixTimestamp'>, initiator?: Address): { open: boolean; reason: string | null; opensAtPoint: bigint | null; pointUnit: 'slot' | 'timestamp' } {
  const pointUnit = pair.activationType === 0 ? 'slot' : 'timestamp';
  if (pair.status === 1) return { open: false, reason: 'the pair is disabled', opensAtPoint: null, pointUnit };
  if (pair.pairType === 'permissioned' || pair.pairType === 'customizable-permissionless') {
    const now = pair.activationType === 0 ? clock.slot : clock.unixTimestamp;
    const zero = '11111111111111111111111111111111';
    const early = pair.preActivationSwapAddress !== zero && initiator !== undefined && pair.preActivationSwapAddress === initiator;
    const at = early ? pair.activationPoint - pair.preActivationDuration : pair.activationPoint;
    if (now < at) return { open: false, reason: `the pair opens at ${pointUnit} ${at}`, opensAtPoint: at, pointUnit };
  }
  return { open: true, reason: null, opensAtPoint: null, pointUnit };
}

/** Total fee of a swap at the given volatility accumulator, in 1e9 units (`dlmm-sdk` `getTotalFee`): base fee plus the variable fee, capped at 10%. */
export function dlmmFeeRate(pair: Pick<LbPairState, 'binStep' | 'params'>, volatilityAccumulator: number): bigint {
  const s = pair.params;
  const base = BigInt(s.baseFactor) * BigInt(pair.binStep) * 10n * 10n ** BigInt(s.baseFeePowerFactor);
  let variable = 0n;
  if (s.variableFeeControl > 0) {
    const square = (BigInt(volatilityAccumulator) * BigInt(pair.binStep)) ** 2n;
    variable = (BigInt(s.variableFeeControl) * square + 99_999_999_999n) / 100_000_000_000n;
  }
  const total = base + variable;
  return total > MAX_FEE_RATE ? MAX_FEE_RATE : total;
}

const excludeFee = (included: bigint, rate: bigint) => {
  const fee = ceilDiv(included * rate, FEE_PRECISION);
  return { excluded: included - fee, fee };
};
const includeFee = (excluded: bigint, rate: bigint) => {
  const included = ceilDiv(excluded * FEE_PRECISION, FEE_PRECISION - rate);
  return { included, fee: included - excluded };
};

const amountOutOfBin = (price: bigint, amountIn: bigint, swapForY: boolean) => (swapForY ? (amountIn * price) / Q64 : (amountIn * Q64) / price);
const amountInOfBin = (price: bigint, amountOut: bigint, swapForY: boolean) => (swapForY ? ceilDiv(amountOut * Q64, price) : ceilDiv(amountOut * price, Q64));

function supportsLimitOrders(pair: LbPairState): boolean {
  if (pair.params.functionType === 2) return true;
  if (pair.params.functionType === 1) return false;
  if (pair.params.functionType === 0) return !pair.hasRewards;
  throw new Error(`unknown DLMM function type ${pair.params.functionType}`);
}

/** Orders that fill a swap in this direction: bid-side orders pay out Y to a sell of X, ask-side orders pay out X to a buy. */
function ordersFor(bin: DlmmBin, swapForY: boolean): { open: bigint; processed: bigint } {
  if ((swapForY && !bin.orderAskSide) || (!swapForY && bin.orderAskSide)) return { open: bin.openOrderAmount, processed: bin.processedOrderRemaining };
  return { open: 0n, processed: 0n };
}

/** What the bin can pay out in this direction: the market-making amount plus the limit orders on the paying side. */
function binMaxOut(bin: DlmmBin, swapForY: boolean, orders: boolean): bigint {
  const mm = swapForY ? bin.amountY : bin.amountX;
  if (!orders) return mm;
  const total = bin.openOrderAmount + bin.processedOrderRemaining;
  const paysX = bin.orderAskSide;
  return mm + (swapForY ? (paysX ? 0n : total) : paysX ? total : 0n);
}

function fillOnce(price: bigint, amount: bigint, maxOut: bigint, swapForY: boolean) {
  const maxIn = amountInOfBin(price, maxOut, swapForY);
  if (amount >= maxIn) return { amountIn: maxIn, left: amount - maxIn, out: maxOut };
  return { amountIn: amount, left: 0n, out: amountOutOfBin(price, amount, swapForY) };
}

function fillExactIn(bin: DlmmBin, price: bigint, amount: bigint, swapForY: boolean, orders: boolean) {
  const mm = fillOnce(price, amount, swapForY ? bin.amountY : bin.amountX, swapForY);
  if (!orders) return { amountIn: mm.amountIn, left: mm.left, out: mm.out };
  let amountIn = mm.amountIn;
  let out = mm.out;
  let left = mm.left;
  if (left !== 0n) {
    const o = ordersFor(bin, swapForY);
    const processed = fillOnce(price, left, o.processed, swapForY);
    amountIn += processed.amountIn;
    out += processed.out;
    left = processed.left;
    if (left !== 0n) {
      const open = fillOnce(price, left, o.open, swapForY);
      amountIn += open.amountIn;
      out += open.out;
      left = open.left;
    }
  }
  return { amountIn, left: amount - amountIn, out };
}

function swapAtBin(bin: DlmmBin, price: bigint, rate: bigint, inAmount: bigint, swapForY: boolean, orders: boolean, feeOnInput: boolean) {
  let fee = 0n;
  let excludedIn = inAmount;
  if (feeOnInput) {
    const x = excludeFee(inAmount, rate);
    fee = x.fee;
    excludedIn = x.excluded;
  }
  const fill = fillExactIn(bin, price, excludedIn, swapForY, orders);
  let includedIn = inAmount;
  if (fill.left !== 0n) {
    excludedIn -= fill.left;
    if (feeOnInput) {
      const x = includeFee(excludedIn, rate);
      fee = x.fee;
      includedIn = x.included;
    } else includedIn = excludedIn;
  }
  let out = fill.out;
  if (!feeOnInput) {
    const x = excludeFee(fill.out, rate);
    fee = x.fee;
    out = x.excluded;
  }
  return { amountIn: includedIn, amountOut: out, fee };
}

export type DlmmQuote = PoolSwap & {
  startActiveId: number;
  /** The last bin that was traded in. */
  endActiveId: number;
  binsCrossed: number;
  /** Bin arrays the swap touched, in order: the accounts a transaction must pass. */
  arraysTouched: number[];
};

/**
 * Prices selling `amountIn` of token X (`swapForY`) or of token Y into a DLMM pair, bin by bin (`dlmm-sdk` `swapQuote`). The volatility
 * references are decayed to `nowSeconds` first, as the program does, and the variable fee is recomputed in every bin the swap enters. A bin array that
 * is not in `arrays` holds no liquidity as far as this quote goes: when the trade needs more than the arrays hold, the result is partial.
 */
export function dlmmQuoteExactIn(p: { pair: LbPairState; arrays: Iterable<DlmmBinArray>; swapForY: boolean; amountIn: bigint; nowSeconds: bigint }): DlmmQuote {
  const { pair, swapForY } = p;
  const byIndex = new Map<number, DlmmBinArray>();
  for (const a of p.arrays) byIndex.set(a.index, a);
  const indexes = [...byIndex.keys()].sort((a, b) => a - b);
  const s = pair.params;
  const v = { ...pair.vars };
  // updateReference
  const elapsed = p.nowSeconds - v.lastUpdateTimestamp;
  if (elapsed >= BigInt(s.filterPeriod)) {
    v.indexReference = pair.activeId;
    v.volatilityReference = elapsed < BigInt(s.decayPeriod) ? Number((BigInt(v.volatilityAccumulator) * BigInt(s.reductionFactor)) / BASIS_POINT_MAX) : 0;
  }
  const orders = supportsLimitOrders(pair);
  let feeOnInput: boolean;
  if (s.collectFeeMode === 0) feeOnInput = true;
  else if (s.collectFeeMode === 1) feeOnInput = !swapForY;
  else throw new Error(`unknown DLMM collect fee mode ${s.collectFeeMode}`);

  let left = p.amountIn;
  let out = 0n;
  let fee = 0n;
  let active = pair.activeId;
  let lastFilled = pair.activeId;
  let crossed = 0;
  const touched: number[] = [];
  let guard = 0;
  while (left > 0n) {
    if (active < s.minBinId || active > s.maxBinId || ++guard > 1_000_000) break;
    const idx = Math.floor(active / DLMM_BINS_PER_ARRAY);
    const arr = byIndex.get(idx);
    if (!arr) {
      // Nothing is loaded here: skip to the nearest loaded array in the direction of travel, or stop.
      const next = swapForY ? [...indexes].reverse().find((i) => i < idx) : indexes.find((i) => i > idx);
      if (next === undefined) break;
      active = swapForY ? (next + 1) * DLMM_BINS_PER_ARRAY - 1 : next * DLMM_BINS_PER_ARRAY;
      continue;
    }
    const bin = arr.bins[active - idx * DLMM_BINS_PER_ARRAY]!;
    if (binMaxOut(bin, swapForY, orders) > 0n) {
      // updateVolatilityAccumulator
      const acc = BigInt(v.volatilityReference) + BigInt(Math.abs(v.indexReference - active)) * BASIS_POINT_MAX;
      v.volatilityAccumulator = Number(acc > BigInt(s.maxVolatilityAccumulator) ? BigInt(s.maxVolatilityAccumulator) : acc);
      const price = bin.price > 0n ? bin.price : binPriceQ64(active, pair.binStep);
      const r = swapAtBin(bin, price, dlmmFeeRate(pair, v.volatilityAccumulator), left, swapForY, orders, feeOnInput);
      if (r.amountIn > 0n) {
        left -= r.amountIn;
        out += r.amountOut;
        fee += r.fee;
        lastFilled = active;
        crossed++;
        if (touched[touched.length - 1] !== idx) touched.push(idx);
      }
    }
    if (left > 0n) active += swapForY ? -1 : 1;
  }
  return { consumed: p.amountIn - left, out, fee, partial: left > 0n, startActiveId: pair.activeId, endActiveId: lastFilled, binsCrossed: crossed, arraysTouched: touched };
}

/** The pair as a `PoolEngine`; reserves are what the loaded bin arrays hold (market-making amounts plus resting orders). */
export function dlmmEngine(p: { pair: LbPairState; arrays: DlmmBinArray[]; nowSeconds: bigint }): PoolEngine {
  let reserveA = 0n;
  let reserveB = 0n;
  for (const a of p.arrays) {
    for (const b of a.bins) {
      reserveA += b.amountX;
      reserveB += b.amountY;
      const orders = b.openOrderAmount + b.processedOrderRemaining;
      if (b.orderAskSide) reserveA += orders;
      else reserveB += orders;
    }
  }
  // The active bin's own stored price when its array is loaded (the program's rounding), else the same price recomputed.
  const idx = Math.floor(p.pair.activeId / DLMM_BINS_PER_ARRAY);
  const stored = p.arrays.find((a) => a.index === idx)?.bins[p.pair.activeId - idx * DLMM_BINS_PER_ARRAY]?.price ?? 0n;
  return withDepth({
    kind: 'dlmm',
    midQ64: stored > 0n ? stored : binPriceQ64(p.pair.activeId, p.pair.binStep),
    reserveA,
    reserveB,
    swap: (aToB, amountIn) => {
      const q = dlmmQuoteExactIn({ pair: p.pair, arrays: p.arrays, swapForY: aToB, amountIn, nowSeconds: p.nowSeconds });
      return { consumed: q.consumed, out: q.out, fee: q.fee, partial: q.partial };
    },
  });
}

export type DlmmLadderBin = {
  binId: number;
  /** Y atoms per X atom, Q64.64. */
  priceQ64: bigint;
  amountX: bigint;
  amountY: bigint;
  /** Resting limit orders in the bin, in the token they sell. */
  orderAmount: bigint;
  orderSide: 'ask' | 'bid' | null;
  /** Where the bin sits against the active bin: the active bin itself, asks above it (token X), bids below it (token Y). */
  role: 'active' | 'ask' | 'bid';
  /** Token X offered from the active bin up to and including this bin; zero for bids. */
  cumulativeX: bigint;
  /** Token Y bid from the active bin down to and including this bin; zero for asks. */
  cumulativeY: bigint;
};

/** The bins that hold liquidity within `binsEachSide` of the active bin, with prices and running totals: the depth chart of the pair. */
export function dlmmLadder(p: { pair: LbPairState; arrays: DlmmBinArray[]; binsEachSide: number }): DlmmLadderBin[] {
  const byIndex = new Map(p.arrays.map((a) => [a.index, a] as const));
  const at = (id: number): DlmmBin | undefined => byIndex.get(Math.floor(id / DLMM_BINS_PER_ARRAY))?.bins[id - Math.floor(id / DLMM_BINS_PER_ARRAY) * DLMM_BINS_PER_ARRAY];
  const out: DlmmLadderBin[] = [];
  const row = (id: number, role: DlmmLadderBin['role'], cumX: bigint, cumY: bigint): DlmmLadderBin | null => {
    const b = at(id);
    if (!b) return null;
    const orderAmount = b.openOrderAmount + b.processedOrderRemaining;
    if (b.amountX === 0n && b.amountY === 0n && orderAmount === 0n && role !== 'active') return null;
    return { binId: id, priceQ64: b.price > 0n ? b.price : binPriceQ64(id, p.pair.binStep), amountX: b.amountX, amountY: b.amountY, orderAmount, orderSide: orderAmount === 0n ? null : b.orderAskSide ? 'ask' : 'bid', role, cumulativeX: cumX, cumulativeY: cumY };
  };
  let cumX = 0n;
  let cumY = 0n;
  const bidsDown: DlmmLadderBin[] = [];
  const asksUp: DlmmLadderBin[] = [];
  const activeBin = at(p.pair.activeId);
  if (activeBin) {
    cumX += activeBin.amountX + (activeBin.orderAskSide ? activeBin.openOrderAmount + activeBin.processedOrderRemaining : 0n);
    cumY += activeBin.amountY + (activeBin.orderAskSide ? 0n : activeBin.openOrderAmount + activeBin.processedOrderRemaining);
    const r = row(p.pair.activeId, 'active', cumX, cumY);
    if (r) out.push(r);
  }
  let x = cumX;
  for (let i = 1; i <= p.binsEachSide; i++) {
    const id = p.pair.activeId + i;
    const b = at(id);
    if (b) x += b.amountX + (b.orderAskSide ? b.openOrderAmount + b.processedOrderRemaining : 0n);
    const r = row(id, 'ask', x, 0n);
    if (r) asksUp.push(r);
  }
  let y = cumY;
  for (let i = 1; i <= p.binsEachSide; i++) {
    const id = p.pair.activeId - i;
    const b = at(id);
    if (b) y += b.amountY + (b.orderAskSide ? 0n : b.openOrderAmount + b.processedOrderRemaining);
    const r = row(id, 'bid', 0n, y);
    if (r) bidsDown.push(r);
  }
  return [...bidsDown.reverse(), ...out, ...asksUp];
}

// ---- DAMM v2 --------------------------------------------------------------------------------------------------------

export type DammPool = PoolState;

/** The address of the customizable DAMM v2 pool for two mints (the one `seed_damm_v2` creates): it depends on the mints alone, in either order. */
export function dammCanonicalPool(mintA: Address, mintB: Address): Address {
  return deriveCustomizablePoolAddress(new PublicKey(mintA), new PublicKey(mintB)).toBase58() as Address;
}
/** The address of the DLMM pair the adapter opens for two mints (the one `open_dlmm_pair` creates). */
export function dlmmCanonicalPair(baseMint: Address, quoteMint: Address): Address {
  return dlmmAddresses(baseMint, quoteMint).lbPair;
}
export type MeteoraPoolKind = 'damm-v2' | 'dlmm';
/** Which Meteora pool an account is, from its owner and discriminator; null for anything else. */
export function meteoraPoolKind(account: { owner: Address; data: Uint8Array }): MeteoraPoolKind | null {
  if (account.owner === DLMM_PROGRAM_ADDRESS && isDiscriminated(account.data, LB_PAIR_DISCRIMINATOR)) return 'dlmm';
  if (account.owner === DAMM_V2_OWNER && isDiscriminated(account.data, DAMM_POOL_DISCRIMINATOR)) return 'damm-v2';
  return null;
}
const DAMM_V2_OWNER = 'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG';
// anchor discriminator of the cp-amm `Pool` account: the first 8 bytes of sha256("account:Pool")
const DAMM_POOL_DISCRIMINATOR = [241, 154, 109, 4, 17, 177, 109, 188];
let dammClient: CpAmm | undefined;

/** Decodes a DAMM v2 `Pool` account with the cp-amm SDK's own coder (no connection is used). */
export function decodeDammPool(data: Uint8Array): DammPool {
  dammClient ??= new CpAmm(new Connection('http://127.0.0.1:1'));
  try {
    return dammClient._program.coder.accounts.decode('pool', Buffer.from(data)) as DammPool;
  } catch (e) {
    throw new Error(`not a DAMM v2 Pool account: ${e instanceof Error ? e.message : String(e)}`);
  }
}

const bn = (x: bigint) => new BN(x.toString());
const big = (x: { toString(radix?: number): string }) => BigInt(x.toString(10));

/** The point the pool measures time in: a slot or a unix timestamp, by the pool's activation type. */
export function dammCurrentPoint(pool: DammPool, clock: Pick<ChainClock, 'slot' | 'unixTimestamp'>): bigint {
  return pool.activationType === 0 ? clock.slot : clock.unixTimestamp;
}

export function dammSwapStatus(pool: DammPool, currentPoint: bigint): { open: boolean; reason: string | null; opensAtPoint: bigint | null; pointUnit: 'slot' | 'timestamp' } {
  const pointUnit = pool.activationType === 0 ? 'slot' : 'timestamp';
  if (pool.poolStatus === 1) return { open: false, reason: 'the pool is disabled', opensAtPoint: null, pointUnit };
  if (!isSwapEnabled(pool, bn(currentPoint))) return { open: false, reason: `the pool opens at ${pointUnit} ${big(pool.activationPoint)}`, opensAtPoint: big(pool.activationPoint), pointUnit };
  return { open: true, reason: null, opensAtPoint: null, pointUnit };
}

/** Token amounts the pool holds for liquidity providers, from its own liquidity handler (concentrated or compounding). Fees waiting to be claimed are not included. */
export function dammReserves(pool: DammPool): { reserveA: bigint; reserveB: bigint } {
  const [a, b] = getLiquidityHandler(pool).getReservesAmount();
  return { reserveA: big(a), reserveB: big(b) };
}

/** Price of one atom of token A in atoms of token B, Q64.64. */
export function dammMidQ64(pool: DammPool): bigint {
  if (pool.collectFeeMode === 2) {
    const r = dammReserves(pool);
    return r.reserveA === 0n ? 0n : (r.reserveB * Q64) / r.reserveA;
  }
  const s = big(pool.sqrtPrice);
  return (s * s) / Q64;
}

/** The pool as a `PoolEngine`, priced with the SDK's `swapQuoteExactInput` at `currentPoint`. A trade the SDK refuses (swaps off, input beyond the price range) is reported as taking nothing. */
export function dammEngine(p: { pool: DammPool; currentPoint: bigint; decimalsA: number; decimalsB: number }): PoolEngine {
  const r = dammReserves(p.pool);
  return withDepth({
    kind: 'damm-v2',
    midQ64: dammMidQ64(p.pool),
    reserveA: r.reserveA,
    reserveB: r.reserveB,
    swap: (aToB, amountIn) => {
      if (amountIn <= 0n) return { consumed: 0n, out: 0n, fee: 0n, partial: false };
      try {
        const q = swapQuoteExactInput(p.pool, bn(p.currentPoint), bn(amountIn), 0, aToB, false, p.decimalsA, p.decimalsB);
        const fee = big(q.claimingFee) + big(q.protocolFee) + big(q.compoundingFee) + big(q.referralFee);
        const left = big(q.amountLeft);
        return { consumed: amountIn - left, out: big(q.outputAmount), fee, partial: left > 0n };
      } catch (e) {
        // The SDK refuses an input too small to return one atom ("Amount out must be greater than 0"): the pool takes it and returns nothing.
        // Anything else (the input would carry the price out of its range, swaps not enabled yet) is an input the pool cannot take.
        if (e instanceof Error && /greater than 0/.test(e.message)) return { consumed: amountIn, out: 0n, fee: 0n, partial: false };
        return { consumed: 0n, out: 0n, fee: 0n, partial: true };
      }
    },
  });
}

// ---- Health report ----------------------------------------------------------------------------------------------------

/** Slippage limits the report gives the depth of, in basis points. */
export const HEALTH_SLIPPAGE_LEVELS_BPS = [10n, 25n, 50n, 100n, 300n, 1_000n] as const;

export type EngineHealth = {
  kind: PoolEngine['kind'];
  midQ64: bigint;
  reserveA: bigint;
  reserveB: bigint;
  /** Everything the pool holds, valued in token B at the mid price. */
  tvlInB: bigint;
  /** For each slippage limit, the largest sell of A (into B) and the largest sell of B (into A) within it. */
  depth: { maxSlippageBps: bigint; sellA: DepthResult; sellB: DepthResult }[];
};

/** Depth at each slippage limit, both ways. */
export function engineHealth(e: PoolEngine, levels: readonly bigint[] = HEALTH_SLIPPAGE_LEVELS_BPS): EngineHealth {
  return {
    kind: e.kind,
    midQ64: e.midQ64,
    reserveA: e.reserveA,
    reserveB: e.reserveB,
    tvlInB: e.reserveB + (e.reserveA * e.midQ64) / Q64,
    depth: levels.map((l) => ({ maxSlippageBps: l, sellA: engineDepth(e, true, l), sellB: engineDepth(e, false, l) })),
  };
}

/** Slippage of selling each size of `aToB`'s input token, in basis points (10,000 when the pool cannot absorb it). */
export function slippageAtSizes(e: PoolEngine, aToB: boolean, sizes: readonly bigint[]): { amountIn: bigint; out: bigint; slippageBps: bigint }[] {
  return sizes.map((amountIn) => ({ amountIn, out: e.swap(aToB, amountIn).out, slippageBps: engineSlippageBps(e, aToB, amountIn) }));
}

export type DepthSample = { timestamp: number; maxIn: bigint };

/**
 * Persistence from observed depth: the share of the observed time, weighted by the gap to the next sample, during which the pool could
 * absorb at least `size` within the slippage limit the samples were taken at. Unlike `persistence`, it needs no model of the pool, so it
 * serves DLMM pairs as well. The last sample carries no weight; samples must be in time order.
 */
export function depthPersistence(samples: readonly DepthSample[], size: bigint): number {
  let ok = 0;
  let total = 0;
  for (let i = 0; i + 1 < samples.length; i++) {
    const s = samples[i]!;
    const gap = samples[i + 1]!.timestamp - s.timestamp;
    if (gap < 0) throw new Error('samples must be in time order');
    total += gap;
    if (s.maxIn >= size) ok += gap;
  }
  return total === 0 ? 0 : ok / total;
}
