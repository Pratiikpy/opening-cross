// Raydium CPMM adapter: open a Raydium constant-product pool whose opening price — the ratio
// of the two initial deposits — is P* to within one quote atom.
import { type Address, type Instruction, type TransactionSigner, address, getAddressEncoder, getProgramDerivedAddress } from '@solana/kit';
import { getSeedRaydiumCpmmInstruction } from '@opening-cross/cross-settle-client';
import { type CrossView, ata } from '@opening-cross/sdk';

export const RAYDIUM_CPMM_PROGRAM_ADDRESS = address('CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C');
/** Raydium's mainnet pool-creation fee receiver (`create_pool_fee_reveiver`, non-devnet build). */
export const RAYDIUM_CREATE_POOL_FEE = address('DNXgeM9EiiaAbaWvwjHj9fQQLAX5ZsfHyvmYUNRAdNC8');
import { TOKEN_PROGRAM_ADDRESS as SPL_TOKEN } from '@solana-program/token';

const enc = getAddressEncoder();
const text = (s: string) => new TextEncoder().encode(s);
const pda = async (seeds: Uint8Array[]) => (await getProgramDerivedAddress({ programAddress: RAYDIUM_CPMM_PROGRAM_ADDRESS, seeds }))[0];

/** Raydium's AMM config PDA for a fee tier index (`["amm_config", index as u16 BE]`). */
export async function raydiumAmmConfig(index: number): Promise<Address> {
  return pda([text('amm_config'), new Uint8Array([(index >> 8) & 0xff, index & 0xff])]);
}

/** PDAs from raydium-cp-swap `instructions/initialize.rs` and `states/pool.rs`. */
export async function raydiumAddresses(ammConfig: Address, baseMint: Address, quoteMint: Address) {
  const baseFirst = Buffer.compare(Buffer.from(enc.encode(baseMint)), Buffer.from(enc.encode(quoteMint))) < 0;
  const [token0, token1] = baseFirst ? [baseMint, quoteMint] : [quoteMint, baseMint];
  const pool = await pda([text('pool'), enc.encode(ammConfig) as Uint8Array, enc.encode(token0) as Uint8Array, enc.encode(token1) as Uint8Array]);
  return {
    baseIsToken0: baseFirst,
    token0,
    token1,
    pool,
    authority: await pda([text('vault_and_lp_mint_auth_seed')]),
    lpMint: await pda([text('pool_lp_mint'), enc.encode(pool) as Uint8Array]),
    vault0: await pda([text('pool_vault'), enc.encode(pool) as Uint8Array, enc.encode(token0) as Uint8Array]),
    vault1: await pda([text('pool_vault'), enc.encode(pool) as Uint8Array, enc.encode(token1) as Uint8Array]),
    observation: await pda([text('observation'), enc.encode(pool) as Uint8Array]),
  };
}

/** Quote atoms that price `baseAmount` at P* (rounded down; the program also accepts +1). */
export function quoteForBase(baseAmount: bigint, price: bigint, priceScale: bigint): bigint {
  return (baseAmount * price) / priceScale;
}

export type SeedRaydiumInput = {
  cross: CrossView;
  creator: TransactionSigner;
  baseAmount: bigint;
  /** Fee tier (AMM config index); 0 is Raydium's standard 0.25% tier. */
  ammConfigIndex?: number;
  /** Unix time trading opens; Raydium moves anything not in the future to now + 1. */
  openTime?: bigint;
};

export async function buildSeedRaydiumCpmm(input: SeedRaydiumInput): Promise<{ instruction: Instruction; quoteAmount: bigint; addresses: Awaited<ReturnType<typeof raydiumAddresses>> }> {
  const c = input.cross.data;
  if (c.clearing.__option !== 'Some') throw new Error('cross has not cleared');
  if (!c.baseBound) throw new Error('cross has no base mint yet');
  const ammConfig = await raydiumAmmConfig(input.ammConfigIndex ?? 0);
  const a = await raydiumAddresses(ammConfig, c.baseMint, c.quoteMint);
  const quoteAmount = quoteForBase(input.baseAmount, c.clearing.value.price, c.priceScale);
  const [program0, program1] = a.baseIsToken0 ? [c.baseTokenProgram, c.quoteTokenProgram] : [c.quoteTokenProgram, c.baseTokenProgram];
  const instruction = getSeedRaydiumCpmmInstruction({
    creator: input.creator,
    cross: input.cross.address,
    ammConfig,
    raydiumAuthority: a.authority,
    poolState: a.pool,
    token0Mint: a.token0,
    token1Mint: a.token1,
    lpMint: a.lpMint,
    creatorToken0: await ata(input.creator.address, a.token0, program0),
    creatorToken1: await ata(input.creator.address, a.token1, program1),
    creatorLpToken: await ata(input.creator.address, a.lpMint, SPL_TOKEN),
    token0Vault: a.vault0,
    token1Vault: a.vault1,
    createPoolFee: RAYDIUM_CREATE_POOL_FEE,
    observationState: a.observation,
    token0Program: program0,
    token1Program: program1,
    baseAmount: input.baseAmount,
    quoteAmount,
    openTime: input.openTime ?? 0n,
  });
  return { instruction, quoteAmount, addresses: a };
}
