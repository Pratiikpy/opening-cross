// Reading a DLMM position and the bins under it (ADR-0915; row W10).
//
// A position holds liquidity shares in up to 70 consecutive bins. What those shares are worth is `bin.amount x share / bin.liquidity_supply`, in each token, per bin.
// The layouts are the program's `PositionV2` and `BinArray` accounts (`idls/lb_clmm.json`, bytemuck, no padding beyond the fields listed); the offsets below follow from
// the IDL and are checked against a position the real binary wrote in `tests/core/test/meteora-rebalance.test.ts`, where the computed amounts equal what a real
// withdrawal pays.
import { createHash } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import { type Address, address } from '@solana/kit';
import { binArrayAddress, binArrayIndex } from './dlmm.js';

const disc = (name: string) => [...createHash('sha256').update(`account:${name}`).digest().subarray(0, 8)];
const POSITION_DISC = disc('PositionV2');
const BIN_ARRAY_DISC = disc('BinArray');

const BINS_PER_ARRAY = 70;
const POSITION_SIZE = 8120;
const BIN_ARRAY_SIZE = 10136;
const BIN_SIZE = 144;
const POSITION_SHARES_AT = 72;
const POSITION_LOWER_AT = 7912;
const POSITION_UPPER_AT = 7916;
const POSITION_LOCK_AT = 7992;
const POSITION_FEE_OWNER_AT = 8001;
const BIN_ARRAY_INDEX_AT = 8;
const BIN_ARRAY_PAIR_AT = 24;
const BIN_ARRAY_BINS_AT = 56;

const matches = (data: Uint8Array, d: number[]) => d.every((b, i) => data[i] === b);
const key = (d: Uint8Array, at: number): Address => address(new PublicKey(d.subarray(at, at + 32)).toBase58());
const dv = (d: Uint8Array) => new DataView(d.buffer, d.byteOffset, d.byteLength);
const u128 = (v: DataView, at: number) => v.getBigUint64(at, true) | (v.getBigUint64(at + 8, true) << 64n);

export type DlmmPosition = {
  lbPair: Address;
  owner: Address;
  lowerBinId: number;
  upperBinId: number;
  /** Liquidity shares for bins `lowerBinId` to `upperBinId`, in order. */
  shares: bigint[];
  /** The time (in the pair's unit, seconds for a timestamp pair) before which DLMM refuses to withdraw from the position; zero when it was made without a lock. */
  lockReleasePoint: bigint;
  /** The address that may claim the position's fees (the owner, for a position made by `initialize_position_by_operator`'s `fee_owner`). */
  feeOwner: Address;
};

/** Decodes a `PositionV2` account; null when the bytes are not one. */
export function decodeDlmmPosition(data: Uint8Array): DlmmPosition | null {
  if (data.length < POSITION_SIZE || !matches(data, POSITION_DISC)) return null;
  const v = dv(data);
  const lowerBinId = v.getInt32(POSITION_LOWER_AT, true);
  const upperBinId = v.getInt32(POSITION_UPPER_AT, true);
  const width = upperBinId - lowerBinId + 1;
  if (width < 1 || width > BINS_PER_ARRAY) return null;
  const shares: bigint[] = [];
  for (let i = 0; i < width; i++) shares.push(u128(v, POSITION_SHARES_AT + i * 16));
  return { lbPair: key(data, 8), owner: key(data, 40), lowerBinId, upperBinId, shares, lockReleasePoint: v.getBigUint64(POSITION_LOCK_AT, true), feeOwner: key(data, POSITION_FEE_OWNER_AT) };
}

export type PositionBin = { amountX: bigint; amountY: bigint; liquiditySupply: bigint };
export type PositionBinArray = { index: number; lbPair: Address; bins: PositionBin[] };

/** Decodes a `BinArray` account; null when the bytes are not one. */
export function decodeDlmmBinArray(data: Uint8Array): PositionBinArray | null {
  if (data.length < BIN_ARRAY_SIZE || !matches(data, BIN_ARRAY_DISC)) return null;
  const v = dv(data);
  const bins: PositionBin[] = [];
  for (let i = 0; i < BINS_PER_ARRAY; i++) {
    const at = BIN_ARRAY_BINS_AT + i * BIN_SIZE;
    bins.push({ amountX: v.getBigUint64(at, true), amountY: v.getBigUint64(at + 8, true), liquiditySupply: u128(v, at + 32) });
  }
  return { index: Number(v.getBigInt64(BIN_ARRAY_INDEX_AT, true)), lbPair: key(data, BIN_ARRAY_PAIR_AT), bins };
}

/** The bin arrays a position's bins live in, lowest first. */
export function dlmmPositionArrayAddresses(lbPair: Address, position: Pick<DlmmPosition, 'lowerBinId' | 'upperBinId'>): Address[] {
  const out: Address[] = [];
  for (let i = binArrayIndex(position.lowerBinId); i <= binArrayIndex(position.upperBinId); i++) out.push(binArrayAddress(lbPair, i));
  return out;
}

export type DlmmPositionAmounts = {
  /** Token X (the base) and token Y (the quote) the position would receive if all its liquidity were withdrawn now, fees not included. */
  x: bigint;
  y: bigint;
  bins: { binId: number; x: bigint; y: bigint; shares: bigint }[];
};

/** What a position's liquidity is worth right now: floor of `amount x shares / supply` in every bin, which is how the program pays out. */
export function dlmmPositionAmounts(position: DlmmPosition, arrays: PositionBinArray[]): DlmmPositionAmounts {
  const byIndex = new Map(arrays.map((a) => [a.index, a]));
  const bins: DlmmPositionAmounts['bins'] = [];
  let x = 0n;
  let y = 0n;
  position.shares.forEach((shares, i) => {
    const binId = position.lowerBinId + i;
    if (shares === 0n) {
      bins.push({ binId, x: 0n, y: 0n, shares });
      return;
    }
    const array = byIndex.get(binArrayIndex(binId));
    if (!array) throw new Error(`bin array ${binArrayIndex(binId)} is missing, so bin ${binId} cannot be valued`);
    const bin = array.bins[((binId % BINS_PER_ARRAY) + BINS_PER_ARRAY) % BINS_PER_ARRAY]!;
    const bx = bin.liquiditySupply === 0n ? 0n : (bin.amountX * shares) / bin.liquiditySupply;
    const by = bin.liquiditySupply === 0n ? 0n : (bin.amountY * shares) / bin.liquiditySupply;
    x += bx;
    y += by;
    bins.push({ binId, x: bx, y: by, shares });
  });
  return { x, y, bins };
}
