import { generateKeyPair, getAddressFromPublicKey } from '@solana/kit';
import { describe, expect, it } from 'vitest';
import { type CrossFeeFacts, type LedgerEntry, ledgerEntry, referrerStatement, signStatement, statementFromEntries, verifyStatement } from '../src/index.js';

const QUOTE = 'QuoteMint11111111111111111111111111111111111';
const INTEGRATOR = 'Integrator1111111111111111111111111111111111';
const PROTOCOL = 'Protocol11111111111111111111111111111111111';
const ISSUER = 'Issuer111111111111111111111111111111111111111';
const T0 = 1_791_000_000;

const entry = (cross: string, over: Partial<CrossFeeFacts>, protocolFee: bigint, integratorFee: bigint, at: number | null): LedgerEntry => {
  const facts: CrossFeeFacts = { cross, creator: ISSUER, kind: 'launch', supplyMode: 'mint', quoteMint: QUOTE, protocolBps: 5, integratorBps: 20, integrator: INTEGRATOR, feeRecipient: PROTOCOL, proceedsTo: ISSUER, buyerPaid: (protocolFee + integratorFee) * 10_000n / 25n, feesAccrued: 0n, ...over };
  return ledgerEntry(facts, { signature: `sig-${cross}`, slot: 1, blockTime: at, protocolFee, integratorFee, proceedsQuote: 0n }, null);
};

describe('statements', () => {
  const entries = [entry('A', {}, 1_200_000n, 4_800_000n, T0 + 10), entry('B', {}, 1_875_000n, 7_500_000n, T0 + 20), entry('C', { integrator: 'Other11111111111111111111111111111111111111' }, 100n, 400n, T0 + 30), entry('D', {}, 1_200_000n, 4_800_000n, T0 + 9_999_999)];

  it('an integrator sees only its own fee income in the period, and unverified lines are not summed', () => {
    const s = statementFromEntries('devnet', 'integrator', INTEGRATOR, entries, T0, T0 + 1000);
    expect(s.lines.map((l) => l.ref)).toEqual(['A', 'B']);
    // No transaction was fetched, so both lines are UNVERIFIED and nothing is in the totals.
    expect(s.counts).toEqual({ match: 0, unverified: 2, mismatch: 0 });
    expect(s.totals).toEqual({});
  });

  it('an issuer pays the whole fee in a mint cross and nothing in an escrow cross', () => {
    const escrow = entry('E', { supplyMode: 'escrow', buyerPaid: 0n, feesAccrued: 5_000n }, 1_000n, 4_000n, T0 + 40);
    const s = statementFromEntries('devnet', 'issuer', ISSUER, [...entries, escrow], T0, T0 + 1000);
    expect(s.lines.map((l) => [l.ref, l.amount])).toEqual([['A', '6000000'], ['B', '9375000'], ['C', '500']]);
  });

  it('the protocol statement is the fee recipient\'s protocol fees', () => {
    const s = statementFromEntries('devnet', 'protocol', PROTOCOL, entries, T0, T0 + 1000);
    expect(s.lines.map((l) => l.amount)).toEqual(['1200000', '1875000', '100']);
  });

  it('a signed statement verifies, and any edit is caught', async () => {
    const kp = await generateKeyPair();
    const signer = await getAddressFromPublicKey(kp.publicKey);
    const body = statementFromEntries('devnet', 'integrator', INTEGRATOR, entries, T0, T0 + 1000);
    const signed = await signStatement(body, kp, signer);
    expect(await verifyStatement(signed, signer)).toEqual({ ok: true });
    expect((await verifyStatement(signed, PROTOCOL))).toEqual({ ok: false, reason: 'WRONG_SIGNER' });
    const edited = { ...signed, body: { ...signed.body, lines: signed.body.lines.map((l, i) => (i === 0 ? { ...l, amount: '999999999' } : l)) } };
    expect((await verifyStatement(edited, signer)).ok).toBe(false);
    expect((await verifyStatement({ ...signed, signature: 'f'.repeat(128) }, signer))).toEqual({ ok: false, reason: 'BAD_SIGNATURE' });
  });

  it('refuses a statement whose totals do not equal its MATCH lines even if re-signed', async () => {
    const kp = await generateKeyPair();
    const signer = await getAddressFromPublicKey(kp.publicKey);
    const body = statementFromEntries('devnet', 'integrator', INTEGRATOR, entries, T0, T0 + 1000);
    const lying = { ...body, totals: { [QUOTE]: '123' } };
    const signed = await signStatement(lying, kp, signer);
    expect(await verifyStatement(signed, signer)).toEqual({ ok: false, reason: 'TOTALS_MISMATCH' });
  });

  it('a referrer statement is MATCH only for payouts that were paid on chain', async () => {
    const lines = [
      { cross: 'A', order: 'o1', owner: 'x', referrer: INTEGRATOR, protocolFeeShare: 500_000n, payout: 50_000n, quoteMint: QUOTE, at: T0 + 5, paidBy: 'paid-sig' },
      { cross: 'A', order: 'o2', owner: 'y', referrer: INTEGRATOR, protocolFeeShare: 100_000n, payout: 10_000n, quoteMint: QUOTE, at: T0 + 6, paidBy: null },
    ];
    const s = referrerStatement('devnet', INTEGRATOR, lines, T0, T0 + 100);
    expect(s.counts).toEqual({ match: 1, unverified: 1, mismatch: 0 });
    expect(s.totals[QUOTE]).toBe('50000');
  });
});
