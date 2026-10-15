import { describe, expect, it } from 'vitest';
import { amount, bpsText, feePercent, depthSteps, explorerAddress, ladderBars, minimumOutOf, movedText, priceText, shareText, statusText } from './format';

describe('basis points', () => {
  it('reads as a percent, keeping two places only when they matter', () => {
    expect(bpsText('10')).toBe('0.10%');
    expect(bpsText(100n)).toBe('1%');
    expect(bpsText(1000)).toBe('10%');
    expect(bpsText('5')).toBe('0.05%');
    expect(bpsText('0')).toBe('0%');
    expect(bpsText(null)).toBe('not read');
  });
  it('a move carries its sign and says unchanged for zero', () => {
    expect(movedText('70')).toBe('+0.70%');
    expect(movedText('-5')).toBe('-0.05%');
    expect(movedText('0')).toBe('unchanged');
    expect(movedText(null)).toBe('not read');
  });
});

describe('amounts and prices', () => {
  it('formats atoms exactly and never turns a missing value into zero', () => {
    expect(amount('1234500', 6)).toBe('1.2345');
    expect(amount('905000000', 6)).toBe('905');
    expect(amount('1', 9)).toBe('0'); // below the digits worth showing: the table shows the exact atoms in its title
    expect(amount(null, 6)).toBe('not read');
    expect(amount('123456789012345678901234567890', 9)).toBe('123,456,789,012,345,678,901.234567');
  });
  it('trims a decimal price', () => {
    expect(priceText('1.299356428')).toBe('1.299356');
    expect(priceText('2')).toBe('2');
    expect(priceText('0.500000000')).toBe('0.5');
  });
  it('writes a share as a percent', () => {
    expect(shareText(0.8)).toBe('80.0%');
    expect(shareText(1)).toBe('100.0%');
  });
});

describe('fees', () => {
  it('a fee in basis points reads as a percent, fractions included', () => {
    expect(feePercent(10)).toBe('0.1%');
    expect(feePercent(30)).toBe('0.3%');
    expect(feePercent(0.5)).toBe('0.005%');
    expect(feePercent(100)).toBe('1%');
  });
});

describe('minimum output', () => {
  it('is the quote less the tolerance, rounded up, as the API computes it', () => {
    expect(minimumOutOf(1_000_000n, 50)).toBe(995_000n);
    expect(minimumOutOf(1_000n, 1)).toBe(1_000n);
    expect(minimumOutOf(6_490_285n, 100)).toBe(6_425_383n); // 6,490,285 x 0.99 = 6,425,382.15, rounded up
    expect(minimumOutOf(7n, 10_000)).toBe(0n);
  });
});

describe('status and links', () => {
  it('says when a pool opens, or why it cannot trade', () => {
    expect(statusText({ open: true, reason: null, opensAtPoint: null, pointUnit: 'timestamp' })).toBe('Open for swaps');
    expect(statusText({ open: false, reason: 'the pair opens at timestamp 1800000000', opensAtPoint: '1800000000', pointUnit: 'timestamp' })).toBe('Opens 2027-01-15 08:00 UTC');
    expect(statusText({ open: false, reason: 'the pool is disabled', opensAtPoint: null, pointUnit: 'slot' })).toBe('Closed: the pool is disabled');
    expect(statusText({ open: false, reason: null, opensAtPoint: null, pointUnit: 'slot' })).toBe('Closed');
  });
  it('links an address on the right cluster', () => {
    expect(explorerAddress('abc', 'devnet')).toBe('https://explorer.solana.com/address/abc?cluster=devnet');
    expect(explorerAddress('abc', 'mainnet-beta')).toBe('https://explorer.solana.com/address/abc');
  });
});

describe('ladder bars', () => {
  const Q = 1n << 64n;
  it('values asks in quote at the bin price and scales to the tallest', () => {
    const bars = ladderBars([
      { binId: 1, role: 'bid', priceQ64: Q, amountX: 0n, amountY: 400n },
      { binId: 2, role: 'active', priceQ64: Q, amountX: 100n, amountY: 100n },
      { binId: 3, role: 'ask', priceQ64: 2n * Q, amountX: 300n, amountY: 0n },
    ]);
    expect(bars.map((b) => b.value)).toEqual([400n, 200n, 600n]);
    expect(bars.map((b) => b.share)).toEqual([0.6666, 0.3333, 1]); // truncated to four places, never rounded up past the tallest
  });
  it('an empty ladder has no height rather than a division by zero', () => {
    expect(ladderBars([{ binId: 1, role: 'ask', priceQ64: Q, amountX: 0n, amountY: 0n }])[0]!.share).toBe(0);
    expect(ladderBars([])).toEqual([]);
  });
});

describe('depth steps', () => {
  it('places each level across the price range and scales both sides to the larger', () => {
    const steps = depthSteps([
      { price: 100n, cumulativeBuy: 1500n, cumulativeSell: 800n },
      { price: 150n, cumulativeBuy: 1000n, cumulativeSell: 1700n },
      { price: 200n, cumulativeBuy: 1000n, cumulativeSell: 1700n },
    ]);
    expect(steps.map((s) => s.x)).toEqual([0, 0.5, 1]);
    expect(steps[0]!.buy).toBeCloseTo(1500 / 1700, 3);
    expect(steps[0]!.sell).toBeCloseTo(800 / 1700, 3);
    expect(steps[1]!.buy).toBeCloseTo(1000 / 1700, 3);
    expect(steps[1]!.sell).toBe(1);
  });
  it('one level sits in the middle, and none gives nothing', () => {
    expect(depthSteps([{ price: 5n, cumulativeBuy: 10n, cumulativeSell: 0n }])[0]!.x).toBe(0.5);
    expect(depthSteps([])).toEqual([]);
  });
});
