import { describe, expect, it } from 'vitest';
import { atoms, bps, interval, ofCount, plural, seconds, share } from '../src/components/metrics/format';

describe('metrics wording', () => {
  it('shows a count as "k of n" and adds a percentage only for large samples', () => {
    expect(ofCount(3, 5)).toBe('3 of 5');
    expect(ofCount(29, 29)).toBe('29 of 29');
    expect(ofCount(15, 30)).toBe('15 of 30 (50%)');
    expect(ofCount(0, 0)).toBe('none yet');
  });

  it('never turns missing data into a number', () => {
    expect(share(null)).toBe('no data');
    expect(bps(null)).toBe('no data');
    expect(seconds(null)).toBe('no data');
    expect(atoms(null, [6])).toBe('no data');
    expect(interval(null, null)).toBeNull();
  });

  it('formats shares, basis points, durations and atoms', () => {
    expect(share(0.415)).toBe('42%');
    expect(share(0.05)).toBe('5.0%');
    expect(share(0)).toBe('0%');
    expect(bps(1875)).toBe('1,875 bps');
    expect(bps(2307.69)).toBe('2,308 bps');
    expect(bps(12.345)).toBe('12.35 bps');
    expect(interval(0.3424, 1)).toBe('95% interval 34% to 100%');
    expect(seconds(45)).toBe('45 s');
    expect(seconds(125)).toBe('2 min 5 s');
    expect(seconds(7260)).toBe('2 h 1 min');
    expect(atoms('30000000', [6])).toBe('30 quote tokens');
    expect(atoms('1500000', [6])).toBe('1.5 quote tokens');
    expect(atoms('1500000', [6, 9])).toBe('1,500,000 atoms');
    expect(plural(1, 'cross', 'crosses')).toBe('1 cross');
    expect(plural(2, 'cross', 'crosses')).toBe('2 crosses');
  });
});
