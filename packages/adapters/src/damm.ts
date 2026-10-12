// DAMM v2 adapter: seed a Meteora DAMM v2 pool for a cross's market at exactly P*.
// Token A = base, token B = quote, so DAMM's price (B per A) is the cross's price.
import BN from 'bn.js';
import { AccountRole, type Address, type Instruction, type TransactionSigner, address, getProgramDerivedAddress } from '@solana/kit';
import { createHash } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import {
  BaseFeeMode,
  MAX_SQRT_PRICE,
  MIN_SQRT_PRICE,
  deriveCustomizablePoolAddress,
  derivePoolAuthority,
  derivePositionAddress,
  derivePositionNftAccount,
  deriveTokenVaultAddress,
  getBaseFeeParams,
  getLiquidityDeltaFromAmountA,
  getLiquidityDeltaFromAmountB,
} from '@meteora-ag/cp-amm-sdk';
import { CROSS_SETTLE_PROGRAM_ADDRESS, getSeedDammV2Instruction } from '@opening-cross/cross-settle-client';
import { type CrossView, ata } from '@opening-cross/sdk';
import { TOKEN_2022, sqrtPriceQ64 } from './index.js';

export const DAMM_V2_PROGRAM_ADDRESS = address('cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG');
/** DAMM v2 collect-fee modes (cp-amm `CollectFeeMode`). */
export const DammCollectFeeMode = { BothToken: 0, OnlyB: 1, Compounding: 2 } as const;

const toKit = (k: PublicKey): Address => address(k.toBase58());
const w3 = (a: Address) => new PublicKey(a);

export async function dammPositionMintAddress(cross: Address): Promise<Address> {
  return (await getProgramDerivedAddress({ programAddress: CROSS_SETTLE_PROGRAM_ADDRESS, seeds: [new TextEncoder().encode('damm_position'), new PublicKey(cross).toBytes()] }))[0];
}

export async function dammAddresses(cross: Address, baseMint: Address, quoteMint: Address) {
  const nft = await dammPositionMintAddress(cross);
  const pool = deriveCustomizablePoolAddress(w3(baseMint), w3(quoteMint));
  return {
    positionNftMint: nft,
    positionNftAccount: toKit(derivePositionNftAccount(w3(nft))),
    position: toKit(derivePositionAddress(w3(nft))),
    pool: toKit(pool),
    tokenAVault: toKit(deriveTokenVaultAddress(w3(baseMint), pool)),
    tokenBVault: toKit(deriveTokenVaultAddress(w3(quoteMint), pool)),
    poolAuthority: toKit(derivePoolAuthority()),
    eventAuthority: (await getProgramDerivedAddress({ programAddress: DAMM_V2_PROGRAM_ADDRESS, seeds: [new TextEncoder().encode('__event_authority')] }))[0],
  };
}

export type SeedDammInput = {
  cross: CrossView;
  creator: TransactionSigner;
  /** Maximum base and quote atoms to deposit; liquidity is the largest both can cover. */
  baseAmount: bigint;
  quoteAmount: bigint;
  /** Flat trading fee for the pool, in bps. */
  feeBps: number;
  collectFeeMode?: number;
  /** Share of each trading fee that compounds back into the pool, in bps; only meaningful with `DammCollectFeeMode.Compounding`. */
  compoundingFeeBps?: number;
};

/** Full-range DAMM v2 pool at P* (constant-product behaviour). */
export async function buildSeedDammV2(input: SeedDammInput): Promise<{ instruction: Instruction; liquidity: bigint; sqrtPrice: bigint; addresses: Awaited<ReturnType<typeof dammAddresses>> }> {
  const c = input.cross.data;
  if (c.clearing.__option !== 'Some') throw new Error('cross has not cleared');
  if (!c.baseBound) throw new Error('cross has no base mint yet');
  const sqrtPrice = sqrtPriceQ64(c.clearing.value.price, c.priceScale);
  const mode = input.collectFeeMode ?? DammCollectFeeMode.OnlyB;
  const sp = new BN(sqrtPrice.toString());
  const la = getLiquidityDeltaFromAmountA(new BN(input.baseAmount.toString()), sp, MAX_SQRT_PRICE, mode);
  const lb = getLiquidityDeltaFromAmountB(new BN(input.quoteAmount.toString()), MIN_SQRT_PRICE, sp, mode);
  const liquidity = BigInt((la.lt(lb) ? la : lb).toString());
  if (liquidity === 0n) throw new Error('amounts too small for any liquidity');
  const baseFee = getBaseFeeParams({ baseFeeMode: BaseFeeMode.FeeTimeSchedulerLinear, feeTimeSchedulerParam: { startingFeeBps: input.feeBps, endingFeeBps: input.feeBps, numberOfPeriod: 0, totalDuration: 0 } });
  const a = await dammAddresses(input.cross.address, c.baseMint, c.quoteMint);
  const instruction = getSeedDammV2Instruction({
    creator: input.creator,
    cross: input.cross.address,
    positionNftMint: a.positionNftMint,
    positionNftAccount: a.positionNftAccount,
    pool: a.pool,
    position: a.position,
    baseMint: c.baseMint,
    quoteMint: c.quoteMint,
    tokenAVault: a.tokenAVault,
    tokenBVault: a.tokenBVault,
    creatorBase: await ata(input.creator.address, c.baseMint, c.baseTokenProgram),
    creatorQuote: await ata(input.creator.address, c.quoteMint, c.quoteTokenProgram),
    dammPoolAuthority: a.poolAuthority,
    dammEventAuthority: a.eventAuthority,
    baseTokenProgram: c.baseTokenProgram,
    quoteTokenProgram: c.quoteTokenProgram,
    token2022Program: TOKEN_2022,
    poolFees: { baseFee: { data: Uint8Array.from(baseFee.data as number[]) }, compoundingFeeBps: mode === DammCollectFeeMode.Compounding ? (input.compoundingFeeBps ?? 0) : 0, padding: 0, dynamicFee: null },
    sqrtMinPrice: BigInt(MIN_SQRT_PRICE.toString()),
    sqrtMaxPrice: BigInt(MAX_SQRT_PRICE.toString()),
    hasAlphaVault: false,
    liquidity,
    sqrtPrice,
    activationType: 1,
    collectFeeMode: mode,
    activationPoint: null,
  });
  return { instruction, liquidity, sqrtPrice, addresses: a };
}

/**
 * Meteora's own `permanent_lock_position`: moves `liquidity` of the cross's DAMM v2 position into a permanent lock, so the
 * pool's opening depth can never be withdrawn (the lock cannot be undone). The creator owns the position NFT and signs;
 * send it in the same transaction as `buildSeedDammV2` to lock liquidity from the pool's first block.
 */
export async function buildLockDammPosition(input: { cross: CrossView; creator: TransactionSigner; liquidity: bigint }): Promise<Instruction> {
  const c = input.cross.data;
  const a = await dammAddresses(input.cross.address, c.baseMint, c.quoteMint);
  const data = Buffer.alloc(24);
  createHash('sha256').update('global:permanent_lock_position').digest().copy(data, 0, 0, 8);
  data.writeBigUInt64LE(input.liquidity & 0xffff_ffff_ffff_ffffn, 8);
  data.writeBigUInt64LE(input.liquidity >> 64n, 16);
  return {
    programAddress: DAMM_V2_PROGRAM_ADDRESS,
    accounts: [
      { address: a.pool, role: AccountRole.WRITABLE },
      { address: a.position, role: AccountRole.WRITABLE },
      { address: a.positionNftAccount, role: AccountRole.READONLY },
      { address: input.creator.address, role: AccountRole.READONLY_SIGNER, signer: input.creator } as never,
      { address: a.eventAuthority, role: AccountRole.READONLY },
      { address: DAMM_V2_PROGRAM_ADDRESS, role: AccountRole.READONLY },
    ],
    data: new Uint8Array(data),
  };
}

export type VestingSchedule = {
  /** Unix time (the pool's activation type is timestamp) at which the first tranche unlocks. */
  cliffPoint: bigint;
  /** Seconds between the later tranches. */
  periodFrequency: bigint;
  /** Liquidity that unlocks at the cliff. */
  cliffUnlockLiquidity: bigint;
  /** Liquidity that unlocks each period after the cliff. */
  liquidityPerPeriod: bigint;
  numberOfPeriod: number;
};

/** Total liquidity a schedule locks. */
export const vestingTotal = (v: VestingSchedule): bigint => v.cliffUnlockLiquidity + v.liquidityPerPeriod * BigInt(v.numberOfPeriod);

/**
 * Meteora's own `lock_position`: puts `schedule`'s liquidity of the cross's DAMM v2 position under a vesting schedule, so the
 * issuer's opening depth unlocks in tranches instead of being withdrawable at once. The creator owns the position NFT and signs.
 */
export async function buildVestDammPosition(input: { cross: CrossView; creator: TransactionSigner; vesting: TransactionSigner; schedule: VestingSchedule }): Promise<Instruction> {
  const c = input.cross.data;
  const v = input.schedule;
  if (v.numberOfPeriod < 0 || v.numberOfPeriod > 0xffff) throw new Error('numberOfPeriod must fit in 16 bits');
  if (vestingTotal(v) <= 0n) throw new Error('the schedule locks nothing');
  const a = await dammAddresses(input.cross.address, c.baseMint, c.quoteMint);
  const data = Buffer.alloc(8 + 1 + 8 + 8 + 16 + 16 + 2);
  let o = createHash('sha256').update('global:lock_position').digest().copy(data, 0, 0, 8);
  data.writeUInt8(1, o); o += 1; // cliff_point: Some
  data.writeBigUInt64LE(v.cliffPoint, o); o += 8;
  data.writeBigUInt64LE(v.periodFrequency, o); o += 8;
  data.writeBigUInt64LE(v.cliffUnlockLiquidity & 0xffff_ffff_ffff_ffffn, o); data.writeBigUInt64LE(v.cliffUnlockLiquidity >> 64n, o + 8); o += 16;
  data.writeBigUInt64LE(v.liquidityPerPeriod & 0xffff_ffff_ffff_ffffn, o); data.writeBigUInt64LE(v.liquidityPerPeriod >> 64n, o + 8); o += 16;
  data.writeUInt16LE(v.numberOfPeriod, o);
  return {
    programAddress: DAMM_V2_PROGRAM_ADDRESS,
    accounts: [
      { address: a.pool, role: AccountRole.READONLY },
      { address: a.position, role: AccountRole.WRITABLE },
      { address: input.vesting.address, role: AccountRole.WRITABLE_SIGNER, signer: input.vesting } as never,
      { address: a.positionNftAccount, role: AccountRole.READONLY },
      { address: input.creator.address, role: AccountRole.READONLY_SIGNER, signer: input.creator } as never,
      { address: input.creator.address, role: AccountRole.WRITABLE_SIGNER, signer: input.creator } as never,
      { address: address('11111111111111111111111111111111'), role: AccountRole.READONLY },
      { address: a.eventAuthority, role: AccountRole.READONLY },
      { address: DAMM_V2_PROGRAM_ADDRESS, role: AccountRole.READONLY },
    ],
    data: new Uint8Array(data),
  };
}
