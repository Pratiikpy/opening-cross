// Shared pieces of the builders for the seven Wave 3D programs (cross_mandate, cross_conviction, cross_basket, cross_listing, cross_bounty,
// cross_backing, cross_graduate; ADR-0650 to ADR-0656). They build unsigned instructions only; nothing here signs or sends.
import { type Address, type Instruction, type TransactionSigner, createNoopSigner } from '@solana/kit';
import { ASSOCIATED_TOKEN_PROGRAM_ADDRESS, TOKEN_2022_PROGRAM_ADDRESS, getCreateAssociatedTokenIdempotentInstruction } from '@solana-program/token-2022';

export const SPL_TOKEN_PROGRAM: Address = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' as Address;
export const TOKEN_2022_PROGRAM: Address = TOKEN_2022_PROGRAM_ADDRESS;
export const ASSOCIATED_TOKEN_PROGRAM: Address = ASSOCIATED_TOKEN_PROGRAM_ADDRESS;
export const SYSTEM_PROGRAM: Address = '11111111111111111111111111111111' as Address;

/** A signer that signs nothing: the wallet that will sign later, named so the instruction carries its signer meta. */
export const noop = (a: Address): TransactionSigner => createNoopSigner(a);

/** One problem a program would refuse, found before a transaction is built: a stable `code` (the program's own error name where there is one), the field and a sentence. */
export type ProgramIssue = { code: string; field: string; message: string };

/** Creates `owner`'s associated token account for `mint` if it is missing (idempotent); `payer` pays the rent. */
export function createAtaIdempotent(payer: TransactionSigner, owner: Address, mint: Address, tokenProgram: Address, ata: Address): Instruction {
  return getCreateAssociatedTokenIdempotentInstruction({ payer, ata, owner, mint, tokenProgram });
}

/** Rent per byte-year of the cluster's default rent schedule, times the two-year exemption: 6,960 lamports per byte, 128 bytes of account overhead. */
export const rentExempt = (dataBytes: number): bigint => BigInt(128 + dataBytes) * 6_960n;

export const U64_MAX = (1n << 64n) - 1n;
export const I64_MAX = (1n << 63n) - 1n;
export const SECS_PER_DAY = 86_400n;

/** The refusal of a builder that is given facts the program would reject: carries every issue. */
export class ProgramRefusal extends Error {
  constructor(readonly issues: ProgramIssue[]) {
    super(issues.map((i) => `${i.code}: ${i.message}`).join('; '));
  }
}
export function refuse(issues: ProgramIssue[]): void {
  if (issues.length > 0) throw new ProgramRefusal(issues);
}
