import { describe, expect, it } from 'vitest';
import { EMPTY_PROPOSAL, buildProposal, minHolding, payable, proposerStanding } from '../src/lib/holder-treasury-extra';

const A = '2E2aBsgDe255cqMZ7MWkyZx2qMEnMsU3ALuK8NWxKQrr';
const B = '6TLfAfu8dxF9YrTLuE4kgx3dapLNbkpsa8hcz36EhZHx';

describe('who may propose', () => {
  it('needs a holding of the minimum share of the supply, rounded down', () => {
    expect(minHolding(1_000_000_000n, 100)).toBe(10_000_000n);
    expect(minHolding(999n, 100)).toBe(9n);
  });
  it('lets the authority always, and a holder at or above the minimum', () => {
    expect(proposerStanding(0n, 1_000_000_000n, 100, true, 6)).toEqual({ ok: true });
    expect(proposerStanding(10_000_000n, 1_000_000_000n, 100, false, 6)).toEqual({ ok: true });
  });
  it('refuses a holder below the minimum, and a holder of nothing, with the figures', () => {
    const r = proposerStanding(9_999_999n, 1_000_000_000n, 100, false, 6);
    expect(r).toMatchObject({ ok: false, message: expect.stringMatching(/at least 10 coins \(1% of the supply\).*holds 9.999999/) });
    expect(proposerStanding(0n, 100n, 0, false, 6).ok).toBe(false);
  });
});

describe('buildProposal', () => {
  it('builds a spend with the amount in atoms', () => {
    const b = buildProposal({ ...EMPTY_PROPOSAL, amount: '250.5', destination: B, description: 'Audit' }, A, 6);
    expect(b).toEqual({ body: { proposer: A, kind: 'spend', amount: '250500000', destination: B }, errors: {} });
  });
  it('a NAV proposal carries neither an amount nor a destination', () => {
    const b = buildProposal({ ...EMPTY_PROPOSAL, kind: 'open-nav', amount: '5', destination: B, description: 'Open the wall' }, A, 6);
    expect(b.body).toEqual({ proposer: A, kind: 'open-nav' });
  });
  it('names every field it cannot read, and does not ask for a description to be skipped', () => {
    const b = buildProposal({ kind: 'spend', amount: '0', destination: 'x', description: ' ' }, A, 6);
    expect(Object.keys(b.errors).sort()).toEqual(['amount', 'description', 'destination']);
    expect(b.body).toBeNull();
    expect(buildProposal({ ...EMPTY_PROPOSAL, amount: '1.0000001', destination: B, description: 'x' }, A, 6).errors.amount).toMatch(/6 decimal places/);
    expect(buildProposal({ ...EMPTY_PROPOSAL, amount: '1', destination: B, description: 'x' }, A, null).errors.amount).toMatch(/decimals could not be read/);
  });
  it('builds nothing without a wallet', () => {
    expect(buildProposal({ ...EMPTY_PROPOSAL, amount: '1', destination: B, description: 'x' }, null, 6).body).toBeNull();
  });
});

describe('payable', () => {
  it('only a round that is over and inside its payment window', () => {
    expect(['open', 'awaiting-payment', 'late', 'paid', 'missed'].map((s) => payable(s as never))).toEqual([false, true, false, false, false]);
  });
});
