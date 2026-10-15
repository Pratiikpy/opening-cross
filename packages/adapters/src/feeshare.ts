// Fee sharing: a Meteora Dynamic Fee Sharing vault that splits one token's fees among up to five fixed recipients by share.
// A cross's issuer opens it for the quote token its pools earn, so fees reach stakeholders without a trusted middleman:
// anyone can fund the vault, and each recipient claims its own share.
import { createHash } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import { AccountRole, type Address, type Instruction, type TransactionSigner, address } from '@solana/kit';
import { ata } from '@opening-cross/sdk';

export const DYNAMIC_FEE_SHARING_PROGRAM_ADDRESS = address('dfsdo2UqvwfN8DuUVrMRNfQe11VaiNoKcMqLHVvDPzh');
const PROGRAM = new PublicKey(DYNAMIC_FEE_SHARING_PROGRAM_ADDRESS);
const SYSTEM_PROGRAM = address('11111111111111111111111111111111');
export const MAX_FEE_SHARE_RECIPIENTS = 5;
/** The program refuses a vault with fewer than two recipients (it answers `ExceededUser`; checked against the real binary). */
export const MIN_FEE_SHARE_RECIPIENTS = 2;

const disc = (name: string) => createHash('sha256').update(`global:${name}`).digest().subarray(0, 8);
const pda = (seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, PROGRAM)[0];
const toKit = (k: PublicKey): Address => address(k.toBase58());

export type FeeShareRecipient = { address: Address; /** Relative weight; the vault splits fees in proportion to it. */ share: number };

export function feeShareAddresses(base: Address, mint: Address) {
  const feeVault = pda([Buffer.from('fee_vault'), new PublicKey(base).toBuffer(), new PublicKey(mint).toBuffer()]);
  return {
    feeVault: toKit(feeVault),
    feeVaultAuthority: toKit(pda([Buffer.from('fee_vault_authority')])),
    tokenVault: toKit(pda([Buffer.from('token_vault'), feeVault.toBuffer()])),
    eventAuthority: toKit(pda([Buffer.from('__event_authority')])),
  };
}

export type CreateFeeShareVaultInput = {
  payer: TransactionSigner;
  /** A fresh keypair signer that makes the vault address unique. */
  base: TransactionSigner;
  /** The vault owner, recorded on the vault. */
  owner: Address;
  mint: Address;
  tokenProgram: Address;
  recipients: FeeShareRecipient[];
};

export function buildCreateFeeShareVault(input: CreateFeeShareVaultInput): { instruction: Instruction; addresses: ReturnType<typeof feeShareAddresses> } {
  const r = input.recipients;
  if (r.length < MIN_FEE_SHARE_RECIPIENTS || r.length > MAX_FEE_SHARE_RECIPIENTS) throw new Error(`a fee-sharing vault has ${MIN_FEE_SHARE_RECIPIENTS} to ${MAX_FEE_SHARE_RECIPIENTS} recipients`);
  if (new Set(r.map((x) => x.address)).size !== r.length) throw new Error('a recipient is listed twice');
  for (const x of r) if (!Number.isInteger(x.share) || x.share <= 0 || x.share > 0xffff_ffff) throw new Error('every share must be a positive integer');
  const a = feeShareAddresses(input.base.address, input.mint);
  const data = Buffer.alloc(8 + 64 + 4 + r.length * 36);
  let o = disc('initialize_fee_vault_pda').copy(data, 0);
  o += 64; // reserved padding, all zero
  data.writeUInt32LE(r.length, o); o += 4;
  for (const x of r) {
    new PublicKey(x.address).toBuffer().copy(data, o); o += 32;
    data.writeUInt32LE(x.share, o); o += 4;
  }
  return {
    addresses: a,
    instruction: {
      programAddress: DYNAMIC_FEE_SHARING_PROGRAM_ADDRESS,
      accounts: [
        { address: a.feeVault, role: AccountRole.WRITABLE },
        { address: a.feeVaultAuthority, role: AccountRole.READONLY },
        { address: a.tokenVault, role: AccountRole.WRITABLE },
        { address: input.mint, role: AccountRole.READONLY },
        { address: input.owner, role: AccountRole.READONLY },
        { address: input.base.address, role: AccountRole.READONLY_SIGNER, signer: input.base } as never,
        { address: input.payer.address, role: AccountRole.WRITABLE_SIGNER, signer: input.payer } as never,
        { address: input.tokenProgram, role: AccountRole.READONLY },
        { address: SYSTEM_PROGRAM, role: AccountRole.READONLY },
        { address: a.eventAuthority, role: AccountRole.READONLY },
        { address: DYNAMIC_FEE_SHARING_PROGRAM_ADDRESS, role: AccountRole.READONLY },
      ],
      data: new Uint8Array(data.subarray(0, o)),
    },
  };
}

/** Anyone holding the token can add fees to the vault; `maxAmount` atoms leave the funder's token account. */
export async function buildFundFeeShareVault(input: { funder: TransactionSigner; base: Address; mint: Address; tokenProgram: Address; maxAmount: bigint }): Promise<Instruction> {
  const a = feeShareAddresses(input.base, input.mint);
  const data = Buffer.alloc(16);
  disc('fund_fee').copy(data, 0);
  data.writeBigUInt64LE(input.maxAmount, 8);
  return {
    programAddress: DYNAMIC_FEE_SHARING_PROGRAM_ADDRESS,
    accounts: [
      { address: a.feeVault, role: AccountRole.WRITABLE },
      { address: a.tokenVault, role: AccountRole.WRITABLE },
      { address: input.mint, role: AccountRole.READONLY },
      { address: await ata(input.funder.address, input.mint, input.tokenProgram), role: AccountRole.WRITABLE },
      { address: input.funder.address, role: AccountRole.READONLY_SIGNER, signer: input.funder } as never,
      { address: input.tokenProgram, role: AccountRole.READONLY },
      { address: a.eventAuthority, role: AccountRole.READONLY },
      { address: DYNAMIC_FEE_SHARING_PROGRAM_ADDRESS, role: AccountRole.READONLY },
    ],
    data: new Uint8Array(data),
  };
}

/** A recipient claims everything it is owed; `index` is its position in the recipient list the vault was created with. */
export async function buildClaimFeeShare(input: { user: TransactionSigner; base: Address; mint: Address; tokenProgram: Address; index: number }): Promise<Instruction> {
  const a = feeShareAddresses(input.base, input.mint);
  const data = Buffer.alloc(9);
  disc('claim_fee').copy(data, 0);
  data.writeUInt8(input.index, 8);
  return {
    programAddress: DYNAMIC_FEE_SHARING_PROGRAM_ADDRESS,
    accounts: [
      { address: a.feeVault, role: AccountRole.WRITABLE },
      { address: a.feeVaultAuthority, role: AccountRole.READONLY },
      { address: a.tokenVault, role: AccountRole.WRITABLE },
      { address: input.mint, role: AccountRole.READONLY },
      { address: await ata(input.user.address, input.mint, input.tokenProgram), role: AccountRole.WRITABLE },
      { address: input.user.address, role: AccountRole.READONLY_SIGNER, signer: input.user } as never,
      { address: input.tokenProgram, role: AccountRole.READONLY },
      { address: a.eventAuthority, role: AccountRole.READONLY },
      { address: DYNAMIC_FEE_SHARING_PROGRAM_ADDRESS, role: AccountRole.READONLY },
    ],
    data: new Uint8Array(data),
  };
}

const TOKEN_2022_PROGRAM = address('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
const CP_AMM_PROGRAM = address('cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG');

/**
 * Hands a DAMM v2 position to the fee vault: the position NFT's token account changes owner from the issuer to the vault,
 * so from then on the position's fees can only be claimed into the vault (the issuer's liquidity lock, if any, is unaffected).
 * One-way: the issuer cannot take the position back.
 */
export function buildTransferDammPositionToFeeVault(input: { owner: TransactionSigner; positionNftAccount: Address; feeVault: Address }): Instruction {
  const data = Buffer.alloc(2 + 1 + 32);
  data.writeUInt8(6, 0); // Token-2022 SetAuthority
  data.writeUInt8(2, 1); // AccountOwner
  data.writeUInt8(1, 2); // new authority: Some
  new PublicKey(input.feeVault).toBuffer().copy(data, 3);
  return {
    programAddress: TOKEN_2022_PROGRAM,
    accounts: [
      { address: input.positionNftAccount, role: AccountRole.WRITABLE },
      { address: input.owner.address, role: AccountRole.READONLY_SIGNER, signer: input.owner } as never,
    ],
    data: new Uint8Array(data),
  };
}

/**
 * Pulls the DAMM v2 position's accrued fees straight into the vault (Meteora's `fund_by_claiming_fee` with cp-amm's
 * `claim_position_fee`). The vault's token must be the pool's token B (the quote), the position NFT must already belong to the
 * vault, and `signer` must be one of the vault's recipients. Token A fees, if the pool collects any, go to `tokenAAccount`.
 */
export function buildFundFeeShareFromDammFees(input: {
  signer: TransactionSigner;
  feeVault: Address;
  pool: Address;
  position: Address;
  positionNftAccount: Address;
  tokenAAccount: Address;
  tokenAVault: Address;
  tokenBVault: Address;
  tokenAMint: Address;
  tokenBMint: Address;
  tokenAProgram: Address;
  tokenBProgram: Address;
  poolAuthority: Address;
  dammEventAuthority: Address;
}): Instruction {
  const a = { tokenVault: toKit(pda([Buffer.from('token_vault'), new PublicKey(input.feeVault).toBuffer()])), eventAuthority: toKit(pda([Buffer.from('__event_authority')])) };
  const claimDisc = createHash('sha256').update('global:claim_position_fee').digest().subarray(0, 8);
  const data = Buffer.alloc(8 + 4 + 8);
  let o = disc('fund_by_claiming_fee').copy(data, 0);
  data.writeUInt32LE(claimDisc.length, o); o += 4;
  claimDisc.copy(data, o);
  const W = AccountRole.WRITABLE;
  const R = AccountRole.READONLY;
  return {
    programAddress: DYNAMIC_FEE_SHARING_PROGRAM_ADDRESS,
    accounts: [
      { address: input.feeVault, role: W },
      { address: a.tokenVault, role: W },
      { address: input.signer.address, role: AccountRole.READONLY_SIGNER, signer: input.signer } as never,
      { address: CP_AMM_PROGRAM, role: R },
      { address: a.eventAuthority, role: R },
      { address: DYNAMIC_FEE_SHARING_PROGRAM_ADDRESS, role: R },
      // Remaining accounts, in the order cp-amm's claim_position_fee takes them.
      { address: input.poolAuthority, role: R },
      { address: input.pool, role: W },
      { address: input.position, role: W },
      { address: input.tokenAAccount, role: W },
      { address: a.tokenVault, role: W },
      { address: input.tokenAVault, role: W },
      { address: input.tokenBVault, role: W },
      { address: input.tokenAMint, role: W },
      { address: input.tokenBMint, role: W },
      { address: input.positionNftAccount, role: R },
      { address: input.feeVault, role: R },
      { address: input.tokenAProgram, role: R },
      { address: input.tokenBProgram, role: R },
      { address: input.dammEventAuthority, role: R },
      { address: CP_AMM_PROGRAM, role: R },
    ],
    data: new Uint8Array(data),
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Reading a vault, and what a recipient can claim (ADR-0912, row D7).
//
// The program keeps one accumulator, `fee_per_share`, a Q64 fixed-point number: every funding adds `(amount << 64) / total_share` to it. A recipient's
// claim is `share * (fee_per_share - checkpoint) >> 64`, and the claim sets the recipient's checkpoint to the accumulator. So what a recipient can claim
// is computable from the vault account alone, with no transaction. The layout (offsets after the 8-byte discriminator) is the program's `FeeVault`
// (`meteora-resources/docs/developer-guides__dynamic-fee-sharing__program__accounts.md`, zero-copy; in a user record the address is at 0, the share at 32, the claimed amount at 40 and the 16-byte-aligned checkpoint at 64, read off a vault the real binary wrote) and is checked
// against the real binary in `tests/core/test/meteora-feeshare-claimable.test.ts`: the computed amount equals the amount a real claim pays.
// ---------------------------------------------------------------------------------------------------------------------

/** The program's fixed-point scale for `fee_per_share` (`PRECISION_SCALE`). */
export const FEE_SHARE_PRECISION_BITS = 64n;
const FEE_VAULT_DISCRIMINATOR = [192, 178, 69, 232, 58, 149, 157, 132];
const FEE_VAULT_SIZE = 8 + 640;
const FEE_VAULT_USERS_AT = 8 + 240;
const FEE_VAULT_USER_SIZE = 80;

export type FeeShareUser = { index: number; address: Address; share: number; feeClaimed: bigint; checkpoint: bigint };
export type FeeShareVaultAccount = { owner: Address; tokenMint: Address; tokenVault: Address; totalShare: number; totalFundedFee: bigint; feePerShare: bigint; base: Address; users: FeeShareUser[] };

/** Decodes a Dynamic Fee Sharing `FeeVault` account; null when the bytes are not one. Unused user slots (default address, zero share) are left out. */
export function decodeFeeShareVault(data: Uint8Array): FeeShareVaultAccount | null {
  if (data.length < FEE_VAULT_SIZE || !FEE_VAULT_DISCRIMINATOR.every((b, i) => data[i] === b)) return null;
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const key = (at: number): Address => address(new PublicKey(data.subarray(at, at + 32)).toBase58());
  const u128 = (at: number) => v.getBigUint64(at, true) | (v.getBigUint64(at + 8, true) << 64n);
  const zero = '11111111111111111111111111111111';
  const users: FeeShareUser[] = [];
  for (let i = 0; i < MAX_FEE_SHARE_RECIPIENTS; i++) {
    const at = FEE_VAULT_USERS_AT + i * FEE_VAULT_USER_SIZE;
    const who = key(at);
    const share = v.getUint32(at + 32, true);
    if (who === zero && share === 0) continue;
    users.push({ index: i, address: who, share, feeClaimed: v.getBigUint64(at + 40, true), checkpoint: u128(at + 64) });
  }
  return { owner: key(8), tokenMint: key(8 + 32), tokenVault: key(8 + 64), totalShare: v.getUint32(8 + 112, true), totalFundedFee: v.getBigUint64(8 + 120, true), feePerShare: u128(8 + 128), base: key(8 + 144), users };
}

/** What the accumulator rises by when `amount` is funded into a vault of `totalShare` shares (floor division, as the program does). */
export function feeShareAccumulatorStep(amount: bigint, totalShare: number): bigint {
  if (totalShare <= 0) throw new Error('a vault has at least one share');
  return (amount << FEE_SHARE_PRECISION_BITS) / BigInt(totalShare);
}

/** What the recipient at `index` would be paid by a claim right now: `share * (fee_per_share - checkpoint) >> 64`. Zero for an index with no recipient. */
export function feeShareClaimable(vault: FeeShareVaultAccount, index: number): bigint {
  const u = vault.users.find((x) => x.index === index);
  if (!u || vault.feePerShare <= u.checkpoint) return 0n;
  return (BigInt(u.share) * (vault.feePerShare - u.checkpoint)) >> FEE_SHARE_PRECISION_BITS;
}

/** What the recipient at `index` could claim once `extra` more is funded into the vault (a projection; nothing is sent). */
export function feeShareClaimableAfterFunding(vault: FeeShareVaultAccount, index: number, extra: bigint): bigint {
  return feeShareClaimable({ ...vault, feePerShare: vault.feePerShare + feeShareAccumulatorStep(extra, vault.totalShare) }, index);
}
