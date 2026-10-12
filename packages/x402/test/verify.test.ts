// Every rule of the exact scheme's verification, one transaction at a time. These are exact-logic tests: each broken
// transaction differs from a correct one in one way, and must be refused for that reason and no other.
import { AccountRole, type Address, generateKeyPairSigner } from '@solana/kit';
import { getSetComputeUnitLimitInstruction, getSetComputeUnitPriceInstruction } from '@solana-program/compute-budget';
import { describe, expect, it } from 'vitest';
import { LIGHTHOUSE_PROGRAM_ADDRESS, MEMO_PROGRAM_ADDRESS, TOKEN_2022_PROGRAM_ADDRESS, TOKEN_PROGRAM_ADDRESS } from '../src/constants.js';
import { inspectTransaction } from '../src/inspect.js';
import { WireError } from '../src/types.js';
import { checkExactTransaction } from '../src/verify.js';
import { type Parties, type Variant, lighthouseInstruction, paymentTransaction, parties, requirementsFor } from './tx-builders.js';

async function verdict(p: Parties, v: Variant = {}, req = requirementsFor(p), feePayers?: string[]) {
  const { message } = await paymentTransaction(p, req, v);
  return checkExactTransaction(message, req, { feePayers: feePayers ?? [p.feePayer.address] });
}

describe('checkExactTransaction', () => {
  it('accepts the canonical payment on both token programs and reports the payer', async () => {
    const p = await parties();
    for (const tokenProgram of [TOKEN_PROGRAM_ADDRESS, TOKEN_2022_PROGRAM_ADDRESS]) {
      const r = await verdict(p, { tokenProgram });
      expect(r).toMatchObject({ ok: true, payer: p.payer.address });
      if (r.ok) expect(r.transfer).toMatchObject({ amount: 10_000n, tokenProgram, mint: p.mint.address });
    }
  });

  it('accepts one and two wallet-injected Lighthouse instructions', async () => {
    const p = await parties();
    expect((await verdict(p, { extra: [lighthouseInstruction(p.payer.address)] })).ok).toBe(true);
    expect((await verdict(p, { extra: [lighthouseInstruction(p.payer.address), lighthouseInstruction(p.payer.address)] })).ok).toBe(true);
  });

  it('refuses an amount, mint or recipient that is not the one required', async () => {
    const p = await parties();
    expect(await verdict(p, { amount: 9_999n })).toMatchObject({ ok: false, reason: 'invalid_exact_svm_payload_amount_mismatch' });
    expect(await verdict(p, { amount: 10_001n })).toMatchObject({ ok: false, reason: 'invalid_exact_svm_payload_amount_mismatch' });
    const other = (await generateKeyPairSigner()).address;
    expect(await verdict(p, { mint: other })).toMatchObject({ ok: false, reason: 'invalid_exact_svm_payload_mint_mismatch' });
    expect(await verdict(p, { destinationOwner: other })).toMatchObject({ ok: false, reason: 'invalid_exact_svm_payload_recipient_mismatch' });
  });

  it('refuses a missing, wrong or unexpected memo', async () => {
    const p = await parties();
    expect(await verdict(p, { memo: null })).toMatchObject({ ok: false, reason: 'invalid_exact_svm_payload_memo_count' });
    expect(await verdict(p, { memo: 'another challenge' })).toMatchObject({ ok: false, reason: 'invalid_exact_svm_payload_memo_mismatch' });
  });

  it('refuses a fee payer that is not the one required, or that this facilitator does not manage', async () => {
    const p = await parties();
    const stranger = (await generateKeyPairSigner()).address;
    expect(await verdict(p, { feePayer: stranger })).toMatchObject({ ok: false, reason: 'invalid_exact_svm_payload_fee_payer_mismatch' });
    expect(await verdict(p, {}, requirementsFor(p), [stranger])).toMatchObject({ ok: false, reason: 'fee_payer_not_managed_by_facilitator' });
  });

  it('refuses a transaction in which the fee payer is an account of an instruction', async () => {
    const p = await parties();
    expect(await verdict(p, { extra: [lighthouseInstruction(p.feePayer.address)] })).toMatchObject({ ok: false, reason: 'invalid_exact_svm_payload_transaction_fee_payer_included_in_instruction_accounts' });
  });

  it('refuses the fee payer as transfer authority', async () => {
    const p = await parties();
    const r = await verdict(p, { authority: p.feePayer });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/fee_payer/);
  });

  it('refuses a priority fee beyond the cap, by price and by the product of limit and price', async () => {
    const p = await parties();
    expect(await verdict(p, { price: 5_000_001n })).toMatchObject({ ok: false, reason: 'invalid_exact_svm_payload_transaction_instructions_compute_price_instruction_too_high' });
    // 200000 units at 5 lamports per unit is 1,000,000 lamports: allowed by the price rule, refused by the product rule.
    expect(await verdict(p, { limit: 200_000, price: 5_000_000n })).toMatchObject({ ok: false, reason: 'invalid_exact_svm_payload_transaction_instructions_compute_price_instruction_too_high' });
    expect(await verdict(p, { limit: 1_400_000 })).toMatchObject({ ok: false, reason: 'invalid_exact_svm_payload_transaction_instructions_compute_limit_instruction_too_high' });
    expect((await verdict(p, { limit: 20_000, price: 500_000n })).ok).toBe(true);
  });

  it('refuses a wrong instruction layout', async () => {
    const p = await parties();
    const limit = getSetComputeUnitLimitInstruction({ units: 20_000 });
    const price = getSetComputeUnitPriceInstruction({ microLamports: 1n });
    expect(await verdict(p, { head: [limit, price], memo: null, skipPayerSignature: true })).toMatchObject({ ok: false, reason: 'invalid_exact_svm_payload_transaction_instructions_length' });
    expect(await verdict(p, { head: [price, limit, price], memo: null, skipPayerSignature: true })).toMatchObject({ ok: false, reason: 'invalid_exact_svm_payload_transaction_instructions_compute_limit_instruction' });
    const three = [lighthouseInstruction(p.payer.address), lighthouseInstruction(p.payer.address), lighthouseInstruction(p.payer.address)];
    expect(await verdict(p, { extra: three })).toMatchObject({ ok: false, reason: 'invalid_exact_svm_payload_transaction_instructions_length' });
  });

  it('refuses any program after the transfer other than Lighthouse and Memo', async () => {
    const p = await parties();
    const stranger = (await generateKeyPairSigner()).address;
    const r = await verdict(p, { extra: [{ programAddress: stranger, accounts: [], data: new Uint8Array([0]) }] });
    expect(r).toMatchObject({ ok: false, reason: 'invalid_exact_svm_payload_unknown_fifth_instruction' });
  });

  it('refuses a payer signature that is missing or is not over this message', async () => {
    const p = await parties();
    expect(await verdict(p, { skipPayerSignature: true })).toMatchObject({ ok: false, reason: 'invalid_exact_svm_payload_signature_missing' });
    const req = requirementsFor(p);
    const { base64 } = await paymentTransaction(p, req);
    // The wire format starts with a one-byte signature count; the second signature (the payer's) starts 64 bytes later.
    const wire = Buffer.from(base64, 'base64');
    wire[1 + 64 + 3] = wire[1 + 64 + 3]! ^ 1;
    const message = inspectTransaction(wire.toString('base64'));
    expect(await checkExactTransaction(message, req, { feePayers: [p.feePayer.address] })).toMatchObject({ ok: false, reason: 'invalid_exact_svm_payload_signature_invalid' });
  });

  it('refuses a third signer', async () => {
    const p = await parties();
    const extraSigner = await generateKeyPairSigner();
    const ix = { programAddress: LIGHTHOUSE_PROGRAM_ADDRESS as Address, accounts: [{ address: extraSigner.address, role: AccountRole.READONLY_SIGNER }], data: new Uint8Array([1]) };
    const r = await verdict(p, { extra: [ix as never] });
    expect(r).toMatchObject({ ok: false, reason: 'invalid_exact_svm_payload_unexpected_signers' });
  });

  it('refuses a memo that names accounts', async () => {
    const p = await parties();
    const req = requirementsFor(p);
    const memoWithAccount = { programAddress: MEMO_PROGRAM_ADDRESS as Address, accounts: [{ address: p.payer.address, role: AccountRole.READONLY }], data: new TextEncoder().encode(req.extra.memo!) };
    const r = await verdict(p, { memo: null, extra: [memoWithAccount as never] });
    expect(r).toMatchObject({ ok: false, reason: 'invalid_exact_svm_payload_memo_has_accounts' });
  });
});

describe('inspectTransaction', () => {
  it('names a payment by the hash of its message, not of its signatures', async () => {
    const p = await parties();
    const req = requirementsFor(p);
    const a = await paymentTransaction(p, req);
    const b = await paymentTransaction(p, req, { skipPayerSignature: true });
    expect(a.message.messageHash).toBe(b.message.messageHash);
    const c = await paymentTransaction(p, requirementsFor(p, {}, 'a different memo'));
    expect(c.message.messageHash).not.toBe(a.message.messageHash);
  });

  it('refuses garbage and oversize input with a coded error', () => {
    for (const junk of ['', 'AAAA', 'not base64 !!', Buffer.alloc(2000, 1).toString('base64')]) {
      expect(() => inspectTransaction(junk)).toThrow(WireError);
    }
  });
});
