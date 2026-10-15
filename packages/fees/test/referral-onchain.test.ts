// The referrer share the program pays at finalize (ADR-0460), as the fee library accounts for it. The fixtures marked "program" are the figures the
// LiteSVM run of the real program asserts in tests/core/test/rules-safety.test.ts ("pays the referrer its share of the protocol fee and nothing else");
// the property tests characterise the rounding without repeating the formula under test.
import { describe, expect, it } from 'vitest';
import {
  type CrossFeeFacts,
  FeeError,
  MAX_REFERRAL_BPS,
  type LedgerEntry,
  type RecordedFinalize,
  allocateAll,
  checkFinalizeTransfers,
  distributeFees,
  expectedFinalizeDistribution,
  ledgerEntry,
  referralLines,
  referralShare,
  referrerStatementWithRouter,
  signStatement,
  statementFromEntries,
  totalsByMint,
  verifyStatement,
} from '../src/index.js';
import { generateKeyPair, getAddressFromPublicKey } from '@solana/kit';

const QUOTE = 'QuoteMint11111111111111111111111111111111111';
const CROSS = 'Cross1111111111111111111111111111111111111111';
const PROTOCOL = 'Protocol11111111111111111111111111111111111';
const INTEGRATOR = 'Integrator1111111111111111111111111111111111';
const ISSUER = 'Issuer111111111111111111111111111111111111111';
const REFERRER = 'Referrer11111111111111111111111111111111111';
const T0 = 1_791_000_000;

const bal = (owner: string, amount: bigint, accountIndex: number) => ({ accountIndex, mint: QUOTE, owner, uiTokenAmount: { amount: amount.toString() } });

// Program fixture: a minting cross raised 100,000,000 with the integrator at 200 bps and the protocol at 30 bps; 10% of the protocol fee goes to the referrer.
//   total fee 2,300,000 = protocol 300,000 + integrator 2,000,000; the referrer receives 30,000 and the fee recipient 270,000.
const facts: CrossFeeFacts = {
  cross: CROSS, creator: ISSUER, kind: 'launch', supplyMode: 'mint', quoteMint: QUOTE, protocolBps: 30, integratorBps: 200,
  integrator: INTEGRATOR, feeRecipient: PROTOCOL, proceedsTo: ISSUER, buyerPaid: 100_000_000n, feesAccrued: 0n, referrer: REFERRER, referralShareBps: 1_000,
};
const recorded: RecordedFinalize = { signature: 'sig-ref', slot: 7, blockTime: T0 + 5, protocolFee: 300_000n, integratorFee: 2_000_000n, proceedsQuote: 97_700_000n };
const finalizeTx = (over: { fee?: bigint; referrer?: bigint } = {}) => ({
  err: null,
  preTokenBalances: [bal(CROSS, 100_000_000n, 1), bal(PROTOCOL, 0n, 2), bal(INTEGRATOR, 0n, 3), bal(ISSUER, 0n, 4), bal(REFERRER, 0n, 5)],
  postTokenBalances: [bal(CROSS, 0n, 1), bal(PROTOCOL, over.fee ?? 270_000n, 2), bal(INTEGRATOR, 2_000_000n, 3), bal(ISSUER, 97_700_000n, 4), bal(REFERRER, over.referrer ?? 30_000n, 5)],
});

describe('referralShare', () => {
  it('is the floor of the protocol fee times the share, as finalize computes it', () => {
    expect(referralShare(300_000n, 1_000)).toBe(30_000n); // program
    expect(referralShare(7n, 5_000)).toBe(3n);
    expect(referralShare(1n, 5_000)).toBe(0n);
    expect(referralShare(9_999n, 1)).toBe(0n);
    expect(referralShare(10_000n, 1)).toBe(1n);
  });

  it('is nothing when either the fee or the share is zero', () => {
    expect(referralShare(0n, 5_000)).toBe(0n);
    expect(referralShare(300_000n, 0)).toBe(0n);
  });

  it('refuses a share above the program cap of half, and a fee that is not a u64', () => {
    expect(MAX_REFERRAL_BPS).toBe(5_000);
    expect(referralShare(1_000n, MAX_REFERRAL_BPS)).toBe(500n);
    expect(() => referralShare(1_000n, MAX_REFERRAL_BPS + 1)).toThrow(FeeError);
    expect(() => referralShare(1_000n, -1)).toThrow(FeeError);
    expect(() => referralShare(1_000n, 12.5)).toThrow(FeeError);
    expect(() => referralShare(-1n, 100)).toThrow(FeeError);
    expect(() => referralShare(1n << 64n, 100)).toThrow(FeeError);
  });

  it('rounds down for any fee and share: the exact remainder property over 20,000 seeded cases', () => {
    let seed = 0x9e3779b9;
    const next = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0), seed);
    for (let i = 0; i < 20_000; i++) {
      const fee = (BigInt(next()) << 21n) ^ BigInt(next());
      const share = next() % (MAX_REFERRAL_BPS + 1);
      const r = referralShare(fee, share);
      // r is the floor of fee*share/10000 exactly when r*10000 <= fee*share < (r+1)*10000.
      expect(r * 10_000n <= fee * BigInt(share)).toBe(true);
      expect(fee * BigInt(share) < (r + 1n) * 10_000n).toBe(true);
      expect(r <= fee / 2n).toBe(true); // never more than half of the protocol fee
    }
  });
});

describe('distributeFees', () => {
  it('takes the referral out of the protocol share and leaves the integrator whole (program fixture)', () => {
    const d = distributeFees(2_300_000n, 30, 200, 1_000);
    expect(d).toEqual({ total: 2_300_000n, protocol: 300_000n, integrator: 2_000_000n, referral: 30_000n, protocolNet: 270_000n });
  });

  it('is the old split when there is no referral', () => {
    const d = distributeFees(2_300_000n, 30, 200);
    expect(d).toEqual({ total: 2_300_000n, protocol: 300_000n, integrator: 2_000_000n, referral: 0n, protocolNet: 300_000n });
  });

  it('a zero-fee cross pays no referral however large the share', () => {
    expect(distributeFees(0n, 0, 0, 5_000)).toEqual({ total: 0n, protocol: 0n, integrator: 0n, referral: 0n, protocolNet: 0n });
    // integrator 0 caps the protocol fee at 0 (ADR-0010): nothing to share.
    expect(distributeFees(1_000_000n, 0, 100, 5_000).referral).toBe(0n);
  });

  it('every atom is accounted for: referral + net + integrator = total, over seeded cases in each supply mode', () => {
    let seed = 12345;
    const next = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0), seed);
    for (let i = 0; i < 5_000; i++) {
      const integratorBps = next() % 301;
      const protocolBps = Math.min(next() % 101, Math.floor(integratorBps / 4));
      const share = next() % (MAX_REFERRAL_BPS + 1);
      const paid = BigInt(next()) * BigInt(1 + (next() % 1000));
      const mode = (['escrow', 'mint', 'deferred-mint'] as const)[next() % 3]!;
      const d = expectedFinalizeDistribution({ supplyMode: mode, protocolBps, integratorBps, buyerPaid: paid, feesAccrued: paid / 997n, referralShareBps: share });
      expect(d.referral + d.protocolNet + d.integrator).toBe(d.total);
      expect(d.referral <= d.protocol).toBe(true);
    }
  });
});

describe('the ledger records the referral', () => {
  it('MATCH when the fee recipient received the protocol fee less the referral and the referrer received the referral (program fixture)', () => {
    const e = ledgerEntry(facts, recorded, finalizeTx());
    expect(e.reasons).toEqual([]);
    expect(e.verdict).toBe('MATCH');
    expect(e.expected).toEqual({ total: 2_300_000n, protocol: 300_000n, integrator: 2_000_000n });
    expect(e.referrer).toBe(REFERRER);
    expect(e.referral).toBe(30_000n);
  });

  it('MISMATCH, naming the fee recipient, when it was paid the whole protocol fee (the referral never left the vault)', () => {
    const e = ledgerEntry(facts, recorded, finalizeTx({ fee: 300_000n, referrer: 0n }));
    expect(e.verdict).toBe('MISMATCH');
    expect(e.reasons.join(' ')).toMatch(new RegExp(`${PROTOCOL} changed by 300000, the ledger expects 270000`));
  });

  it('MISMATCH, naming the referrer, when it was paid one atom too little', () => {
    const e = ledgerEntry(facts, recorded, finalizeTx({ referrer: 29_999n }));
    expect(e.verdict).toBe('MISMATCH');
    expect(e.reasons.join(' ')).toContain(REFERRER);
  });

  it('a cross that names no referrer is unchanged: the old ledger line, and a referral that was paid anyway is a MISMATCH', () => {
    const plain = { ...facts, referrer: undefined, referralShareBps: undefined };
    const clean = { err: null, preTokenBalances: [bal(CROSS, 100_000_000n, 1)], postTokenBalances: [bal(CROSS, 0n, 1), bal(PROTOCOL, 300_000n, 2), bal(INTEGRATOR, 2_000_000n, 3), bal(ISSUER, 97_700_000n, 4)] };
    const e = ledgerEntry(plain, recorded, clean);
    expect(e.verdict).toBe('MATCH');
    expect(e.referrer).toBeNull();
    expect(e.referral).toBe(0n);
    expect(ledgerEntry(plain, recorded, finalizeTx()).verdict).toBe('MISMATCH');
  });

  it('a share with no referrer, and a share above the cap, are reported, not guessed at', () => {
    expect(ledgerEntry({ ...facts, referrer: undefined }, recorded, null).reasons.join(' ')).toMatch(/names a share but no referrer/);
    expect(ledgerEntry({ ...facts, referralShareBps: 5_001 }, recorded, null).reasons.join(' ')).toMatch(/above the program's cap of 5000/);
  });

  it('a share of zero with a referrer named is no referral at all', () => {
    const e = ledgerEntry({ ...facts, referralShareBps: 0 }, recorded, null);
    expect(e.referrer).toBeNull();
    expect(e.referral).toBe(0n);
  });

  it('UNVERIFIED, not MATCH, when the transaction could not be read, and the referral is still stated', () => {
    const e = ledgerEntry(facts, recorded, null);
    expect(e.verdict).toBe('UNVERIFIED');
    expect(e.referral).toBe(30_000n);
  });

  it('the referrer and the fee recipient may be one wallet: the roles are checked in aggregate', () => {
    const both = { ...facts, referrer: PROTOCOL };
    const tx = { err: null, preTokenBalances: [bal(CROSS, 100_000_000n, 1)], postTokenBalances: [bal(CROSS, 0n, 1), bal(PROTOCOL, 300_000n, 2), bal(INTEGRATOR, 2_000_000n, 3), bal(ISSUER, 97_700_000n, 4)] };
    expect(ledgerEntry(both, recorded, tx).verdict).toBe('MATCH');
  });

  it('the transfer check refuses a referral that is larger than the fee it comes out of, or has no referrer', () => {
    const roles = { quoteMint: QUOTE, cross: CROSS, feeRecipient: PROTOCOL, integrator: INTEGRATOR, proceedsTo: ISSUER, protocolFee: 300_000n, integratorFee: 2_000_000n, proceedsQuote: 97_700_000n };
    expect(checkFinalizeTransfers(finalizeTx(), { ...roles, referrer: REFERRER, referral: 300_001n }).ok).toBe(false);
    expect(checkFinalizeTransfers(finalizeTx(), { ...roles, referral: 30_000n }).ok).toBe(false);
    expect(checkFinalizeTransfers(finalizeTx(), { ...roles, referrer: REFERRER, referral: 30_000n }).ok).toBe(true);
  });

  it('totals keep the gross protocol fee and the part that went to referrers apart', () => {
    const referred = ledgerEntry(facts, recorded, finalizeTx());
    const plain = ledgerEntry({ ...facts, referrer: undefined, referralShareBps: undefined }, { ...recorded, signature: 'sig-plain' }, {
      err: null,
      preTokenBalances: [bal(CROSS, 100_000_000n, 1)],
      postTokenBalances: [bal(CROSS, 0n, 1), bal(PROTOCOL, 300_000n, 2), bal(INTEGRATOR, 2_000_000n, 3), bal(ISSUER, 97_700_000n, 4)],
    });
    const t = totalsByMint([referred, plain]).verified[QUOTE]!;
    expect(t).toEqual({ protocolFee: 600_000n, integratorFee: 4_000_000n, referralFee: 30_000n, crosses: 2 });
  });
});

describe('allocation and the router', () => {
  const entry = ledgerEntry(facts, recorded, finalizeTx());

  it('counts the referral a cross paid itself as a referral, out of the gross protocol fee', () => {
    const a = allocateAll([entry])[QUOTE]!;
    expect(a).toEqual({ gross: 300_000n, referrals: 30_000n, rebatePool: 0n, operating: 270_000n });
  });

  it('the router owes nothing on a cross that names a referrer on chain, so one protocol fee never pays two referrals', () => {
    const order = { cross: CROSS, order: 'o1', owner: 'Owner11111111111111111111111111111111111111', side: 'buy' as const, placedAt: T0, notional: 100_000_000n, escrowFee: 0n };
    const docs = [{ schema: 'opening-cross/referral/v1' as const, owner: order.owner, referrer: 'Other111111111111111111111111111111111111111', effectiveFrom: 0, nonce: '0'.repeat(16) }];
    const cross = { cross: CROSS, supplyMode: 'mint' as const, protocolBps: 30, integratorBps: 200, protocolFee: 300_000n };
    expect(referralLines(cross, [order], docs)).toHaveLength(1);
    expect(referralLines({ ...cross, referralShareBps: 1_000 }, [order], docs)).toEqual([]);
  });
});

describe('statements carry the referrer role', () => {
  const entry: LedgerEntry = ledgerEntry(facts, recorded, finalizeTx());
  const noRef = ledgerEntry({ ...facts, cross: 'Cross2', referrer: undefined, referralShareBps: undefined }, { ...recorded, signature: 'sig-2', blockTime: T0 + 6 }, {
    err: null,
    preTokenBalances: [bal('Cross2', 100_000_000n, 1)],
    postTokenBalances: [bal('Cross2', 0n, 1), bal(PROTOCOL, 300_000n, 2), bal(INTEGRATOR, 2_000_000n, 3), bal(ISSUER, 97_700_000n, 4)],
  });

  it('the referrer sees the referral each cross paid it, MATCH against the chain', () => {
    const s = statementFromEntries('devnet', 'referrer', REFERRER, [entry, noRef], T0, T0 + 100);
    expect(s.role).toBe('referrer');
    expect(s.lines).toEqual([{ ref: CROSS, signature: 'sig-ref', at: T0 + 5, quoteMint: QUOTE, amount: '30000', verdict: 'MATCH' }]);
    expect(s.totals[QUOTE]).toBe('30000');
    expect(s.counts).toEqual({ match: 1, unverified: 0, mismatch: 0 });
  });

  it('the protocol statement shows what the fee recipient was paid, the protocol fee less the referral; integrator and issuer are unchanged', () => {
    expect(statementFromEntries('devnet', 'protocol', PROTOCOL, [entry, noRef], T0, T0 + 100).lines.map((l) => l.amount)).toEqual(['270000', '300000']);
    expect(statementFromEntries('devnet', 'integrator', INTEGRATOR, [entry], T0, T0 + 100).lines.map((l) => l.amount)).toEqual(['2000000']);
    expect(statementFromEntries('devnet', 'issuer', ISSUER, [entry], T0, T0 + 100).lines.map((l) => l.amount)).toEqual(['2300000']);
  });

  it('a party that is not the referrer has no referrer line, and a period outside the finalize has none', () => {
    expect(statementFromEntries('devnet', 'referrer', PROTOCOL, [entry], T0, T0 + 100).lines).toEqual([]);
    expect(statementFromEntries('devnet', 'referrer', REFERRER, [entry], T0 + 6, T0 + 100).lines).toEqual([]);
  });

  it('a referral whose transaction was not checked is UNVERIFIED and is not summed', () => {
    const unchecked = ledgerEntry(facts, recorded, null);
    const s = statementFromEntries('devnet', 'referrer', REFERRER, [unchecked], T0, T0 + 100);
    expect(s.counts).toEqual({ match: 0, unverified: 1, mismatch: 0 });
    expect(s.totals).toEqual({});
  });

  it('puts the on-chain referral and the router payouts in one referrer statement, and the signed document verifies', async () => {
    const router = [{ cross: 'CrossR', order: 'oR', owner: 'x', referrer: REFERRER, protocolFeeShare: 50_000n, payout: 5_000n, quoteMint: QUOTE, at: T0 + 7, paidBy: 'router-sig' }];
    const body = referrerStatementWithRouter('devnet', REFERRER, [entry], router, T0, T0 + 100);
    expect(body.lines.map((l) => [l.ref, l.amount, l.verdict])).toEqual([[CROSS, '30000', 'MATCH'], ['oR', '5000', 'MATCH']]);
    expect(body.totals[QUOTE]).toBe('35000');
    const kp = await generateKeyPair();
    const signer = await getAddressFromPublicKey(kp.publicKey);
    const signed = await signStatement(body, kp, signer);
    expect(await verifyStatement(signed, signer)).toEqual({ ok: true });
    const forged = { ...signed, body: { ...signed.body, lines: signed.body.lines.map((l, i) => (i === 0 ? { ...l, amount: '3000000' } : l)) } };
    expect((await verifyStatement(forged, signer)).ok).toBe(false);
  });
});
