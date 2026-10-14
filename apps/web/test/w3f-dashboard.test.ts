import { describe, expect, it } from 'vitest';
import { type Section, authorityText, humanize, leaf, programRows, rowsOf, staleText } from '../src/lib/dashboard';

describe('humanize and leaf', () => {
  it('reads keys in either style', () => {
    expect(humanize('quote_to_sellers')).toBe('Quote to sellers');
    expect(humanize('crossesPrinted')).toBe('Crosses printed');
  });
  it('never draws a missing value as zero', () => {
    expect(leaf(null)).toBe('no data');
    expect(leaf(0)).toBe('0');
    expect(leaf(true)).toBe('yes');
    expect(leaf(12345)).toBe('12,345');
    expect(leaf(0.25)).toBe('0.25');
    expect(leaf('')).toBe('empty');
  });
});

describe('rowsOf', () => {
  it('flattens leaves to labelled rows and keeps the route’s method text apart', () => {
    const r = rowsOf({ network: 'devnet', crosses_total: 112, bids: { placed: 10, fillRate: null }, ids: ['a', 'b'], list: [{ x: 1 }, { x: 2 }], method: 'Counted from the index.' });
    expect(r.rows).toEqual([
      ['Network', 'devnet'],
      ['Crosses total', '112'],
      ['Bids · Placed', '10'],
      ['Bids · Fill rate', 'no data'],
      ['Ids', 'a, b'],
      ['List', '2 items'],
    ]);
    expect(r.notes).toEqual(['Counted from the index.']);
  });
  it('limits what it shows and says how much it left out', () => {
    const data = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`k${i}`, i]));
    const r = rowsOf(data, 10);
    expect(r.rows).toHaveLength(10);
    expect(r.truncated).toBe(40);
  });
  it('does not descend past three levels and does not pretend it did', () => {
    const r = rowsOf({ a: { b: { c: { d: 1, e: { f: 2 } } } } });
    expect(r.rows).toEqual([['A · B · C · D', '1'], ['A · B · C · E', 'see the route']]);
  });
});

describe('programs', () => {
  const data = [
    { name: 'cross_core', address: 'A', deployed: true, upgradeable: true, lastDeployedSlot: '510', upgradeAuthority: 'DTB3', allocatedBytes: 7 },
    { name: 'cross_gate', address: 'B', deployed: true, upgradeable: true, lastDeployedSlot: '5', upgradeAuthority: null },
    { name: 'treasury', address: 'C', deployed: false },
    { name: 'cross_settle', address: 'D', deployed: true, upgradeable: false },
    { name: 'cross_calendar', address: 'E', deployed: true, upgradeable: true, error: 'the program data account could not be read' },
  ];
  it('says who can replace each program, and the difference between revoked, absent and unread', () => {
    const rows = programRows(data);
    expect(rows.map(authorityText)).toEqual(['DTB3', 'none: it can never be changed', 'not deployed on this network', 'not upgradeable', 'could not be read: the program data account could not be read']);
    expect(programRows('nope')).toEqual([]);
  });
});

describe('staleText', () => {
  it('says how old and why', () => {
    const s: Section = { ok: true, source: '/v1/stats', data: {}, stale: true, staleSeconds: 600, staleBecause: 'answered HTTP 500: rpc busy' };
    expect(staleText(s)).toBe('Showing the last good answer, 10 minutes old, because the route now says: answered HTTP 500: rpc busy.');
    expect(staleText({ ok: true, source: 'x', data: {} })).toBeNull();
    expect(staleText({ ...s, staleSeconds: 30, staleBecause: undefined })).toBe('Showing the last good answer, 30 seconds old.');
  });
});
