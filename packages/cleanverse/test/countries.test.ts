import { describe, expect, it } from 'vitest';
import { CLEANVERSE_ALPHA2, UnknownCountryError, alpha2ToNumeric, numericToAlpha2 } from '../src/countries.js';

describe('Cleanverse country codes', () => {
  it('lists the 194 codes of the reference appendix with no duplicates', () => {
    expect(CLEANVERSE_ALPHA2).toHaveLength(194);
    expect(new Set(CLEANVERSE_ALPHA2).size).toBe(194);
  });
  it('maps every code in the appendix to a numeric code and back', () => {
    const seen = new Set<number>();
    for (const a of CLEANVERSE_ALPHA2) {
      const n = alpha2ToNumeric(a);
      expect(n, a).toBeGreaterThan(0);
      expect(n, a).toBeLessThan(1000);
      expect(numericToAlpha2(n), a).toBe(a);
      expect(seen.has(n), `${a} collides`).toBe(false);
      seen.add(n);
    }
  });
  it('knows the codes the gate presets use', () => {
    expect([alpha2ToNumeric('IN'), alpha2ToNumeric('US'), alpha2ToNumeric('GB'), alpha2ToNumeric('AE'), alpha2ToNumeric('DE')]).toEqual([356, 840, 826, 784, 276]);
  });
  it('accepts lower case, as the API normalises to upper case', () => {
    expect(alpha2ToNumeric('in')).toBe(356);
  });
  it('refuses anything that is not a country', () => {
    for (const bad of ['', 'I', 'IND', 'ZZ', '12', 'I1', ' IN']) expect(() => alpha2ToNumeric(bad), bad).toThrow(UnknownCountryError);
  });
  it('has no alpha-2 for 0 (unknown)', () => {
    expect(numericToAlpha2(0)).toBeUndefined();
  });
});
