import { describe, expect, it } from 'vitest';
import { depthAtSlippage, persistence, quoteOut, slippageBps } from '../src/index.js';

const r = { reserveIn: 5_000_000_000n, reserveOut: 6_000_000_000n };

describe('constant-product health', () => {
  it('quotes the same output the DAMM v2 devnet-style swap test expects (no fee, small trade)', () => {
    // 10 base into 5,000 base / 6,000 quote: 10 * 6000 / 5010 = 11.976...
    expect(quoteOut({ reserveIn: 5_000_000_000n, reserveOut: 6_000_000_000n }, 10_000_000n, 0)).toBe(11_976_047n);
  });

  it('slippage is monotone in size and never negative', () => {
    let prev = 0n;
    // Below a few thousand atoms integer rounding dominates, so the property is checked from a meaningful size up.
    for (const size of [0n, 1_000_000n, 100_000_000n, 1_000_000_000n, 5_000_000_000n, 50_000_000_000n]) {
      const s = slippageBps(r, size, 30);
      expect(s >= prev).toBe(true);
      expect(s <= 10_000n).toBe(true);
      prev = s;
    }
  });

  it('depth at a slippage is the largest size within it, for several pools and fees', () => {
    for (const reserves of [r, { reserveIn: 7n * 10n ** 12n, reserveOut: 3n * 10n ** 9n }, { reserveIn: 10n ** 9n, reserveOut: 10n ** 9n }]) {
      for (const fee of [0, 30, 300]) {
        for (const max of [50n, 100n, 500n, 2_000n]) {
          const d = depthAtSlippage(reserves, max, fee);
          if (d > 0n) expect(slippageBps(reserves, d, fee) <= max).toBe(true);
          expect(slippageBps(reserves, d + 1n, fee) > max || fee * 1n > Number(max)).toBe(true);
        }
      }
    }
  });

  it('a fee larger than the allowed slippage leaves no depth', () => {
    expect(depthAtSlippage({ reserveIn: 1_000n, reserveOut: 1_000n }, 10n, 300)).toBe(0n);
  });

  it('persistence weighs each snapshot by the time until the next', () => {
    const deep = { reserveA: 5_000_000_000n, reserveB: 6_000_000_000n };
    const thin = { reserveA: 10_000_000n, reserveB: 12_000_000n };
    const snaps = [
      { timestamp: 0, ...deep },
      { timestamp: 600, ...thin },
      { timestamp: 1_000, ...deep },
      { timestamp: 2_000, ...deep },
    ];
    // A sale of 20,000,000 atoms within 100 bps: only the deep pool absorbs it, for 600 + 1000 of the 2000 observed seconds.
    expect(persistence(snaps, 20_000_000n, 100n, 30)).toBeCloseTo((600 + 1_000) / 2_000, 6);
    expect(persistence([snaps[0]!], 1n, 100n, 30)).toBe(0);
    expect(() => persistence([snaps[1]!, snaps[0]!], 1n, 100n, 30)).toThrow();
  });

  it('rejects empty pools and bad fees', () => {
    expect(() => quoteOut({ reserveIn: 0n, reserveOut: 1n }, 1n, 30)).toThrow();
    expect(() => quoteOut(r, 1n, 10_000)).toThrow();
  });
});
