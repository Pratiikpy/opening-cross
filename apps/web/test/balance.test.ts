import { describe, expect, it } from 'vitest';
import { shortfall } from '../src/lib/balance';

describe('shortfall', () => {
  it('is zero when the wallet can fund the order or the balance is unknown', () => {
    expect(shortfall(780n, 780n)).toBe(0n);
    expect(shortfall(1_000n, 780n)).toBe(0n);
    expect(shortfall(null, 780n)).toBe(0n);
  });
  it('is the missing amount otherwise', () => {
    expect(shortfall(440n, 780n)).toBe(340n);
    expect(shortfall(0n, 1n)).toBe(1n);
  });
});
