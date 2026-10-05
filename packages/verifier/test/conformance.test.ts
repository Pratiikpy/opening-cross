// The independent TypeScript reference must reproduce every vector clearing-core generated, and
// the runner must catch an implementation that is wrong in a single field of a single case.
import { describe, expect, it } from 'vitest';
import { type Implementation, loadVectors, referenceImplementation, runConformance } from '../src/index.js';

describe('conformance v1', () => {
  const vectors = loadVectors();

  it('covers curated edge cases and a large random set', () => {
    expect(vectors.cases.length).toBeGreaterThanOrEqual(500);
    expect(vectors.cases.filter((c) => c.expect.printed).length).toBeGreaterThan(100);
    for (const reason of ['NoCross', 'BelowMinimumVolume', 'ImbalanceTooHigh']) {
      expect(vectors.cases.some((c) => !c.expect.printed && c.expect.noPrintReason === reason)).toBe(true);
    }
  });

  it('the reference implementation is conformant', () => {
    expect(runConformance(vectors, referenceImplementation)).toEqual([]);
  });

  it('a single wrong fill is reported', () => {
    const target = vectors.cases.find((c) => c.expect.printed && c.expect.rationed !== 'none')!;
    const offByOne: Implementation = (c) => {
      const r = referenceImplementation(c);
      if (c.name !== target.name || !r.printed) return r;
      return { ...r, fills: r.fills.map((f, i) => (i === 0 ? (BigInt(f) + 1n).toString() : f)) };
    };
    expect(runConformance(vectors, offByOne).map((f) => f.name)).toEqual([target.name]);
  });

  it('a throwing implementation fails every case instead of crashing the run', () => {
    expect(runConformance(vectors, () => { throw new Error('boom'); })).toHaveLength(vectors.cases.length);
  });
});
