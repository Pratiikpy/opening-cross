// The independent TypeScript implementation of the v2 rules must reproduce every vector that
// clearing-core generated, and the runner must catch an implementation wrong in one field.
import { describe, expect, it } from 'vitest';
import { type Implementation2, loadVectors2, referenceImplementation2, runConformance2 } from '../src/index.js';

describe('conformance v2', () => {
  const vectors = loadVectors2();

  it('covers every rule it claims to cover', () => {
    expect(vectors.cases.length).toBeGreaterThanOrEqual(400);
    for (const reason of ['BelowMinimumRaise', 'FloatTooLow', 'FdvTooHigh', 'PriceMoved', 'BelowMinimumVolume']) {
      expect(vectors.cases.some((c) => !c.expect.printed && c.expect.noPrintReason === reason), reason).toBe(true);
    }
    expect(vectors.cases.some((c) => c.rules.supplyCap !== null && c.expect.printed)).toBe(true);
    expect(vectors.cases.some((c) => c.rules.lotteryUnit !== '0' && c.expect.printed && c.expect.rationed === 'buy')).toBe(true);
    expect(vectors.cases.some((c) => c.orders.some((o) => o.insider) && c.expect.printed && c.expect.insiderUpperBound !== '0')).toBe(true);
    expect(vectors.cases.filter((c) => c.expect.printed).length).toBeGreaterThan(100);
  });

  it('the reference implementation is conformant', () => {
    expect(runConformance2(vectors, referenceImplementation2)).toEqual([]);
  });

  it('a single wrong fill is reported', () => {
    const target = vectors.cases.find((c) => c.expect.printed && c.rules.reserveBps.some((b) => b > 0) && c.expect.rationed === 'buy')!;
    const offByOne: Implementation2 = (c) => {
      const r = referenceImplementation2(c);
      if (c.name !== target.name || !r.printed) return r;
      return { ...r, fills: r.fills.map((f, i) => (i === 0 ? (BigInt(f) + 1n).toString() : f)) };
    };
    expect(runConformance2(vectors, offByOne).map((f) => f.name)).toEqual([target.name]);
  });

  it('every printed case conserves volume: buys never exceed the matched volume', () => {
    for (const c of vectors.cases) {
      if (!c.expect.printed) continue;
      const bought = c.orders.reduce((a, o, i) => (o.side === 'buy' ? a + BigInt(c.expect.printed ? c.expect.fills[i]! : 0) : a), 0n);
      expect(bought <= BigInt(c.expect.matched), c.name).toBe(true);
    }
  });

  it('a throwing implementation fails every case instead of crashing the run', () => {
    expect(runConformance2(vectors, () => { throw new Error('boom'); })).toHaveLength(vectors.cases.length);
  });
});
