import { describe, expect, it } from 'vitest';
import { metLockSchedule, metLockVested } from '../src/index.js';


describe('metLockSchedule', () => {
  it('always sums to the total with nothing left over, for awkward totals and period counts', () => {
    for (const total of [1n, 7n, 999n, 1_000_000_007n, 18_446_744_073_709_551_615n]) {
      for (const periods of [1n, 3n, 7n, 12n, 1000n]) {
        for (const bps of [0, 1, 1000, 3333, 10_000]) {
          const s = metLockSchedule({ total, start: 0n, cliffSeconds: 10n, frequency: 5n, periods, cliffUnlockBps: bps });
          expect(s.cliffUnlockAmount + s.amountPerPeriod * s.numberOfPeriod).toBe(total);
          expect(metLockVested(s, 10n + 5n * periods + 99n)).toBe(total);
          expect(metLockVested(s, 9n)).toBe(0n);
        }
      }
    }
  });
  it('rejects nonsense', () => {
    expect(() => metLockSchedule({ total: 0n, start: 0n, cliffSeconds: 0n, frequency: 1n, periods: 1n })).toThrow();
    expect(() => metLockSchedule({ total: 1n, start: 0n, cliffSeconds: -1n, frequency: 1n, periods: 1n })).toThrow();
    expect(() => metLockSchedule({ total: 1n, start: 0n, cliffSeconds: 0n, frequency: 0n, periods: 3n })).toThrow();
    expect(() => metLockSchedule({ total: 1n, start: 0n, cliffSeconds: 0n, frequency: 1n, periods: 1n, cliffUnlockBps: 10_001 })).toThrow();
  });
});

