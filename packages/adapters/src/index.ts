// Meteora DBC continuation for Opening Cross (ADR-0006).
//
// After a deferred-mint launch clears at P*, the issuer opens a DBC curve whose start price is
// exactly P*. This package computes that start price the same way the adapter program checks it,
// builds the DBC config from the issuer's curve design, and builds the two settlement
// instructions with every account derived.
import BN from 'bn.js';
import {
  type Address,
  type Instruction,
  type TransactionSigner,
  address,
  getAddressEncoder,
  getProgramDerivedAddress,
} from '@solana/kit';
import { PublicKey } from '@solana/web3.js';
import {
  type BuildCurveWithCustomSqrtPricesParams,
  type ConfigParameters,
  type DynamicFeeParameters,
  TokenAuthorityOption,
  TokenType,
  buildCurveWithCustomSqrtPrices,
  deriveDbcPoolAddress,
  deriveDbcPoolAuthority,
  deriveDbcTokenVaultAddress,
  validateDynamicFee,
} from '@meteora-ag/dynamic-bonding-curve-sdk';
import {
  CROSS_SETTLE_PROGRAM_ADDRESS,
  getBindDbcMintInstruction,
  getOpenDbcPoolInstruction,
} from '@opening-cross/cross-settle-client';
import { CROSS_GATE_PROGRAM_ADDRESS } from '@opening-cross/cross-gate-client';
import type { CrossView } from '@opening-cross/sdk';

export const DBC_PROGRAM_ADDRESS = address('dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN');
export const TOKEN_2022 = address('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');

const enc = getAddressEncoder();
const text = (s: string) => new TextEncoder().encode(s);
const toKit = (k: PublicKey): Address => address(k.toBase58());
const toWeb3 = (a: Address) => new PublicKey(a);

// ------------------------------------------------------------------ price

/** Integer square root (floor) of a non-negative bigint. */
export function isqrt(n: bigint): bigint {
  if (n < 0n) throw new Error('isqrt of a negative number');
  if (n < 2n) return n;
  let x = 1n << BigInt(Math.ceil(n.toString(2).length / 2));
  for (;;) {
    const y = (x + n / x) >> 1n;
    if (y >= x) return x;
    x = y;
  }
}

/** DBC's Q64.64 sqrt price for P* in quote atoms per `priceScale` base atoms; identical to the
 *  adapter program's `sqrt_price_q64`. */
export function sqrtPriceQ64(price: bigint, priceScale: bigint): bigint {
  if (priceScale <= 0n) throw new Error('priceScale must be positive');
  return isqrt((price << 128n) / priceScale);
}

// ------------------------------------------------------------------ curve design

/** The issuer's curve design, fixed before the cross: everything except the start price. */
export type ContinuationDesign = Omit<BuildCurveWithCustomSqrtPricesParams, 'sqrtPrices' | 'token'> & {
  token: Omit<BuildCurveWithCustomSqrtPricesParams['token'], 'tokenType' | 'tokenAuthorityOption'>;
  /** Sqrt-price multiples of the start price for each later curve point, e.g. [2, 4, 10] for a
   *  curve that reaches 4×, 16× and 100× the clearing price. Strictly increasing, all > 1. */
  sqrtPriceMultiples: number[];
  /**
   * Explicit dynamic-fee parameters, normally from `volatilityFeeParams`. Replaces the SDK helper's fixed
   * "up to 20% of the base fee" convention; requires `fee.dynamicFeeEnabled`.
   */
  dynamicFee?: DynamicFeeParameters;
};

/** DBC config parameters for a curve that starts exactly at P*. */
export function buildContinuationConfig(clearingPrice: bigint, priceScale: bigint, design: ContinuationDesign): ConfigParameters {
  const start = sqrtPriceQ64(clearingPrice, priceScale);
  let prev = 1;
  for (const m of design.sqrtPriceMultiples) {
    if (!(m > prev)) throw new Error('sqrtPriceMultiples must be strictly increasing and greater than 1');
    prev = m;
  }
  // Multiples are applied in fixed point (1e9) so the result is deterministic.
  const sqrtPrices = [start, ...design.sqrtPriceMultiples.map((m) => (start * BigInt(Math.round(m * 1e9))) / 1_000_000_000n)].map((v) => new BN(v.toString()));
  const { sqrtPriceMultiples, token, dynamicFee, ...rest } = design;
  void sqrtPriceMultiples;
  if (dynamicFee && !design.fee.dynamicFeeEnabled) throw new Error('dynamicFee is set but fee.dynamicFeeEnabled is false');
  const config = buildCurveWithCustomSqrtPrices({
    ...rest,
    token: { ...token, tokenType: TokenType.Token2022, tokenAuthorityOption: TokenAuthorityOption.PartnerUpdateAndMintAuthority },
    sqrtPrices,
  });
  if (BigInt(config.sqrtStartPrice.toString()) !== start) throw new Error('DBC SDK changed the start price; refusing to continue');
  if (dynamicFee) {
    if (!validateDynamicFee(dynamicFee)) throw new Error('dynamicFee does not pass the DBC validation rules');
    config.poolFees.dynamicFee = dynamicFee;
  }
  return config;
}

/** Recursively converts the DBC SDK's BN fields to bigint for the kit client. */
function toKitArgs(v: unknown): unknown {
  if (BN.isBN(v)) return BigInt((v as BN).toString());
  if (v instanceof PublicKey) return toKit(v);
  if (Array.isArray(v)) return v.map(toKitArgs);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, toKitArgs(x)]));
  return v;
}

// ------------------------------------------------------------------ addresses

export async function settlerAddress(cross: Address): Promise<Address> {
  return (await getProgramDerivedAddress({ programAddress: CROSS_SETTLE_PROGRAM_ADDRESS, seeds: [text('settler'), enc.encode(cross)] }))[0];
}
export async function dbcConfigAddress(cross: Address): Promise<Address> {
  return (await getProgramDerivedAddress({ programAddress: CROSS_SETTLE_PROGRAM_ADDRESS, seeds: [text('dbc_config'), enc.encode(cross)] }))[0];
}
export async function continuationMintAddress(cross: Address): Promise<Address> {
  return (await getProgramDerivedAddress({ programAddress: CROSS_SETTLE_PROGRAM_ADDRESS, seeds: [text('base_mint'), enc.encode(cross)] }))[0];
}
export async function dbcEventAuthority(): Promise<Address> {
  return (await getProgramDerivedAddress({ programAddress: DBC_PROGRAM_ADDRESS, seeds: [text('__event_authority')] }))[0];
}
export async function gateConfigAddress(mint: Address): Promise<Address> {
  return (await getProgramDerivedAddress({ programAddress: CROSS_GATE_PROGRAM_ADDRESS, seeds: [text('config'), enc.encode(mint)] }))[0];
}
export async function gateHookMetasAddress(mint: Address): Promise<Address> {
  return (await getProgramDerivedAddress({ programAddress: CROSS_GATE_PROGRAM_ADDRESS, seeds: [text('extra-account-metas'), enc.encode(mint)] }))[0];
}

export async function continuationAddresses(cross: Address, quoteMint: Address) {
  const config = await dbcConfigAddress(cross);
  const baseMint = await continuationMintAddress(cross);
  const pool = toKit(deriveDbcPoolAddress(toWeb3(quoteMint), toWeb3(baseMint), toWeb3(config)));
  return {
    settler: await settlerAddress(cross),
    config,
    baseMint,
    pool,
    baseVault: toKit(deriveDbcTokenVaultAddress(toWeb3(pool), toWeb3(baseMint))),
    quoteVault: toKit(deriveDbcTokenVaultAddress(toWeb3(pool), toWeb3(quoteMint))),
    poolAuthority: toKit(deriveDbcPoolAuthority()),
  };
}

// ------------------------------------------------------------------ instructions

export type OpenPoolInput = {
  cross: CrossView;
  creator: TransactionSigner;
  design: ContinuationDesign;
  name: string;
  symbol: string;
  uri: string;
};

/** Settlement step 1 (creator only): DBC config and pool at P*. */
export async function buildOpenDbcPool(input: OpenPoolInput): Promise<{ instruction: Instruction; config: ConfigParameters; addresses: Awaited<ReturnType<typeof continuationAddresses>> }> {
  const c = input.cross.data;
  if (c.clearing.__option !== 'Some') throw new Error('cross has not cleared');
  const config = buildContinuationConfig(c.clearing.value.price, c.priceScale, input.design);
  const a = await continuationAddresses(input.cross.address, c.quoteMint);
  const instruction = getOpenDbcPoolInstruction({
    creator: input.creator,
    cross: input.cross.address,
    settler: a.settler,
    dbcConfig: a.config,
    baseMint: a.baseMint,
    quoteMint: c.quoteMint,
    leftoverReceiver: c.proceedsTo,
    pool: a.pool,
    baseVault: a.baseVault,
    quoteVault: a.quoteVault,
    dbcPoolAuthority: a.poolAuthority,
    dbcEventAuthority: await dbcEventAuthority(),
    quoteTokenProgram: c.quoteTokenProgram,
    ...(toKitArgs(config) as object),
    name: input.name,
    symbol: input.symbol,
    uri: input.uri,
  } as Parameters<typeof getOpenDbcPoolInstruction>[0]);
  return { instruction, config, addresses: a };
}

/** Settlement step 2 (permissionless): hook config, mint authority to the cross, bind. */
export async function buildBindDbcMint(cross: CrossView, payer: TransactionSigner): Promise<Instruction> {
  const baseMint = await continuationMintAddress(cross.address);
  return getBindDbcMintInstruction({
    payer,
    cross: cross.address,
    settler: await settlerAddress(cross.address),
    baseMint,
    gateConfig: await gateConfigAddress(baseMint),
    gateExtraMetas: await gateHookMetasAddress(baseMint),
    token2022Program: TOKEN_2022,
  });
}
export * from './damm.js';
export * from './fees.js';
export * from './dlmm.js';
export * from './raydium.js';
