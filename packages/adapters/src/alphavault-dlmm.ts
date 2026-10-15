// Alpha Vault on a DLMM pair, and the depositor's way out (ADR-0910; rows X13, R2, V-D).
//
// A batch-opened DLMM pair (`buildOpenDlmmPair` with `batch.alphaVault`) cannot trade before its start, except for the one Alpha Vault DLMM records for it.
// The vault is the same program as for DAMM v2 (`alphavault.ts`); only the fill differs: `fill_dlmm` buys base from the bins above the active bin with the
// quote the vault holds. The layouts are from the program's published IDL (`idls/alpha_vault.json`).
import { createHash } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import { AccountRole, type Address, type Instruction, type TransactionSigner, address } from '@solana/kit';
import { ata } from '@opening-cross/sdk';
import { ALPHA_VAULT_PROGRAM_ADDRESS, ALPHA_VAULT_TREASURY_ADDRESS, alphaEscrowAddress } from './alphavault.js';
import { DLMM_PROGRAM_ADDRESS, binArrayAddress, binArrayIndex, dlmmAddresses } from './dlmm.js';

const PROGRAM = new PublicKey(ALPHA_VAULT_PROGRAM_ADDRESS);
const SYSTEM_PROGRAM = address('11111111111111111111111111111111');
const MEMO_PROGRAM = address('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
const disc = (name: string) => createHash('sha256').update(`global:${name}`).digest().subarray(0, 8);
const events = () => address(PublicKey.findProgramAddressSync([Buffer.from('__event_authority')], PROGRAM)[0].toBase58());
const u64 = (v: bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(v);
  return b;
};

/** A transfer-hook slice of `fill_dlmm`'s `RemainingAccountsInfo`: which side's hook accounts follow, and how many. */
export type AlphaHookSlice = { side: 'x' | 'y'; length: number };

export type AlphaDlmmPair = { address: Address; reserveX: Address; reserveY: Address; tokenXMint: Address; tokenYMint: Address; oracle: Address; tokenXProgram: Address; tokenYProgram: Address; eventAuthority: Address };

/** The DLMM accounts of a cross's pair (token X is the base, token Y the quote), derived from the two mints. */
export function dlmmPairFor(baseMint: Address, quoteMint: Address, baseTokenProgram: Address, quoteTokenProgram: Address): AlphaDlmmPair {
  const d = dlmmAddresses(baseMint, quoteMint);
  return { address: d.lbPair, reserveX: d.reserveX, reserveY: d.reserveY, tokenXMint: baseMint, tokenYMint: quoteMint, oracle: d.oracle, tokenXProgram: baseTokenProgram, tokenYProgram: quoteTokenProgram, eventAuthority: d.eventAuthority };
}

/** The bin arrays between two bin ids (inclusive), lowest index first: the arrays a purchase walks up through. */
export function dlmmBinArraysBetween(lbPair: Address, fromBin: number, toBin: number): Address[] {
  if (toBin < fromBin) throw new Error('toBin is below fromBin');
  const out: Address[] = [];
  for (let i = binArrayIndex(fromBin); i <= binArrayIndex(toBin); i++) out.push(binArrayAddress(lbPair, i));
  return out;
}

export type AlphaFillDlmmInput = {
  vault: Address;
  cranker: TransactionSigner;
  maxAmount: bigint;
  tokenVault: Address;
  tokenOutVault: Address;
  pair: AlphaDlmmPair;
  /**
   * The bin arrays the purchase walks, nearest the active bin first. Buying base (token X) with quote (token Y) moves the price up, so these run from the
   * active bin's array to the highest bin that holds base. Every one must already exist.
   */
  binArrays: Address[];
  /** Transfer-hook accounts of the pair's mints, in the order of `hooks`; they are placed before the bin arrays. */
  hookAccounts?: Address[];
  hooks?: AlphaHookSlice[];
};

/**
 * Permissionless crank for a DLMM pair (pool type 0): before the pair opens, the vault buys base from the bins above the active bin with up to `maxAmount`
 * of the quote it holds. DLMM accepts only the vault derived from the pair's creator as a pre-activation buyer.
 */
export function buildAlphaFillDlmm(input: AlphaFillDlmmInput): Instruction {
  const p = input.pair;
  const hooks = input.hooks ?? [];
  const hookAccounts = input.hookAccounts ?? [];
  if (hooks.reduce((n, h) => n + h.length, 0) !== hookAccounts.length) throw new Error('hook slices must account for exactly the hook accounts given');
  if (input.binArrays.length === 0) throw new Error('a DLMM fill needs at least one bin array');
  const info = Buffer.alloc(4 + hooks.length * 2);
  info.writeUInt32LE(hooks.length, 0);
  hooks.forEach((h, i) => {
    info.writeUInt8(h.side === 'x' ? 0 : 1, 4 + i * 2);
    info.writeUInt8(h.length, 5 + i * 2);
  });
  return {
    programAddress: ALPHA_VAULT_PROGRAM_ADDRESS,
    accounts: [
      { address: input.vault, role: AccountRole.WRITABLE },
      { address: input.tokenVault, role: AccountRole.WRITABLE },
      { address: input.tokenOutVault, role: AccountRole.WRITABLE },
      { address: DLMM_PROGRAM_ADDRESS, role: AccountRole.READONLY },
      { address: p.address, role: AccountRole.WRITABLE },
      { address: DLMM_PROGRAM_ADDRESS, role: AccountRole.READONLY }, // bin_array_bitmap_extension: None (the callee is DLMM)
      { address: p.reserveX, role: AccountRole.WRITABLE },
      { address: p.reserveY, role: AccountRole.WRITABLE },
      { address: p.tokenXMint, role: AccountRole.READONLY },
      { address: p.tokenYMint, role: AccountRole.READONLY },
      { address: p.oracle, role: AccountRole.WRITABLE },
      { address: p.tokenXProgram, role: AccountRole.READONLY },
      { address: p.tokenYProgram, role: AccountRole.READONLY },
      { address: p.eventAuthority, role: AccountRole.READONLY },
      { address: ALPHA_VAULT_PROGRAM_ADDRESS, role: AccountRole.READONLY }, // crank_fee_whitelist: None
      { address: ALPHA_VAULT_TREASURY_ADDRESS, role: AccountRole.WRITABLE },
      { address: input.cranker.address, role: AccountRole.WRITABLE_SIGNER, signer: input.cranker } as never,
      { address: SYSTEM_PROGRAM, role: AccountRole.READONLY },
      { address: MEMO_PROGRAM, role: AccountRole.READONLY },
      { address: events(), role: AccountRole.READONLY },
      { address: ALPHA_VAULT_PROGRAM_ADDRESS, role: AccountRole.READONLY },
      ...hookAccounts.map((a) => ({ address: a, role: AccountRole.READONLY })),
      ...input.binArrays.map((a) => ({ address: a, role: AccountRole.WRITABLE })),
    ],
    data: new Uint8Array(Buffer.concat([disc('fill_dlmm'), u64(input.maxAmount), info])),
  };
}

/**
 * A depositor takes quote back out of the vault while deposits are open (`withdraw`; the vault refuses it in first-come mode and outside the deposit window).
 * Withdrawing everything leaves an empty escrow that `buildAlphaCloseEscrow` closes.
 */
export async function buildAlphaWithdraw(input: { vault: Address; pool: Address; owner: TransactionSigner; quoteMint: Address; quoteTokenProgram: Address; tokenVault: Address; amount: bigint }): Promise<Instruction> {
  return {
    programAddress: ALPHA_VAULT_PROGRAM_ADDRESS,
    accounts: [
      { address: input.vault, role: AccountRole.WRITABLE },
      { address: input.pool, role: AccountRole.READONLY },
      { address: alphaEscrowAddress(input.vault, input.owner.address), role: AccountRole.WRITABLE },
      { address: await ata(input.owner.address, input.quoteMint, input.quoteTokenProgram), role: AccountRole.WRITABLE },
      { address: input.tokenVault, role: AccountRole.WRITABLE },
      { address: input.quoteMint, role: AccountRole.READONLY },
      { address: input.quoteTokenProgram, role: AccountRole.READONLY },
      { address: input.owner.address, role: AccountRole.READONLY_SIGNER, signer: input.owner } as never,
      { address: events(), role: AccountRole.READONLY },
      { address: ALPHA_VAULT_PROGRAM_ADDRESS, role: AccountRole.READONLY },
    ],
    data: new Uint8Array(Buffer.concat([disc('withdraw'), u64(input.amount)])),
  };
}

/** Closes the owner's escrow and returns its rent to `rentReceiver`; the vault refuses it while the escrow still holds a deposit, a claim or a refund (`EscrowIsNotClosable`). */
export function buildAlphaCloseEscrow(input: { vault: Address; owner: TransactionSigner; rentReceiver: Address }): Instruction {
  return {
    programAddress: ALPHA_VAULT_PROGRAM_ADDRESS,
    accounts: [
      { address: input.vault, role: AccountRole.WRITABLE },
      { address: alphaEscrowAddress(input.vault, input.owner.address), role: AccountRole.WRITABLE },
      { address: input.owner.address, role: AccountRole.READONLY_SIGNER, signer: input.owner } as never,
      { address: input.rentReceiver, role: AccountRole.WRITABLE },
      { address: events(), role: AccountRole.READONLY },
      { address: ALPHA_VAULT_PROGRAM_ADDRESS, role: AccountRole.READONLY },
    ],
    data: new Uint8Array(disc('close_escrow')),
  };
}
