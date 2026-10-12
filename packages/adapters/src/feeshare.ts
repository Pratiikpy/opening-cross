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
  if (r.length < 1 || r.length > MAX_FEE_SHARE_RECIPIENTS) throw new Error(`a fee-sharing vault has 1 to ${MAX_FEE_SHARE_RECIPIENTS} recipients`);
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
