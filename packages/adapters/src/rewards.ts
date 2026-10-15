// DAMM v2 reward slots (ADR-0911; rows D1, X17): an incentive paid to a pool's liquidity providers, through Meteora's own instructions.
//
// Every DAMM v2 pool has two reward slots. A slot streams one token, at a constant rate over a duration of one day to one year, to whoever holds liquidity
// in the pool, in proportion to their liquidity. The pool's creator may initialise slot 0 (slot 1 needs a Meteora operator); the slot's funder (named when
// it is initialised, and changeable by the same authority) tops it up; every position claims its own accrued share. The layouts are from the program's
// published IDL (`idls/cp_amm.json`) and its source (`research/repos/damm-v2`, Apache-2.0).
import { createHash } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import { AccountRole, type Address, type Instruction, type TransactionSigner, address } from '@solana/kit';
import { getCreateAssociatedTokenIdempotentInstruction } from '@solana-program/token';
import { ata } from '@opening-cross/sdk';
import { DAMM_V2_PROGRAM_ADDRESS } from './damm.js';

const PROGRAM = new PublicKey(DAMM_V2_PROGRAM_ADDRESS);
const SYSTEM_PROGRAM = address('11111111111111111111111111111111');
const toKit = (k: PublicKey): Address => address(k.toBase58());
const disc = (name: string) => createHash('sha256').update(`global:${name}`).digest().subarray(0, 8);

/** Reward slots per pool (`NUM_REWARDS`). The pool creator may initialise slot 0 only. */
export const DAMM_REWARD_SLOTS = 2;
/** The shortest and longest duration a reward can stream over, in seconds (`MIN_REWARD_DURATION`, `MAX_REWARD_DURATION`). */
export const DAMM_REWARD_MIN_DURATION = 24 * 60 * 60;
export const DAMM_REWARD_MAX_DURATION = 31_536_000;

/** The pool authority PDA that owns every reward vault (a constant of the program). */
export const DAMM_POOL_AUTHORITY = address('HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC');

function checkIndex(index: number): void {
  if (!Number.isInteger(index) || index < 0 || index >= DAMM_REWARD_SLOTS) throw new Error(`a reward slot is 0 or 1; ${index} was given`);
}

/** The token account that holds a slot's reward (`["reward_vault", pool, index]`). */
export function dammRewardVaultAddress(pool: Address, index: number): Address {
  checkIndex(index);
  return toKit(PublicKey.findProgramAddressSync([Buffer.from('reward_vault'), new PublicKey(pool).toBuffer(), Buffer.from([index])], PROGRAM)[0]);
}

const eventAuthority = () => toKit(PublicKey.findProgramAddressSync([Buffer.from('__event_authority')], PROGRAM)[0]);
const u64 = (v: bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(v);
  return b;
};

export type InitializeRewardInput = {
  pool: Address;
  /** The pool's creator (slot 0) or a whitelisted Meteora operator. */
  signer: TransactionSigner;
  payer: TransactionSigner;
  rewardMint: Address;
  tokenProgram: Address;
  index: number;
  /** Seconds the funded amount streams over, from one day to one year. */
  durationSecs: bigint;
  /** The only account that may fund this slot. */
  funder: Address;
};

/** Opens a reward slot: creates its vault and records the mint, the funder and the duration. */
export function buildInitializeDammReward(input: InitializeRewardInput): Instruction {
  checkIndex(input.index);
  if (input.durationSecs < BigInt(DAMM_REWARD_MIN_DURATION) || input.durationSecs > BigInt(DAMM_REWARD_MAX_DURATION)) {
    throw new Error(`a reward streams over ${DAMM_REWARD_MIN_DURATION} to ${DAMM_REWARD_MAX_DURATION} seconds; ${input.durationSecs} was given`);
  }
  const data = Buffer.concat([disc('initialize_reward'), Buffer.from([input.index]), u64(input.durationSecs), new PublicKey(input.funder).toBuffer()]);
  return {
    programAddress: DAMM_V2_PROGRAM_ADDRESS,
    accounts: [
      { address: DAMM_POOL_AUTHORITY, role: AccountRole.READONLY },
      { address: input.pool, role: AccountRole.WRITABLE },
      { address: dammRewardVaultAddress(input.pool, input.index), role: AccountRole.WRITABLE },
      { address: input.rewardMint, role: AccountRole.READONLY },
      { address: input.signer.address, role: AccountRole.READONLY_SIGNER, signer: input.signer } as never,
      { address: input.payer.address, role: AccountRole.WRITABLE_SIGNER, signer: input.payer } as never,
      { address: input.tokenProgram, role: AccountRole.READONLY },
      { address: SYSTEM_PROGRAM, role: AccountRole.READONLY },
      { address: eventAuthority(), role: AccountRole.READONLY },
      { address: DAMM_V2_PROGRAM_ADDRESS, role: AccountRole.READONLY },
    ],
    data: new Uint8Array(data),
  };
}

/**
 * Adds `amount` of the reward token to a slot. The funder is the account named at initialisation. With `carryForward`, what has not yet streamed is added
 * to the new amount and the stream restarts over the slot's duration; without it, the program refuses while a stream is running.
 */
export async function buildFundDammReward(input: { pool: Address; funder: TransactionSigner; rewardMint: Address; tokenProgram: Address; index: number; amount: bigint; carryForward?: boolean }): Promise<Instruction> {
  checkIndex(input.index);
  if (input.amount <= 0n) throw new Error('fund a positive amount');
  const data = Buffer.concat([disc('fund_reward'), Buffer.from([input.index]), u64(input.amount), Buffer.from([input.carryForward ? 1 : 0])]);
  return {
    programAddress: DAMM_V2_PROGRAM_ADDRESS,
    accounts: [
      { address: input.pool, role: AccountRole.WRITABLE },
      { address: dammRewardVaultAddress(input.pool, input.index), role: AccountRole.WRITABLE },
      { address: input.rewardMint, role: AccountRole.READONLY },
      { address: await ata(input.funder.address, input.rewardMint, input.tokenProgram), role: AccountRole.WRITABLE },
      { address: input.funder.address, role: AccountRole.READONLY_SIGNER, signer: input.funder } as never,
      { address: input.tokenProgram, role: AccountRole.READONLY },
      { address: eventAuthority(), role: AccountRole.READONLY },
      { address: DAMM_V2_PROGRAM_ADDRESS, role: AccountRole.READONLY },
    ],
    data: new Uint8Array(data),
  };
}

/** A position's owner (or its delegate) claims what the slot has streamed to the position, into the owner's token account. Creates that account when it is missing. */
export async function buildClaimDammReward(input: { pool: Address; position: Address; positionNftAccount: Address; owner: TransactionSigner; rewardMint: Address; tokenProgram: Address; index: number }): Promise<Instruction[]> {
  checkIndex(input.index);
  const destination = await ata(input.owner.address, input.rewardMint, input.tokenProgram);
  const ensure = getCreateAssociatedTokenIdempotentInstruction({ payer: input.owner, ata: destination, owner: input.owner.address, mint: input.rewardMint, tokenProgram: input.tokenProgram }) as Instruction;
  return [
    ensure,
    {
      programAddress: DAMM_V2_PROGRAM_ADDRESS,
      accounts: [
        { address: DAMM_POOL_AUTHORITY, role: AccountRole.READONLY },
        { address: input.pool, role: AccountRole.WRITABLE },
        { address: input.position, role: AccountRole.WRITABLE },
        { address: dammRewardVaultAddress(input.pool, input.index), role: AccountRole.WRITABLE },
        { address: input.rewardMint, role: AccountRole.READONLY },
        { address: destination, role: AccountRole.WRITABLE },
        { address: input.positionNftAccount, role: AccountRole.READONLY },
        { address: input.owner.address, role: AccountRole.READONLY_SIGNER, signer: input.owner } as never,
        { address: input.tokenProgram, role: AccountRole.READONLY },
        { address: eventAuthority(), role: AccountRole.READONLY },
        { address: DAMM_V2_PROGRAM_ADDRESS, role: AccountRole.READONLY },
      ],
      data: new Uint8Array(Buffer.concat([disc('claim_reward'), Buffer.from([input.index, 0])])),
    },
  ];
}

/** Names a new funder for a slot. The signer is the pool's creator (slot 0) or a Meteora operator. */
export function buildUpdateDammRewardFunder(input: { pool: Address; signer: TransactionSigner; index: number; newFunder: Address }): Instruction {
  checkIndex(input.index);
  return {
    programAddress: DAMM_V2_PROGRAM_ADDRESS,
    accounts: [
      { address: input.pool, role: AccountRole.WRITABLE },
      { address: input.signer.address, role: AccountRole.READONLY_SIGNER, signer: input.signer } as never,
      { address: eventAuthority(), role: AccountRole.READONLY },
      { address: DAMM_V2_PROGRAM_ADDRESS, role: AccountRole.READONLY },
    ],
    data: new Uint8Array(Buffer.concat([disc('update_reward_funder'), Buffer.from([input.index]), new PublicKey(input.newFunder).toBuffer()])),
  };
}

/** Changes the duration of a slot whose stream has ended. The signer is the pool's creator (slot 0) or a Meteora operator. */
export function buildUpdateDammRewardDuration(input: { pool: Address; signer: TransactionSigner; index: number; newDurationSecs: bigint }): Instruction {
  checkIndex(input.index);
  if (input.newDurationSecs < BigInt(DAMM_REWARD_MIN_DURATION) || input.newDurationSecs > BigInt(DAMM_REWARD_MAX_DURATION)) {
    throw new Error(`a reward streams over ${DAMM_REWARD_MIN_DURATION} to ${DAMM_REWARD_MAX_DURATION} seconds; ${input.newDurationSecs} was given`);
  }
  return {
    programAddress: DAMM_V2_PROGRAM_ADDRESS,
    accounts: [
      { address: input.pool, role: AccountRole.WRITABLE },
      { address: input.signer.address, role: AccountRole.READONLY_SIGNER, signer: input.signer } as never,
      { address: eventAuthority(), role: AccountRole.READONLY },
      { address: DAMM_V2_PROGRAM_ADDRESS, role: AccountRole.READONLY },
    ],
    data: new Uint8Array(Buffer.concat([disc('update_reward_duration'), Buffer.from([input.index]), u64(input.newDurationSecs)])),
  };
}

/** The funder takes back reward that streamed while the pool had no liquidity to receive it. */
export async function buildWithdrawIneligibleDammReward(input: { pool: Address; funder: TransactionSigner; rewardMint: Address; tokenProgram: Address; index: number }): Promise<Instruction> {
  checkIndex(input.index);
  return {
    programAddress: DAMM_V2_PROGRAM_ADDRESS,
    accounts: [
      { address: DAMM_POOL_AUTHORITY, role: AccountRole.READONLY },
      { address: input.pool, role: AccountRole.WRITABLE },
      { address: dammRewardVaultAddress(input.pool, input.index), role: AccountRole.WRITABLE },
      { address: input.rewardMint, role: AccountRole.READONLY },
      { address: await ata(input.funder.address, input.rewardMint, input.tokenProgram), role: AccountRole.WRITABLE },
      { address: input.funder.address, role: AccountRole.READONLY_SIGNER, signer: input.funder } as never,
      { address: input.tokenProgram, role: AccountRole.READONLY },
      { address: eventAuthority(), role: AccountRole.READONLY },
      { address: DAMM_V2_PROGRAM_ADDRESS, role: AccountRole.READONLY },
    ],
    data: new Uint8Array(Buffer.concat([disc('withdraw_ineligible_reward'), Buffer.from([input.index])])),
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Reading a pool's reward slots (offsets after the 8-byte discriminator, from `idls/cp_amm.json`, checked against Anchor's own decoder in
// `tests/core/test/meteora-rewards.test.ts`).
// ---------------------------------------------------------------------------------------------------------------------
const POOL_SIZE = 1112;
const POOL_DISCRIMINATOR = [...createHash('sha256').update('account:Pool').digest().subarray(0, 8)];
const POOL_CREATOR_AT = 648;
const POOL_LIQUIDITY_AT = 360;
const POOL_REWARDS_AT = 728;
const REWARD_SIZE = 192;

export type DammRewardSlot = {
  index: number;
  initialized: boolean;
  mint: Address;
  vault: Address;
  funder: Address;
  durationSecs: bigint;
  /** Unix seconds at which the current stream ends (zero before the first funding). */
  endsAt: bigint;
  /** Reward atoms per second, in Q64.64 fixed point (the program's `reward_rate`). */
  rate: bigint;
  lastUpdate: bigint;
};

export type DammPoolRewards = { creator: Address; liquidity: bigint; slots: DammRewardSlot[] };

/** Decodes a DAMM v2 pool's creator, total liquidity and reward slots; null when the bytes are not a pool. */
export function decodeDammPoolRewards(data: Uint8Array): DammPoolRewards | null {
  if (data.length < POOL_SIZE || !POOL_DISCRIMINATOR.every((b, i) => data[i] === b)) return null;
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const key = (at: number): Address => address(new PublicKey(data.subarray(at, at + 32)).toBase58());
  const u128 = (at: number) => v.getBigUint64(at, true) | (v.getBigUint64(at + 8, true) << 64n);
  const slots: DammRewardSlot[] = [];
  for (let i = 0; i < DAMM_REWARD_SLOTS; i++) {
    const at = POOL_REWARDS_AT + i * REWARD_SIZE;
    slots.push({ index: i, initialized: data[at] === 1, mint: key(at + 16), vault: key(at + 48), funder: key(at + 80), durationSecs: v.getBigUint64(at + 112, true), endsAt: v.getBigUint64(at + 120, true), rate: u128(at + 128), lastUpdate: v.getBigUint64(at + 176, true) });
  }
  return { creator: key(POOL_CREATOR_AT), liquidity: u128(POOL_LIQUIDITY_AT), slots };
}
