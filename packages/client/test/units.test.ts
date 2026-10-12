import { describe, expect, it } from 'vitest';
import { costCeil } from '@opening-cross/sdk';
import { type Market, buyerPays, feeOf, formatAtoms, formatDuration, formatPrice, formatSol, parseAtoms, parsePrice, sellerReceives, shortAddress } from '../src/index.js';

// A market where 1 base token (9 decimals) trades for quote tokens (6 decimals); price units are quote atoms per 10^9 base atoms.
const M: Market = { priceScale: 1_000_000_000n, baseDecimals: 9, quoteDecimals: 6 };

describe('atoms', () => {
  it('formats and parses exactly, with and without thousands separators', () => {
    expect(formatAtoms(1_234_567_890n, 6)).toBe('1,234.56789');
    expect(formatAtoms(0n, 6)).toBe('0');
    expect(formatAtoms(5n, 6)).toBe('0.000005');
    expect(formatAtoms(-1_500_000n, 6)).toBe('-1.5');
    expect(parseAtoms('1,234.56789', 6)).toBe(1_234_567_890n);
    expect(parseAtoms(' 7 ', 0)).toBe(7n);
    expect(parseAtoms('0.', 6)).toBe(0n);
  });

  it('refuses anything that would round or is not a plain non-negative decimal', () => {
    for (const bad of ['', ' ', '-1', '+1', '1e3', '0x10', '1.2.3', '.5', 'abc', '1,2,3.4x', '0.0000001']) expect(parseAtoms(bad, 6), bad).toBeNull();
  });

  it('round-trips random amounts at every decimal count', () => {
    let seed = 0x9e3779b9;
    const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
    for (let n = 0; n < 500; n++) {
      const decimals = next() % 10;
      const atoms = (BigInt(next()) << 20n) ^ BigInt(next());
      expect(parseAtoms(formatAtoms(atoms, decimals), decimals)).toBe(atoms);
    }
  });
});

describe('prices', () => {
  it('shows a cross price as quote tokens per base token and parses it back', () => {
    expect(formatPrice(1_200_000n, M)).toBe('1.2');
    expect(parsePrice('1.2', M)).toBe(1_200_000n);
    expect(parsePrice('0.000001', M)).toBe(1n);
  });

  it('rejects a price the grid unit cannot represent exactly', () => {
    const coarse: Market = { priceScale: 1_000_000n, baseDecimals: 6, quoteDecimals: 9 };
    expect(parsePrice('1.0000000001', coarse)).toBeNull();
    expect(parsePrice('1.5', { priceScale: 1n, baseDecimals: 2, quoteDecimals: 0 })).toBeNull();
  });

  it('charges buyers by rounding up and pays sellers by rounding down, as the program does', () => {
    expect(buyerPays(3n, 10n, 4n)).toBe(8n);
    expect(sellerReceives(3n, 10n, 4n)).toBe(7n);
    expect(buyerPays(4n, 10n, 4n)).toBe(10n);
    expect(feeOf(9_999n, 100)).toBe(99n);
  });

  it('agrees with the SDK on the buyer cost over random inputs', () => {
    let seed = 7;
    const next = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0);
    for (let n = 0; n < 500; n++) {
      const q = BigInt(next()) * 1000n + BigInt(next() % 1000);
      const p = BigInt(next() % 5_000_000) + 1n;
      const scale = BigInt(1 + (next() % 1_000_000_000));
      expect(buyerPays(q, p, scale)).toBe(costCeil(q, p, scale));
    }
  });
});

describe('display helpers', () => {
  it('formats durations, SOL and addresses', () => {
    expect(formatDuration(0n)).toBe('0m 00s');
    expect(formatDuration(3_725n)).toBe('1h 02m 05s');
    expect(formatDuration(90_061n)).toBe('1d 1h 01m');
    expect(formatDuration(-5n)).toBe('0m 00s');
    // Rounds up: an amount a person must have is never understated.
    expect(formatSol(1_000_000_001n)).toBe('1.0001 SOL');
    expect(formatSol(0n)).toBe('0 SOL');
    expect(shortAddress('F5k8EDDXBF24xgt4Y8MMtwPZFH9TikJvJcNmD1NJQPnZ')).toBe('F5k8…QPnZ');
    expect(shortAddress('abc')).toBe('abc');
  });
});
