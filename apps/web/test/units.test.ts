import { describe, expect, it } from 'vitest';
import { buyerPays, formatAtoms, formatDuration, formatPrice, parseAtoms, parsePrice } from '../src/lib/units';

const M = { priceScale: 1_000_000n, baseDecimals: 6, quoteDecimals: 6 };

describe('units', () => {
  it('formats and parses atoms exactly', () => {
    expect(formatAtoms(1_234_567_890n, 6)).toBe('1,234.56789');
    expect(formatAtoms(5n, 6)).toBe('0.000005');
    expect(formatAtoms(0n, 6)).toBe('0');
    expect(parseAtoms('1,234.56789', 6)).toBe(1_234_567_890n);
    expect(parseAtoms('0.0000001', 6)).toBeNull(); // more precise than the mint
    expect(parseAtoms('-1', 6)).toBeNull();
    expect(parseAtoms('1e3', 6)).toBeNull();
    expect(parseAtoms('', 6)).toBeNull();
    expect(parseAtoms('12.', 6)).toBe(12_000_000n);
  });

  it('converts prices between chain units and per-token display', () => {
    expect(formatPrice(1_200_000n, M)).toBe('1.2');
    expect(parsePrice('1.18', M)).toBe(1_180_000n);
    // 9-decimal base, 6-decimal quote, scale 1e9: 1.5 quote per token.
    const N = { priceScale: 1_000_000_000n, baseDecimals: 9, quoteDecimals: 6 };
    expect(formatPrice(1_500_000n, N)).toBe('1.5');
    expect(parsePrice('1.5', N)).toBe(1_500_000n);
    // A scale that cannot represent the typed price exactly is refused, not rounded.
    expect(parsePrice('0.000001', { priceScale: 3n, baseDecimals: 0, quoteDecimals: 6 })).toBe(3n);
    expect(parsePrice('0.000001', { priceScale: 1n, baseDecimals: 1, quoteDecimals: 6 })).toBeNull();
  });

  it('charges buyers the ceiling, like the program', () => {
    expect(buyerPays(3n, 1n, 2n)).toBe(2n);
    expect(buyerPays(1_000_000_000n, 1_200_000n, 1_000_000n)).toBe(1_200_000_000n);
  });

  it('formats countdowns', () => {
    expect(formatDuration(8042n)).toBe('2h 14m 02s');
    expect(formatDuration(59n)).toBe('0m 59s');
    expect(formatDuration(90061n)).toBe('1d 1h 01m');
    expect(formatDuration(-5n)).toBe('0m 00s');
  });
});
