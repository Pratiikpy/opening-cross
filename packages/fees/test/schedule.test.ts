// The fee rules, one at a time and then together. Expected numbers are derived by hand from ADR-0010 and the
// program source, not computed with the code under test.
import { describe, expect, it } from 'vitest';
import {
  FeeError,
  KINDS,
  MAX_INTEGRATOR_FEE_BPS,
  PROPOSED_SCHEDULE,
  expectedFinalizeFees,
  mulBps,
  protocolFeeBps,
  sellerFee,
  splitFees,
  totalFeeBps,
} from '../src/index.js';

describe('protocol fee snapshot', () => {
  it('is the schedule entry, capped at a quarter of the integrator fee', () => {
    // launch schedule is 30 bps. 120 / 4 = 30: the cap equals the schedule. 119 / 4 = 29 (integer division).
    expect(protocolFeeBps(PROPOSED_SCHEDULE, 'launch', 120)).toBe(30);
    expect(protocolFeeBps(PROPOSED_SCHEDULE, 'launch', 119)).toBe(29);
    expect(protocolFeeBps(PROPOSED_SCHEDULE, 'launch', 300)).toBe(30);
    // reopen schedule is 5 bps: cap binds below 20 bps of integrator fee.
    expect(protocolFeeBps(PROPOSED_SCHEDULE, 'reopen', 20)).toBe(5);
    expect(protocolFeeBps(PROPOSED_SCHEDULE, 'reopen', 19)).toBe(4);
    expect(protocolFeeBps(PROPOSED_SCHEDULE, 'reopen', 12)).toBe(3);
    expect(protocolFeeBps(PROPOSED_SCHEDULE, 'tender', 60)).toBe(15);
    expect(protocolFeeBps(PROPOSED_SCHEDULE, 'recurring', MAX_INTEGRATOR_FEE_BPS)).toBe(30);
  });

  it('is zero without an integrator fee, so the public-good tier pays nothing', () => {
    for (const k of KINDS) expect(protocolFeeBps(PROPOSED_SCHEDULE, k, 0)).toBe(0);
    for (const k of KINDS) expect(protocolFeeBps(PROPOSED_SCHEDULE, k, 3)).toBe(0);
  });

  it('never takes more than a fifth of the total fee (ADR-0010: p <= 0.2 (p + i))', () => {
    for (const k of KINDS) {
      for (let i = 0; i <= MAX_INTEGRATOR_FEE_BPS; i++) {
        const p = protocolFeeBps(PROPOSED_SCHEDULE, k, i);
        expect(p * 5).toBeLessThanOrEqual(p + i);
      }
    }
  });

  it('refuses a schedule or an integrator fee the program would refuse', () => {
    expect(() => protocolFeeBps(PROPOSED_SCHEDULE, 'launch', 301)).toThrow(FeeError);
    expect(() => protocolFeeBps([101, 5, 15, 30], 'launch', 100)).toThrow(FeeError);
    expect(() => protocolFeeBps([30, 5, 15] as never, 'launch', 100)).toThrow(FeeError);
    expect(() => protocolFeeBps(PROPOSED_SCHEDULE, 'launch', 1.5)).toThrow(FeeError);
  });
});

describe('amounts', () => {
  it('mulBps floors', () => {
    expect(mulBps(10_000n, 30)).toBe(30n);
    expect(mulBps(333n, 30)).toBe(0n); // 9.99
    expect(mulBps(334n, 30)).toBe(1n); // 10.02
    expect(mulBps(2_394_000_047n * 25n, 1)).toBe(5_985_000n + 0n); // exact: floor(59_850_001_175 / 10_000) = 5_985_000
  });

  it('refuses amounts the program could not hold', () => {
    expect(() => mulBps(-1n, 30)).toThrow(FeeError);
    expect(() => mulBps(1n << 64n, 30)).toThrow(FeeError);
  });

  it('splits so the integrator gets the remainder and nothing is lost', () => {
    for (const total of [0n, 1n, 7n, 6_000_000n, 123_456_789n]) {
      for (const [p, i] of [[5, 20], [30, 120], [0, 0], [0, 50], [4, 16], [3, 12]] as const) {
        const s = splitFees(total, p, i);
        expect(s.protocol + s.integrator).toBe(total);
        expect(s.protocol).toBe(p + i === 0 ? 0n : (total * BigInt(p)) / BigInt(p + i));
      }
    }
  });

  it('a seller pays total bps of the gross, floored', () => {
    expect(sellerFee(1_000_000n, 5, 20)).toBe(2_500n);
    expect(sellerFee(399n, 5, 20)).toBe(0n); // 0.9975
    expect(sellerFee(400n, 5, 20)).toBe(1n);
    expect(totalFeeBps(5, 20)).toBe(25);
  });
});

describe('what finalize pays', () => {
  it('mint mode charges the total on what buyers paid', () => {
    // Real figures: devnet cross ps6kAXQF... paid 1,200,000 + 4,800,000 at 5 + 20 bps. That is 25 bps of 2,400,000,000.
    const f = expectedFinalizeFees({ supplyMode: 'mint', protocolBps: 5, integratorBps: 20, buyerPaid: 2_400_000_000n, feesAccrued: 0n });
    expect(f).toEqual({ total: 6_000_000n, protocol: 1_200_000n, integrator: 4_800_000n });
  });

  it('deferred mint behaves like mint', () => {
    const f = expectedFinalizeFees({ supplyMode: 'deferred-mint', protocolBps: 5, integratorBps: 20, buyerPaid: 3_750_000_000n, feesAccrued: 0n });
    expect(f).toEqual({ total: 9_375_000n, protocol: 1_875_000n, integrator: 7_500_000n });
  });

  it('escrow mode pays out what the sellers accrued, whatever buyers paid', () => {
    const f = expectedFinalizeFees({ supplyMode: 'escrow', protocolBps: 5, integratorBps: 20, buyerPaid: 999n, feesAccrued: 5_000n });
    expect(f).toEqual({ total: 5_000n, protocol: 1_000n, integrator: 4_000n });
  });

  it('a cross with no fee configured pays no fee in any mode', () => {
    for (const supplyMode of ['escrow', 'mint', 'deferred-mint'] as const) {
      expect(expectedFinalizeFees({ supplyMode, protocolBps: 0, integratorBps: 0, buyerPaid: 5_000_000n, feesAccrued: 0n })).toEqual({ total: 0n, protocol: 0n, integrator: 0n });
    }
  });
});
