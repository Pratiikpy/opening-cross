// The checks a facilitator must pass before it lends its signature as fee payer (scheme_exact_svm.md, "Facilitator
// Verification Rules"), plus two this implementation adds: a ceiling on the priority fee the payer can make the fee
// payer spend, and a refusal of any signer other than the fee payer and the transfer authority.
import { type Address, getPublicKeyFromAddress, verifySignature } from '@solana/kit';
import { findAssociatedTokenPda } from '@solana-program/token-2022';
import {
  COMPUTE_BUDGET_PROGRAM_ADDRESS,
  LIGHTHOUSE_PROGRAM_ADDRESS,
  MAX_COMPUTE_UNIT_LIMIT,
  MAX_COMPUTE_UNIT_PRICE_MICROLAMPORTS,
  MAX_PRIORITY_FEE_LAMPORTS,
  MEMO_PROGRAM_ADDRESS,
  SET_COMPUTE_UNIT_LIMIT,
  SET_COMPUTE_UNIT_PRICE,
  TOKEN_2022_PROGRAM_ADDRESS,
  TOKEN_PROGRAM_ADDRESS,
  TRANSFER_CHECKED,
} from './constants.js';
import type { InspectedTransaction } from './inspect.js';
import type { PaymentRequirements } from './types.js';

export type Transfer = { source: Address; mint: Address; destination: Address; authority: Address; amount: bigint; decimals: number; tokenProgram: Address };

export type StaticCheck =
  | { ok: true; payer: Address; transfer: Transfer; priorityFeeLamports: bigint }
  | { ok: false; reason: string; payer?: Address; message?: string };

export type StaticCheckContext = {
  /** Addresses this facilitator signs for. The transaction's fee payer must be one of them and the one the requirements name. */
  feePayers: readonly string[];
  maxPriorityFeeLamports?: bigint;
  maxComputeUnitLimit?: number;
  /** Accept the price instruction before the limit instruction. The official MPP client emits that order; the x402 scheme fixes limit first. */
  anyComputeBudgetOrder?: boolean;
};

const fail = (reason: string, payer?: Address, message?: string): StaticCheck => ({ ok: false, reason, ...(payer ? { payer } : {}), ...(message ? { message } : {}) });
const u32le = (b: Uint8Array, o: number) => new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(o, true);
const u64le = (b: Uint8Array, o: number) => new DataView(b.buffer, b.byteOffset, b.byteLength).getBigUint64(o, true);

export async function checkExactTransaction(tx: InspectedTransaction, req: PaymentRequirements, ctx: StaticCheckContext): Promise<StaticCheck> {
  let ixs = tx.instructions;
  if (ctx.anyComputeBudgetOrder && ixs.length >= 2 && ixs[0]!.program === COMPUTE_BUDGET_PROGRAM_ADDRESS && ixs[0]!.data[0] === SET_COMPUTE_UNIT_PRICE && ixs[1]!.program === COMPUTE_BUDGET_PROGRAM_ADDRESS && ixs[1]!.data[0] === SET_COMPUTE_UNIT_LIMIT) {
    ixs = [ixs[1]!, ixs[0]!, ...ixs.slice(2)];
  }
  // Layout: compute limit, compute price, transfer, then up to three of Lighthouse or Memo.
  if (ixs.length < 3 || ixs.length > 6) return fail('invalid_exact_svm_payload_transaction_instructions_length');

  const limitIx = ixs[0]!;
  if (limitIx.program !== COMPUTE_BUDGET_PROGRAM_ADDRESS || limitIx.data.length !== 5 || limitIx.data[0] !== SET_COMPUTE_UNIT_LIMIT || limitIx.accounts.length !== 0) {
    return fail('invalid_exact_svm_payload_transaction_instructions_compute_limit_instruction');
  }
  const units = u32le(limitIx.data, 1);
  if (units > (ctx.maxComputeUnitLimit ?? MAX_COMPUTE_UNIT_LIMIT)) return fail('invalid_exact_svm_payload_transaction_instructions_compute_limit_instruction_too_high');

  const priceIx = ixs[1]!;
  if (priceIx.program !== COMPUTE_BUDGET_PROGRAM_ADDRESS || priceIx.data.length !== 9 || priceIx.data[0] !== SET_COMPUTE_UNIT_PRICE || priceIx.accounts.length !== 0) {
    return fail('invalid_exact_svm_payload_transaction_instructions_compute_price_instruction');
  }
  const microLamports = u64le(priceIx.data, 1);
  const priorityFee = (BigInt(units) * microLamports + 999_999n) / 1_000_000n;
  if (microLamports > MAX_COMPUTE_UNIT_PRICE_MICROLAMPORTS || priorityFee > (ctx.maxPriorityFeeLamports ?? MAX_PRIORITY_FEE_LAMPORTS)) {
    return fail('invalid_exact_svm_payload_transaction_instructions_compute_price_instruction_too_high');
  }

  if (tx.feePayer !== req.extra.feePayer) return fail('invalid_exact_svm_payload_fee_payer_mismatch');
  if (!ctx.feePayers.includes(tx.feePayer)) return fail('fee_payer_not_managed_by_facilitator');

  const t = ixs[2]!;
  if ((t.program !== TOKEN_PROGRAM_ADDRESS && t.program !== TOKEN_2022_PROGRAM_ADDRESS) || t.data.length !== 10 || t.data[0] !== TRANSFER_CHECKED) {
    return fail('invalid_exact_svm_payload_no_transfer_instruction');
  }
  if (t.accounts.length !== 4) return fail('invalid_exact_svm_payload_transfer_accounts', undefined, 'a multisig authority is not supported');
  const [source, mint, destination, authority] = t.accounts as [Address, Address, Address, Address];
  const transfer: Transfer = { source, mint, destination, authority, amount: u64le(t.data, 1), decimals: t.data[9]!, tokenProgram: t.program };

  // The fee payer must never be an account of any instruction: it could otherwise be made to move its own funds.
  for (const ix of ixs) {
    if (ix.accounts.includes(tx.feePayer) || ix.program === tx.feePayer) return fail('invalid_exact_svm_payload_transaction_fee_payer_included_in_instruction_accounts', authority);
  }
  if (authority === tx.feePayer || source === tx.feePayer) return fail('invalid_exact_svm_payload_transaction_fee_payer_transferring_funds', authority);

  if (mint !== req.asset) return fail('invalid_exact_svm_payload_mint_mismatch', authority);
  const [expectedDestination] = await findAssociatedTokenPda({ mint: req.asset as Address, owner: req.payTo as Address, tokenProgram: t.program });
  if (destination !== expectedDestination) return fail('invalid_exact_svm_payload_recipient_mismatch', authority);
  if (transfer.amount !== BigInt(req.amount)) return fail('invalid_exact_svm_payload_amount_mismatch', authority);

  const optional = ixs.slice(3);
  const unknownAt = ['invalid_exact_svm_payload_unknown_fourth_instruction', 'invalid_exact_svm_payload_unknown_fifth_instruction', 'invalid_exact_svm_payload_unknown_sixth_instruction'];
  for (const [i, ix] of optional.entries()) {
    if (ix.program !== LIGHTHOUSE_PROGRAM_ADDRESS && ix.program !== MEMO_PROGRAM_ADDRESS) return fail(unknownAt[i]!, authority);
  }
  const memos = optional.filter((ix) => ix.program === MEMO_PROGRAM_ADDRESS);
  if (req.extra.memo !== undefined) {
    if (memos.length !== 1) return fail('invalid_exact_svm_payload_memo_count', authority);
    const memo = memos[0]!;
    if (memo.accounts.length !== 0) return fail('invalid_exact_svm_payload_memo_has_accounts', authority);
    if (new TextDecoder('utf-8', { fatal: false }).decode(memo.data) !== req.extra.memo) return fail('invalid_exact_svm_payload_memo_mismatch', authority);
  }

  // Only the fee payer and the transfer authority sign. The authority's signature must verify over the message.
  const signers = new Set<string>(tx.signers);
  if (signers.size !== 2 || !signers.has(tx.feePayer) || !signers.has(authority)) return fail('invalid_exact_svm_payload_unexpected_signers', authority);
  const sig = tx.signatures[authority];
  if (!sig) return fail('invalid_exact_svm_payload_signature_missing', authority);
  if (!(await verifySignature(await getPublicKeyFromAddress(authority), sig, tx.messageBytes as never))) return fail('invalid_exact_svm_payload_signature_invalid', authority);

  return { ok: true, payer: authority, transfer, priorityFeeLamports: priorityFee };
}
