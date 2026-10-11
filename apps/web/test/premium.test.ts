import { describe, expect, it } from 'vitest';
import { percentOf, usdOf } from '../src/lib/premium';

describe('premium formatting', () => {
  it('shows basis points x 100 as a signed percent with two decimals', () => {
    expect(percentOf('4386')).toBe('0.44%');
    expect(percentOf('-50000')).toBe('-5.00%');
    expect(percentOf('0')).toBe('0.00%');
    expect(percentOf('-3')).toBe('0.00%');
    expect(percentOf('1234567')).toBe('123.46%');
    expect(percentOf(null)).toBe('—');
  });

  it('shows micro-USD as dollars and cents', () => {
    expect(usdOf('382_970_000'.replace(/_/g, ''))).toBe('$382.97');
    expect(usdOf('1234567890')).toBe('$1,234.57');
    expect(usdOf('4999')).toBe('$0.00');
    expect(usdOf('5000')).toBe('$0.01');
    expect(usdOf(null)).toBe('—');
  });
});
