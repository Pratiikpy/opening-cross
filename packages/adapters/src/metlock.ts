// Meteora Met Lock: standalone vesting escrows for any SPL or Token-2022 mint (ADR-0483, PRODUCT_FEATURES [X13/R2] Met Lock).
//
// An issuer that holds tokens it promised to vest (team tokens, the leftover a DBC pool returns, a greenshoe's bought-back
// supply) puts them in an escrow whose schedule is fixed by the chain: a cliff, then equal steps. The recipient claims what has
// vested; nobody, not even the issuer, can take back more than the cancel mode chosen at creation allows.
//
// Instruction layouts are taken from the program's published IDL (`idls/met_lock.json`, `@meteora-ag/met-lock-sdk` 1.0.1, MIT).
import { createHash } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import { AccountRole, type Address, type Instruction, type TransactionSigner, address } from '@solana/kit';
import { getCreateAssociatedTokenIdempotentInstruction } from '@solana-program/token';
import { ata } from '@opening-cross/sdk';

export const MET_LOCK_PROGRAM_ADDRESS = address('LocpQgucEQHbqNABEYvBvwoxCPsSbG91A1QaQhQQqjn');
const PROGRAM = new PublicKey(MET_LOCK_PROGRAM_ADDRESS);
const SYSTEM_PROGRAM = address('11111111111111111111111111111111');
const MEMO_PROGRAM = address('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
const U64_MAX = 0xffff_ffff_ffff_ffffn;

const disc = (name: string) => createHash('sha256').update(`global:${name}`).digest().subarray(0, 8);
const toKit = (k: PublicKey): Address => address(k.toBase58());

/** Who may change a schedule once it exists. The numeric values are the program's `cancel_mode` and `update_recipient_mode`. */
export const MetLockMode = { NoOne: 0, Creator: 1, Recipient: 2, Either: 3 } as const;

export function metLockAddresses(base: Address, mint: Address, tokenProgram: Address) {
  const escrow = PublicKey.findProgramAddressSync([Buffer.from('escrow'), new PublicKey(base).toBuffer()], PROGRAM)[0];
  return {
    escrow: toKit(escrow),
    eventAuthority: toKit(PublicKey.findProgramAddressSync([Buffer.from('__event_authority')], PROGRAM)[0]),
    /** The escrow's token account: the associated token account of the escrow PDA. */
    escrowTokenOwner: toKit(escrow),
    mint,
    tokenProgram,
  };
}

export type MetLockSchedule = {
  /** Unix seconds at which vesting starts counting. */
  vestingStartTime: bigint;
  /** Unix seconds of the cliff; at that instant `cliffUnlockAmount` unlocks. Not before `vestingStartTime`. */
  cliffTime: bigint;
  /** Seconds between steps after the cliff. */
  frequency: bigint;
  cliffUnlockAmount: bigint;
  amountPerPeriod: bigint;
  numberOfPeriod: bigint;
};

/**
 * Splits `total` atoms into a cliff unlock plus `periods` equal steps with nothing left over: the steps are
 * `floor((total - cliffUnlock) / periods)` and the remainder joins the cliff unlock, so
 * `cliffUnlockAmount + amountPerPeriod * numberOfPeriod === total` exactly. The program locks exactly that sum.
 */
export function metLockSchedule(input: { total: bigint; start: bigint; cliffSeconds: bigint; frequency: bigint; periods: bigint; cliffUnlockBps?: number }): MetLockSchedule {
  const { total, start, cliffSeconds, frequency, periods } = input;
  const bps = BigInt(input.cliffUnlockBps ?? 0);
  if (total <= 0n || total > U64_MAX) throw new Error('total must be a positive u64');
  if (periods < 0n || periods > 0xffff_ffffn) throw new Error('periods must fit a u32');
  if (cliffSeconds < 0n) throw new Error('the cliff cannot precede the start');
  if (bps < 0n || bps > 10_000n) throw new Error('cliffUnlockBps must be within 0 to 10,000');
  if (periods > 0n && frequency <= 0n) throw new Error('a schedule with steps needs a positive frequency');
  const requestedCliff = (total * bps) / 10_000n;
  if (periods === 0n) return { vestingStartTime: start, cliffTime: start + cliffSeconds, frequency: frequency > 0n ? frequency : 1n, cliffUnlockAmount: total, amountPerPeriod: 0n, numberOfPeriod: 0n };
  const remaining = total - requestedCliff;
  const per = remaining / periods;
  const cliffUnlockAmount = total - per * periods;
  return { vestingStartTime: start, cliffTime: start + cliffSeconds, frequency, cliffUnlockAmount, amountPerPeriod: per, numberOfPeriod: periods };
}

/** What a schedule has released by `now`, clamped to `[0, total]`; the arithmetic the program applies in `claim`. */
export function metLockVested(s: MetLockSchedule, now: bigint): bigint {
  if (now < s.cliffTime || now < s.vestingStartTime) return 0n;
  const periodsDone = s.frequency > 0n ? (now - s.cliffTime) / s.frequency : 0n;
  const capped = periodsDone > s.numberOfPeriod ? s.numberOfPeriod : periodsDone;
  return s.cliffUnlockAmount + s.amountPerPeriod * capped;
}

export type CreateVestingEscrowInput = {
  sender: TransactionSigner;
  /** A fresh signer that makes the escrow address unique; it signs once and is never used again. */
  base: TransactionSigner;
  mint: Address;
  tokenProgram: Address;
  recipient: Address;
  schedule: MetLockSchedule;
  cancelMode?: number;
  updateRecipientMode?: number;
};

/** Creates the escrow's token account and funds the escrow with the whole schedule from the sender, in the order the program needs. */
export async function buildCreateVestingEscrow(input: CreateVestingEscrowInput): Promise<{ instructions: Instruction[]; addresses: ReturnType<typeof metLockAddresses> }> {
  const a = metLockAddresses(input.base.address, input.mint, input.tokenProgram);
  const s = input.schedule;
  const escrowToken = await ata(a.escrow, input.mint, input.tokenProgram);
  const data = Buffer.alloc(8 + 6 * 8 + 2 + 1);
  let o = disc('create_vesting_escrow_v2').copy(data, 0);
  for (const v of [s.vestingStartTime, s.cliffTime, s.frequency, s.cliffUnlockAmount, s.amountPerPeriod, s.numberOfPeriod]) {
    data.writeBigUInt64LE(v, o);
    o += 8;
  }
  data.writeUInt8(input.updateRecipientMode ?? MetLockMode.NoOne, o++);
  data.writeUInt8(input.cancelMode ?? MetLockMode.NoOne, o++);
  data.writeUInt8(0, o++); // remaining_accounts_info: None
  const ensure = getCreateAssociatedTokenIdempotentInstruction({ payer: input.sender, ata: escrowToken, owner: a.escrow, mint: input.mint, tokenProgram: input.tokenProgram });
  const create: Instruction = {
    programAddress: MET_LOCK_PROGRAM_ADDRESS,
    accounts: [
      { address: input.base.address, role: AccountRole.WRITABLE_SIGNER, signer: input.base } as never,
      { address: a.escrow, role: AccountRole.WRITABLE },
      { address: input.mint, role: AccountRole.READONLY },
      { address: escrowToken, role: AccountRole.WRITABLE },
      { address: input.sender.address, role: AccountRole.WRITABLE_SIGNER, signer: input.sender } as never,
      { address: await ata(input.sender.address, input.mint, input.tokenProgram), role: AccountRole.WRITABLE },
      { address: input.recipient, role: AccountRole.READONLY },
      { address: input.tokenProgram, role: AccountRole.READONLY },
      { address: SYSTEM_PROGRAM, role: AccountRole.READONLY },
      { address: a.eventAuthority, role: AccountRole.READONLY },
      { address: MET_LOCK_PROGRAM_ADDRESS, role: AccountRole.READONLY },
    ],
    data: new Uint8Array(data),
  };
  return { instructions: [ensure as Instruction, create], addresses: a };
}

/** The recipient claims up to `maxAmount` of what has vested (the program clamps it to the vested balance). */
export async function buildClaimVested(input: { recipient: TransactionSigner; escrow: Address; mint: Address; tokenProgram: Address; maxAmount?: bigint }): Promise<Instruction[]> {
  const eventAuthority = toKit(PublicKey.findProgramAddressSync([Buffer.from('__event_authority')], PROGRAM)[0]);
  const recipientToken = await ata(input.recipient.address, input.mint, input.tokenProgram);
  const ensure = getCreateAssociatedTokenIdempotentInstruction({ payer: input.recipient, ata: recipientToken, owner: input.recipient.address, mint: input.mint, tokenProgram: input.tokenProgram });
  const data = Buffer.alloc(8 + 8 + 1);
  let o = disc('claim_v2').copy(data, 0);
  data.writeBigUInt64LE(input.maxAmount ?? U64_MAX, o);
  o += 8;
  data.writeUInt8(0, o); // remaining_accounts_info: None
  const claim: Instruction = {
    programAddress: MET_LOCK_PROGRAM_ADDRESS,
    accounts: [
      { address: input.escrow, role: AccountRole.WRITABLE },
      { address: input.mint, role: AccountRole.READONLY },
      { address: await ata(input.escrow, input.mint, input.tokenProgram), role: AccountRole.WRITABLE },
      { address: input.recipient.address, role: AccountRole.WRITABLE_SIGNER, signer: input.recipient } as never,
      { address: recipientToken, role: AccountRole.WRITABLE },
      { address: MEMO_PROGRAM, role: AccountRole.READONLY },
      { address: input.tokenProgram, role: AccountRole.READONLY },
      { address: eventAuthority, role: AccountRole.READONLY },
      { address: MET_LOCK_PROGRAM_ADDRESS, role: AccountRole.READONLY },
    ],
    data: new Uint8Array(data),
  };
  return [ensure as Instruction, claim];
}
