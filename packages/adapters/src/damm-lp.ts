// Joining a DAMM v2 pool as a liquidity provider (ADR-0911): the two Meteora instructions an outside holder needs to earn a pool's reward stream and fees.
//
// The pool the adapter opens holds one position, the issuer's. Anyone else who wants a share of its trading fees and of its reward slots creates a position of
// their own (`create_position`: a fresh position NFT) and adds liquidity to it (`add_liquidity`). Meteora's own interface does the same; these builders let
// the app and the tests do it without it.
import { PublicKey } from '@solana/web3.js';
import { createHash } from 'node:crypto';
import { derivePositionAddress, derivePositionNftAccount } from '@meteora-ag/cp-amm-sdk';
import { AccountRole, type Address, type Instruction, type TransactionSigner, address } from '@solana/kit';
import { ata } from '@opening-cross/sdk';
import { DAMM_V2_PROGRAM_ADDRESS } from './damm.js';
import { DAMM_POOL_AUTHORITY } from './rewards.js';

const PROGRAM = new PublicKey(DAMM_V2_PROGRAM_ADDRESS);
const SYSTEM_PROGRAM = address('11111111111111111111111111111111');
const TOKEN_2022 = address('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
const toKit = (k: PublicKey): Address => address(k.toBase58());
const disc = (name: string) => createHash('sha256').update(`global:${name}`).digest().subarray(0, 8);
const eventAuthority = () => toKit(PublicKey.findProgramAddressSync([Buffer.from('__event_authority')], PROGRAM)[0]);

/** The position and the position NFT's token account that follow from a fresh NFT mint. */
export function dammPositionAddresses(positionNftMint: Address): { position: Address; positionNftAccount: Address } {
  const mint = new PublicKey(positionNftMint);
  return { position: toKit(derivePositionAddress(mint)), positionNftAccount: toKit(derivePositionNftAccount(mint)) };
}

/** Creates an empty position owned by `owner`. `positionNftMint` is a fresh keypair that signs once; the NFT is minted to the owner. */
export function buildCreateDammPosition(input: { pool: Address; owner: Address; payer: TransactionSigner; positionNftMint: TransactionSigner }): { instruction: Instruction; position: Address; positionNftAccount: Address } {
  const a = dammPositionAddresses(input.positionNftMint.address);
  return {
    ...a,
    instruction: {
      programAddress: DAMM_V2_PROGRAM_ADDRESS,
      accounts: [
        { address: input.owner, role: AccountRole.READONLY },
        { address: input.positionNftMint.address, role: AccountRole.WRITABLE_SIGNER, signer: input.positionNftMint } as never,
        { address: a.positionNftAccount, role: AccountRole.WRITABLE },
        { address: input.pool, role: AccountRole.WRITABLE },
        { address: a.position, role: AccountRole.WRITABLE },
        { address: DAMM_POOL_AUTHORITY, role: AccountRole.READONLY },
        { address: input.payer.address, role: AccountRole.WRITABLE_SIGNER, signer: input.payer } as never,
        { address: TOKEN_2022, role: AccountRole.READONLY },
        { address: SYSTEM_PROGRAM, role: AccountRole.READONLY },
        { address: eventAuthority(), role: AccountRole.READONLY },
        { address: DAMM_V2_PROGRAM_ADDRESS, role: AccountRole.READONLY },
      ],
      data: new Uint8Array(disc('create_position')),
    },
  };
}

export type AddDammLiquidityInput = {
  pool: Address;
  position: Address;
  positionNftAccount: Address;
  owner: TransactionSigner;
  tokenAMint: Address;
  tokenBMint: Address;
  tokenAVault: Address;
  tokenBVault: Address;
  tokenAProgram: Address;
  tokenBProgram: Address;
  /** Liquidity to add (Meteora's `liquidity_delta`, a u128). */
  liquidityDelta: bigint;
  /** The most of each token the owner will pay; the program refuses a deposit that would need more. */
  maxTokenA: bigint;
  maxTokenB: bigint;
};

/** `add_liquidity`: deposits both tokens, in the pool's current ratio, for `liquidityDelta` of liquidity. */
export async function buildAddDammLiquidity(input: AddDammLiquidityInput): Promise<Instruction> {
  if (input.liquidityDelta <= 0n || input.liquidityDelta >= 1n << 128n) throw new Error('liquidityDelta must be a positive u128');
  const data = Buffer.alloc(8 + 16 + 8 + 8);
  let o = disc('add_liquidity').copy(data, 0);
  data.writeBigUInt64LE(input.liquidityDelta & 0xffff_ffff_ffff_ffffn, o);
  data.writeBigUInt64LE(input.liquidityDelta >> 64n, o + 8);
  o += 16;
  data.writeBigUInt64LE(input.maxTokenA, o);
  data.writeBigUInt64LE(input.maxTokenB, o + 8);
  return {
    programAddress: DAMM_V2_PROGRAM_ADDRESS,
    accounts: [
      { address: input.pool, role: AccountRole.WRITABLE },
      { address: input.position, role: AccountRole.WRITABLE },
      { address: await ata(input.owner.address, input.tokenAMint, input.tokenAProgram), role: AccountRole.WRITABLE },
      { address: await ata(input.owner.address, input.tokenBMint, input.tokenBProgram), role: AccountRole.WRITABLE },
      { address: input.tokenAVault, role: AccountRole.WRITABLE },
      { address: input.tokenBVault, role: AccountRole.WRITABLE },
      { address: input.tokenAMint, role: AccountRole.READONLY },
      { address: input.tokenBMint, role: AccountRole.READONLY },
      { address: input.positionNftAccount, role: AccountRole.READONLY },
      { address: input.owner.address, role: AccountRole.READONLY_SIGNER, signer: input.owner } as never,
      { address: input.tokenAProgram, role: AccountRole.READONLY },
      { address: input.tokenBProgram, role: AccountRole.READONLY },
      { address: eventAuthority(), role: AccountRole.READONLY },
      { address: DAMM_V2_PROGRAM_ADDRESS, role: AccountRole.READONLY },
    ],
    data: new Uint8Array(data),
  };
}
