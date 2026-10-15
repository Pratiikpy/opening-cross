// Ledger entries against transaction balances. The transaction below is built to have the exact shape of a
// jsonParsed `meta` (pre/post token balances with owners); the devnet cross it models is checked against the
// real chain in tests/core/test/billing.test.ts and docs/evidence/D-billing.md.
import { describe, expect, it } from 'vitest';
import { type CrossFeeFacts, type RecordedFinalize, checkFinalizeTransfers, ledgerEntry, ownerDeltas, totalsByMint } from '../src/index.js';

const QUOTE = 'QuoteMint11111111111111111111111111111111111';
const CROSS = 'Cross1111111111111111111111111111111111111111';
const PROTOCOL = 'Protocol11111111111111111111111111111111111';
const INTEGRATOR = 'Integrator1111111111111111111111111111111111';
const ISSUER = 'Issuer111111111111111111111111111111111111111';

const facts: CrossFeeFacts = {
  cross: CROSS, creator: ISSUER, kind: 'launch', supplyMode: 'mint', quoteMint: QUOTE, protocolBps: 5, integratorBps: 20,
  integrator: INTEGRATOR, feeRecipient: PROTOCOL, proceedsTo: ISSUER, buyerPaid: 2_400_000_000n, feesAccrued: 0n,
};
const recorded: RecordedFinalize = { signature: 'sig', slot: 1, blockTime: 1_791_255_908, protocolFee: 1_200_000n, integratorFee: 4_800_000n, proceedsQuote: 2_394_000_047n };
const bal = (owner: string, amount: bigint, accountIndex: number) => ({ accountIndex, mint: QUOTE, owner, uiTokenAmount: { amount: amount.toString() } });

// The vault held 2,400,000,047 (buyers' payments plus the 47-atom dust bond) and was emptied into three places.
const tx = {
  err: null,
  preTokenBalances: [bal(CROSS, 2_400_000_047n, 1), bal(PROTOCOL, 10n, 2), bal(INTEGRATOR, 20n, 3), bal(ISSUER, 30n, 4)],
  postTokenBalances: [bal(CROSS, 0n, 1), bal(PROTOCOL, 1_200_010n, 2), bal(INTEGRATOR, 4_800_020n, 3), bal(ISSUER, 2_394_000_077n, 4)],
};

describe('ownerDeltas', () => {
  it('sums an owner across token accounts and ignores other mints', () => {
    const d = ownerDeltas(
      { err: null, preTokenBalances: [bal('A', 5n, 1), { ...bal('A', 7n, 2), mint: 'Other' }], postTokenBalances: [bal('A', 9n, 1), { ...bal('A', 70n, 2), mint: 'Other' }, bal('A', 1n, 3)] },
      QUOTE,
    );
    expect(d.get('A')).toBe(5n);
  });
});

describe('finalize transfers', () => {
  it('match when each owner gained exactly its share and the vault lost the sum', () => {
    const c = checkFinalizeTransfers(tx, { quoteMint: QUOTE, cross: CROSS, feeRecipient: PROTOCOL, integrator: INTEGRATOR, proceedsTo: ISSUER, protocolFee: 1_200_000n, integratorFee: 4_800_000n, proceedsQuote: 2_394_000_047n });
    expect(c.ok).toBe(true);
  });

  it('aggregate roles that share one wallet', () => {
    // One wallet is issuer, integrator and fee recipient: it receives all three amounts.
    const all = 'Everyone11111111111111111111111111111111111';
    const t = { err: null, preTokenBalances: [bal(CROSS, 100n, 1), bal(all, 0n, 2)], postTokenBalances: [bal(CROSS, 0n, 1), bal(all, 100n, 2)] };
    expect(checkFinalizeTransfers(t, { quoteMint: QUOTE, cross: CROSS, feeRecipient: all, integrator: all, proceedsTo: all, protocolFee: 10n, integratorFee: 30n, proceedsQuote: 60n }).ok).toBe(true);
  });

  it('catch an integrator paid one atom short and say who', () => {
    const short = { ...tx, postTokenBalances: tx.postTokenBalances.map((b) => (b.owner === INTEGRATOR ? bal(INTEGRATOR, 4_800_019n, 3) : b)) };
    const c = checkFinalizeTransfers(short, { quoteMint: QUOTE, cross: CROSS, feeRecipient: PROTOCOL, integrator: INTEGRATOR, proceedsTo: ISSUER, protocolFee: 1_200_000n, integratorFee: 4_800_000n, proceedsQuote: 2_394_000_047n });
    expect(c.ok).toBe(false);
    if (!c.ok) expect(c.reason).toContain(INTEGRATOR);
  });

  it('refuse a failed transaction', () => {
    const c = checkFinalizeTransfers({ ...tx, err: { InstructionError: [0, 'Custom'] } }, { quoteMint: QUOTE, cross: CROSS, feeRecipient: PROTOCOL, integrator: INTEGRATOR, proceedsTo: ISSUER, protocolFee: 1_200_000n, integratorFee: 4_800_000n, proceedsQuote: 2_394_000_047n });
    expect(c.ok).toBe(false);
  });
});

describe('ledger entries', () => {
  it('MATCH when counters, event and chain agree', () => {
    const e = ledgerEntry(facts, recorded, tx);
    expect(e.verdict).toBe('MATCH');
    expect(e.expected).toEqual({ total: 6_000_000n, protocol: 1_200_000n, integrator: 4_800_000n });
  });

  it('UNVERIFIED, not MATCH, when the transaction could not be fetched', () => {
    expect(ledgerEntry(facts, recorded, null).verdict).toBe('UNVERIFIED');
  });

  it('MISMATCH when the event disagrees with the fee rules, with the reason', () => {
    const e = ledgerEntry(facts, { ...recorded, protocolFee: 1_200_001n, integratorFee: 4_799_999n }, null);
    expect(e.verdict).toBe('MISMATCH');
    expect(e.reasons.join(' ')).toMatch(/protocol fee: the cross's counters give 1200000, the event recorded 1200001/);
  });

  it('totals count only MATCH entries and report the rest apart', () => {
    const good = ledgerEntry(facts, recorded, tx);
    const bad = ledgerEntry(facts, { ...recorded, protocolFee: 7n }, tx);
    const unknown = ledgerEntry(facts, recorded, null);
    const t = totalsByMint([good, bad, unknown]);
    expect(t.verified[QUOTE]).toEqual({ protocolFee: 1_200_000n, integratorFee: 4_800_000n, referralFee: 0n, crosses: 1 });
    expect(t.mismatched).toBe(1);
    expect(t.unverified).toBe(1);
  });
});
