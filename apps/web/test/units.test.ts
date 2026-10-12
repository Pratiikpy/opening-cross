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

describe('units at the edges', () => {
  it('formats the largest on-chain amount and very small ones without rounding', () => {
    expect(formatAtoms(18_446_744_073_709_551_615n, 9)).toBe('18,446,744,073.709551615');
    expect(formatAtoms(18_446_744_073_709_551_615n, 0)).toBe('18,446,744,073,709,551,615');
    expect(formatAtoms(1n, 18)).toBe('0.000000000000000001');
    expect(parseAtoms('18,446,744,073.709551615', 9)).toBe(18_446_744_073_709_551_615n);
  });

  it('trims digits only when asked to, and never turns a small nonzero amount into a bare zero by accident', () => {
    expect(formatAtoms(1_234_567n, 6, 2)).toBe('1.23');
    expect(formatAtoms(1_000_000_000n, 6, 2)).toBe('1,000');
  });

  it('refuses malformed and ambiguous input', () => {
    for (const bad of ['1.2.3', '.', ' ', '1 000', '１２', '0x10', '1,,2e', 'NaN', 'Infinity']) expect(parseAtoms(bad, 6)).toBeNull();
    expect(parseAtoms('  1.5  ', 6)).toBe(1_500_000n);
  });

  it('keeps a price exact for a 9-decimal base against a 6-decimal quote at a large scale', () => {
    const N = { priceScale: 1_000_000_000n, baseDecimals: 9, quoteDecimals: 6 };
    expect(formatPrice(999_999_999_999n, N)).toBe('999,999.999999');
    expect(parsePrice('999999.999999', N)).toBe(999_999_999_999n);
  });
});
