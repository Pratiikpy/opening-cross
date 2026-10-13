// DLMM adapter: open a Meteora DLMM pair whose active bin is the bin nearest P*.
// Token X = base, token Y = quote, so a bin's price (Y per X) is in the cross's units.
import BN from 'bn.js';
import { createHash } from 'node:crypto';
import { AccountRole, type Address, type Instruction, type TransactionSigner, address } from '@solana/kit';
import { PublicKey } from '@solana/web3.js';
import { getOpenDlmmPairInstruction } from '@opening-cross/cross-settle-client';
import { i64le, rewrapInstruction } from './rewrap.js';
import { type CrossView, ata } from '@opening-cross/sdk';

export const DLMM_PROGRAM_ADDRESS = address('LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo');
const PROGRAM = new PublicKey(DLMM_PROGRAM_ADDRESS);
const toKit = (k: PublicKey): Address => address(k.toBase58());

// PDA derivations copied from @meteora-ag/dlmm (ts-client/src/dlmm/helpers/derive.ts); the
// package itself is not imported because its ESM build fails to load under Node.
const ILM_BASE = new PublicKey('MFGQxwAmB91SwuYX36okv2Qmdc9aMuHTwWGUrp4AtB1');
function sortMints(x: PublicKey, y: PublicKey): [PublicKey, PublicKey] {
  return x.toBuffer().compare(y.toBuffer()) === 1 ? [y, x] : [x, y];
}
const pda = (seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, PROGRAM)[0];

/** `(1 + binStep/10⁴)^id` in Q64.64 — identical to `cross_settle::bin_price_q64`. */
export function binPriceQ64(id: number, binStep: number): bigint {
  const one = 1n << 64n;
  const base = one + (BigInt(binStep) << 64n) / 10_000n;
  let result = one;
  let b = base;
  let e = BigInt(Math.abs(id));
  while (e > 0n) {
    if (e & 1n) result = (result * b) >> 64n;
    e >>= 1n;
    if (e > 0n) b = (b * b) >> 64n;
  }
  return id < 0 ? (one << 64n) / result : result;
}

/** Mirrors `cross_settle::bin_contains`. */
export function binContains(id: number, binStep: number, price: bigint, priceScale: bigint): boolean {
  const bin = binPriceQ64(id, binStep);
  const p = (price << 64n) / priceScale;
  return p >= (bin * BigInt(20_000 - binStep)) / 20_000n && p <= (bin * BigInt(20_000 + binStep)) / 20_000n;
}

/** The bin id the adapter will accept for P*. */
export function activeIdForPrice(price: bigint, priceScale: bigint, binStep: number): number {
  const approx = Math.round(Math.log(Number(price) / Number(priceScale)) / Math.log(1 + binStep / 10_000));
  for (const id of [approx, approx - 1, approx + 1]) if (binContains(id, binStep, price, priceScale)) return id;
  throw new Error('no DLMM bin within half a step of the clearing price');
}

export function dlmmAddresses(baseMint: Address, quoteMint: Address) {
  const [min, max] = sortMints(new PublicKey(baseMint), new PublicKey(quoteMint));
  const lbPair = pda([ILM_BASE.toBuffer(), min.toBuffer(), max.toBuffer()]);
  return {
    lbPair: toKit(lbPair),
    reserveX: toKit(pda([lbPair.toBuffer(), new PublicKey(baseMint).toBuffer()])),
    reserveY: toKit(pda([lbPair.toBuffer(), new PublicKey(quoteMint).toBuffer()])),
    oracle: toKit(pda([Buffer.from('oracle'), lbPair.toBuffer()])),
    eventAuthority: toKit(pda([Buffer.from('__event_authority')])),
  };
}

export type OpenDlmmInput = {
  cross: CrossView;
  creator: TransactionSigner;
  binStep: number;
  /** DLMM base factor: base fee = baseFactor · binStep · 10 · 10^baseFeePowerFactor (in 1e9 units). */
  baseFactor: number;
  baseFeePowerFactor?: number;
  /**
   * Open the pair closed for a batch window (ADR-0483): it cannot trade before `activationPoint` (unix seconds, at least `windowSecs`
   * after the clock when the transaction lands). With `alphaVault`, only an Alpha Vault bound to the pair can buy before then, and
   * the pair creator keeps the right to pause it.
   */
  batch?: { windowSecs: number; activationPoint: bigint; alphaVault?: boolean };
  /**
   * Meteora Token Badges for mints that carry Token-2022 extensions DLMM refuses without one (tokenized stocks: pausable, permanent
   * delegate, scaled amount; ADR-0485). Pass `true` for a mint that has a badge; the badge address is derived. Only Meteora issues badges.
   */
  badges?: { base?: boolean; quote?: boolean };
};

/** The `TokenBadge` PDA DLMM looks for a mint (seeds `token_badge`, mint). */
export function dlmmTokenBadgeAddress(mint: Address): Address {
  return toKit(pda([Buffer.from('token_badge'), new PublicKey(mint).toBuffer()]));
}

export async function buildOpenDlmmPair(input: OpenDlmmInput): Promise<{ instruction: Instruction; activeId: number; addresses: ReturnType<typeof dlmmAddresses> }> {
  const c = input.cross.data;
  if (c.clearing.__option !== 'Some') throw new Error('cross has not cleared');
  if (!c.baseBound) throw new Error('cross has no base mint yet');
  const activeId = activeIdForPrice(c.clearing.value.price, c.priceScale, input.binStep);
  const a = dlmmAddresses(c.baseMint, c.quoteMint);
  void BN;
  const original = getOpenDlmmPairInstruction({
    creator: input.creator,
    cross: input.cross.address,
    lbPair: a.lbPair,
    baseMint: c.baseMint,
    quoteMint: c.quoteMint,
    reserveX: a.reserveX,
    reserveY: a.reserveY,
    oracle: a.oracle,
    creatorBase: await ata(input.creator.address, c.baseMint, c.baseTokenProgram),
    creatorQuote: await ata(input.creator.address, c.quoteMint, c.quoteTokenProgram),
    dlmmEventAuthority: a.eventAuthority,
    baseTokenProgram: c.baseTokenProgram,
    quoteTokenProgram: c.quoteTokenProgram,
    activeId,
    binStep: input.binStep,
    baseFactor: input.baseFactor,
    activationType: 1,
    hasAlphaVault: input.batch?.alphaVault ?? false,
    activationPoint: input.batch ? input.batch.activationPoint : null,
    creatorPoolOnOffControl: input.batch ? true : false,
    baseFeePowerFactor: input.baseFeePowerFactor ?? 0,
    concreteFunctionType: 0,
    collectFeeMode: 0,
    padding: new Uint8Array(60),
  
  } as Parameters<typeof getOpenDlmmPairInstruction>[0]);
  const window = i64le(input.batch?.windowSecs ?? 0);
  const instruction = input.badges ? rewrapInstruction(original, 'open_dlmm_pair_badged', window) : input.batch ? rewrapInstruction(original, 'open_dlmm_pair_batched', window) : original;
  if (input.badges) {
    // The badge instruction reads two remaining accounts, base then quote: the mint's badge, or the DLMM program for none.
    const slot = (has: boolean | undefined, mint: Address): Address => (has ? dlmmTokenBadgeAddress(mint) : DLMM_PROGRAM_ADDRESS);
    return {
      instruction: { ...instruction, accounts: [...(instruction.accounts ?? []), { address: slot(input.badges.base, c.baseMint), role: AccountRole.READONLY }, { address: slot(input.badges.quote, c.quoteMint), role: AccountRole.READONLY }] } as Instruction,
      activeId,
      addresses: a,
    };
  }
  return { instruction, activeId, addresses: a };
}

// ---------------------------------------------------------------------------------------------------------------------
// Conviction ladder: the issuer commits unsold base tokens as one-sided liquidity in the bins just above the clearing
// price. Buyers who want more than the auction filled walk up the ladder at DLMM's own bin prices; nothing is sold
// below P*, and the issuer cannot pull it back without Meteora's own position instructions.
// ---------------------------------------------------------------------------------------------------------------------
const BIN_ARRAY_SIZE = 70;
const SYSTEM_PROGRAM = address('11111111111111111111111111111111');
const RENT_SYSVAR = address('SysvarRent111111111111111111111111111111111');

const disc = (name: string) => createHash('sha256').update(`global:${name}`).digest().subarray(0, 8);
/** Index of the DLMM bin array that holds `binId` (floor division, so negative ids work). */
export const binArrayIndex = (binId: number): number => Math.floor(binId / BIN_ARRAY_SIZE);
export function binArrayAddress(lbPair: Address, index: number): Address {
  const seed = Buffer.alloc(8);
  seed.writeBigInt64LE(BigInt(index));
  return toKit(pda([Buffer.from('bin_array'), new PublicKey(lbPair).toBuffer(), seed]));
}

/** How the base tokens are spread over the ladder: evenly, concentrated near P*, or concentrated at the top. */
export type LadderShape = 'flat' | 'taper' | 'wall';
/** DLMM `StrategyType` imbalanced variants (Meteora's IDL enum order): the deposit is single-sided, so only the base side is filled. */
const STRATEGY: Record<LadderShape, number> = { flat: 6, taper: 7, wall: 8 };
export const ladderStrategy = (shape: LadderShape): number => STRATEGY[shape];

export type ConvictionLadderInput = {
  cross: CrossView;
  creator: TransactionSigner;
  /** A fresh keypair signer for the new position account. */
  position: TransactionSigner;
  activeId: number;
  /** Number of bins above the active bin that receive base tokens (1 to 70). */
  bins: number;
  baseAmount: bigint;
  shape?: LadderShape;
  /** Bin arrays that already exist (so they are not initialised twice). */
  existingBinArrays?: number[];
  /** Also put part of the ladder on the active bin itself, at P*. */
  includeActive?: boolean;
};

/** Instructions that open a position on the bins above the active bin and fill it with base tokens only. */
export async function buildDlmmConvictionLadder(input: ConvictionLadderInput): Promise<{ instructions: Instruction[]; lowerBinId: number; upperBinId: number }> {
  const c = input.cross.data;
  const a = dlmmAddresses(c.baseMint, c.quoteMint);
  const lower = input.includeActive ? input.activeId : input.activeId + 1;
  const upper = lower + input.bins - 1;
  if (!Number.isInteger(input.bins) || input.bins < 1 || input.bins > BIN_ARRAY_SIZE) throw new Error(`a ladder spans 1 to ${BIN_ARRAY_SIZE} bins`);
  const first = binArrayIndex(input.activeId);
  const last = binArrayIndex(upper);
  const have = new Set(input.existingBinArrays ?? []);
  const instructions: Instruction[] = [];
  const arrays: Address[] = [];
  for (let i = first; i <= last; i++) {
    const addr = binArrayAddress(a.lbPair, i);
    arrays.push(addr);
    if (have.has(i)) continue;
    const d = Buffer.alloc(16);
    disc('initialize_bin_array').copy(d, 0);
    d.writeBigInt64LE(BigInt(i), 8);
    instructions.push({
      programAddress: DLMM_PROGRAM_ADDRESS,
      accounts: [
        { address: a.lbPair, role: AccountRole.READONLY },
        { address: addr, role: AccountRole.WRITABLE },
        { address: input.creator.address, role: AccountRole.WRITABLE_SIGNER, signer: input.creator } as never,
        { address: SYSTEM_PROGRAM, role: AccountRole.READONLY },
      ],
      data: new Uint8Array(d),
    });
  }
  const pos = Buffer.alloc(16);
  disc('initialize_position').copy(pos, 0);
  pos.writeInt32LE(lower, 8);
  pos.writeInt32LE(input.bins, 12);
  instructions.push({
    programAddress: DLMM_PROGRAM_ADDRESS,
    accounts: [
      { address: input.creator.address, role: AccountRole.WRITABLE_SIGNER, signer: input.creator } as never,
      { address: input.position.address, role: AccountRole.WRITABLE_SIGNER, signer: input.position } as never,
      { address: a.lbPair, role: AccountRole.READONLY },
      { address: input.creator.address, role: AccountRole.READONLY_SIGNER, signer: input.creator } as never,
      { address: SYSTEM_PROGRAM, role: AccountRole.READONLY },
      { address: RENT_SYSVAR, role: AccountRole.READONLY },
      { address: a.eventAuthority, role: AccountRole.READONLY },
      { address: DLMM_PROGRAM_ADDRESS, role: AccountRole.READONLY },
    ],
    data: new Uint8Array(pos),
  });
  // add_liquidity_by_strategy2: base only, over [lower, upper], with Meteora's imbalanced strategy for the chosen shape.
  const add = Buffer.alloc(8 + 8 + 8 + 4 + 4 + 4 + 4 + 1 + 64 + 4);
  let o = disc('add_liquidity_by_strategy2').copy(add, 0);
  add.writeBigUInt64LE(input.baseAmount, o); o += 8;
  add.writeBigUInt64LE(0n, o); o += 8;
  add.writeInt32LE(input.activeId, o); o += 4;
  add.writeInt32LE(0, o); o += 4; // max_active_bin_slippage: the pair was just opened at this bin
  add.writeInt32LE(lower, o); o += 4;
  add.writeInt32LE(upper, o); o += 4;
  add.writeUInt8(STRATEGY[input.shape ?? 'flat'], o); o += 1;
  o += 64; // strategy parameters: unused by these strategies
  add.writeUInt32LE(0, o); // no extra account slices
  instructions.push({
    programAddress: DLMM_PROGRAM_ADDRESS,
    accounts: [
      { address: input.position.address, role: AccountRole.WRITABLE },
      { address: a.lbPair, role: AccountRole.WRITABLE },
      { address: DLMM_PROGRAM_ADDRESS, role: AccountRole.READONLY }, // no bitmap extension
      { address: await ata(input.creator.address, c.baseMint, c.baseTokenProgram), role: AccountRole.WRITABLE },
      { address: await ata(input.creator.address, c.quoteMint, c.quoteTokenProgram), role: AccountRole.WRITABLE },
      { address: a.reserveX, role: AccountRole.WRITABLE },
      { address: a.reserveY, role: AccountRole.WRITABLE },
      { address: c.baseMint, role: AccountRole.READONLY },
      { address: c.quoteMint, role: AccountRole.READONLY },
      { address: input.creator.address, role: AccountRole.READONLY_SIGNER, signer: input.creator } as never,
      { address: c.baseTokenProgram, role: AccountRole.READONLY },
      { address: c.quoteTokenProgram, role: AccountRole.READONLY },
      { address: a.eventAuthority, role: AccountRole.READONLY },
      { address: DLMM_PROGRAM_ADDRESS, role: AccountRole.READONLY },
      ...arrays.map((addr) => ({ address: addr, role: AccountRole.WRITABLE })),
    ],
    data: new Uint8Array(add),
  });
  return { instructions, lowerBinId: lower, upperBinId: upper };
}
