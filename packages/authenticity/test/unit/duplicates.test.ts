import { describe, expect, it } from 'vitest';
import { duplicateSummary, editDistance, findDuplicates } from '../../src/index.js';

const T = (mint: string, symbol: string | null, name: string | null, source = 'cross') => ({ mint, symbol, name, source });

describe('findDuplicates', () => {
  const known = [
    T('M1', 'MOON', 'Moon Coin'),
    T('M2', 'SOLX', 'Sol Extra'),
    T('M3', 'PUMP', 'Pump It'),
    T('M4', 'ABC', 'Alpha Beta Charlie'),
    T('M5', null, null),
    T('M6', 'BONKERS', 'Bonkers'),
  ];

  it('flags the same ticker however it is cased or spaced', () => {
    const d = findDuplicates({ mint: 'NEW', symbol: 'moon', name: 'Another Moon' }, known);
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ mint: 'M1', relation: 'same-symbol', severity: 'high', why: 'both use the ticker "MOON"' });
  });

  it('flags a ticker that only reads the same: Cyrillic letters, invisible characters, a zero for an O', () => {
    expect(findDuplicates({ mint: 'N', symbol: 'MООN', name: null }, known)[0]).toMatchObject({ mint: 'M1', relation: 'look-alike-symbol', severity: 'high' }); // Cyrillic О
    expect(findDuplicates({ mint: 'N', symbol: 'MO​ON', name: null }, known)[0]).toMatchObject({ mint: 'M1', relation: 'look-alike-symbol', severity: 'high' });
    expect(findDuplicates({ mint: 'N', symbol: 'M00N', name: null }, known)[0]).toMatchObject({ mint: 'M1', relation: 'look-alike-symbol', severity: 'medium' });
    expect(findDuplicates({ mint: 'N', symbol: 'MOON-', name: null }, known)[0]).toMatchObject({ relation: 'look-alike-symbol' }); // punctuation folded
  });

  it('flags a ticker one character away only when it is long enough to mean something', () => {
    expect(findDuplicates({ mint: 'N', symbol: 'BONKERZ', name: null }, known)[0]).toMatchObject({ mint: 'M6', relation: 'near-symbol', severity: 'low' });
    expect(findDuplicates({ mint: 'N', symbol: 'MOOM', name: null }, known)).toEqual([]); // four letters: one apart is common and proves nothing
    expect(findDuplicates({ mint: 'N', symbol: 'ABD', name: null }, known)).toEqual([]);
    expect(findDuplicates({ mint: 'N', symbol: 'BONKXXS', name: null }, known)).toEqual([]);
  });

  it('keeps the list short when a long list has many one-character neighbours', () => {
    const many = Array.from({ length: 12 }, (_, i) => T(`K${i}`, `TOKEN${String.fromCharCode(65 + i)}`, null));
    const d = findDuplicates({ mint: 'N', symbol: 'TOKENZ', name: null }, many);
    expect(d).toHaveLength(5);
    expect(d.every((x) => x.relation === 'near-symbol')).toBe(true);
  });

  it('flags the same name, ranks the worst first, and never matches a token with itself or a token without labels', () => {
    const d = findDuplicates({ mint: 'M2', symbol: 'PUMP', name: 'sol extra' }, known);
    expect(d.map((x) => [x.mint, x.relation])).toEqual([['M3', 'same-symbol']]); // M2 is itself
    const byName = findDuplicates({ mint: 'N', symbol: 'ZZZ1', name: 'Sol Extra!' }, known);
    expect(byName[0]).toMatchObject({ mint: 'M2', relation: 'same-name', severity: 'medium' });
    expect(findDuplicates({ mint: 'N', symbol: 'MOON', name: 'Sol Extra' }, known).map((x) => x.severity)).toEqual(['high', 'medium']);
    expect(findDuplicates({ mint: 'N', symbol: null, name: null }, known)).toEqual([]);
  });

  it('summarises', () => {
    expect(duplicateSummary([])).toEqual({ verdict: 'clear', worst: null, count: 0 });
    expect(duplicateSummary(findDuplicates({ mint: 'N', symbol: 'MOON', name: null }, known))).toEqual({ verdict: 'warn', worst: 'high', count: 1 });
  });

  it('computes a bounded edit distance', () => {
    expect(editDistance('moon', 'moon')).toBe(0);
    expect(editDistance('moon', 'moom')).toBe(1);
    expect(editDistance('moon', 'mon')).toBe(1);
    expect(editDistance('moon', 'zzzz', 1)).toBe(2);
    expect(editDistance('a', 'abcdef', 2)).toBe(3);
  });
});
