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
