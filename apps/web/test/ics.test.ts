import { describe, expect, it } from 'vitest';
import { crossIcs, escapeText, foldLine, icsUtc } from '../src/lib/ics';

const unfold = (s: string) => s.replace(/\r\n /g, '');
const ADDRESS = '4E4KEexFahSrzjBamymAkVKpK8WGv8kYqMnM5tr9J8xR';

describe('icsUtc', () => {
  it('writes UTC in the basic format', () => {
    expect(icsUtc(0)).toBe('19700101T000000Z');
    expect(icsUtc(1_791_855_797)).toBe('20261013T014317Z');
  });
});

describe('escapeText', () => {
  it('escapes backslash, semicolon, comma and newlines (RFC 5545 3.3.11)', () => {
    expect(escapeText('a,b;c\\d')).toBe('a\\,b\\;c\\\\d');
    expect(escapeText('one\ntwo\r\nthree')).toBe('one\\ntwo\\nthree');
  });
  it('escapes the backslash first so escapes are not doubled', () => {
    expect(escapeText('\\,')).toBe('\\\\\\,');
  });
});

describe('foldLine', () => {
  const octets = (s: string) => new TextEncoder().encode(s).length;
  it('leaves a short line alone', () => {
    expect(foldLine('SUMMARY:short')).toBe('SUMMARY:short');
    expect(foldLine('x'.repeat(75))).toBe('x'.repeat(75));
  });
  it('folds at 75 octets with a leading space on continuations, and unfolds to the original', () => {
    const line = `DESCRIPTION:${'abcdefghij'.repeat(20)}`;
    const folded = foldLine(line);
    const parts = folded.split('\r\n');
    expect(parts.length).toBeGreaterThan(1);
    expect(octets(parts[0]!)).toBeLessThanOrEqual(75);
    for (const p of parts.slice(1)) {
      expect(p.startsWith(' ')).toBe(true);
      expect(octets(p)).toBeLessThanOrEqual(75);
    }
    expect(unfold(folded)).toBe(line);
  });
  it('never splits a multi-byte character', () => {
    const line = `SUMMARY:${'é€😀'.repeat(40)}`;
    const folded = foldLine(line);
    for (const p of folded.split('\r\n')) expect(octets(p)).toBeLessThanOrEqual(75);
    expect(unfold(folded)).toBe(line);
    expect(folded).not.toContain('�');
  });
});

describe('crossIcs', () => {
  const now = 1_791_856_000;
  const ics = crossIcs({ address: ADDRESS, openTs: 1_791_855_797, closeTs: 1_791_855_922, url: `https://opening-bell-psi.vercel.app/crosses/${ADDRESS}` }, now);
  const lines = unfold(ics).split('\r\n');

  it('is a VCALENDAR with one VEVENT, CRLF line endings throughout and a final CRLF', () => {
    expect(lines[0]).toBe('BEGIN:VCALENDAR');
    expect(lines.at(-2)).toBe('END:VCALENDAR');
    expect(lines.at(-1)).toBe('');
    expect(lines.filter((l) => l === 'BEGIN:VEVENT')).toHaveLength(1);
    expect(lines.filter((l) => l === 'END:VEVENT')).toHaveLength(1);
    expect(ics.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
  });

  it('carries the required properties with the cross window as exact UTC times', () => {
    expect(lines).toContain('VERSION:2.0');
    expect(lines.some((l) => l.startsWith('PRODID:'))).toBe(true);
    expect(lines).toContain(`UID:${ADDRESS}@opening-cross`);
    expect(lines).toContain('DTSTAMP:20261013T014640Z');
    expect(lines).toContain('DTSTART:20261013T014317Z');
    expect(lines).toContain('DTEND:20261013T014522Z');
    expect(lines).toContain(`URL:https://opening-bell-psi.vercel.app/crosses/${ADDRESS}`);
  });

  it('keeps every physical line within 75 octets', () => {
    for (const l of ics.split('\r\n')) expect(new TextEncoder().encode(l).length).toBeLessThanOrEqual(75);
  });

  it('escapes the description and names the cross in the summary', () => {
    const d = lines.find((l) => l.startsWith('DESCRIPTION:'))!;
    expect(d).toContain('Devnet only');
    expect(d).not.toMatch(/[^\\],|[^\\];/); // every comma and semicolon in a TEXT value is escaped
    expect(lines.find((l) => l.startsWith('SUMMARY:'))).toContain('4E4K');
  });

  it('refuses a window that does not close after it opens', () => {
    expect(() => crossIcs({ address: ADDRESS, openTs: 10, closeTs: 10, url: 'https://x.test/' })).toThrow(RangeError);
    expect(() => crossIcs({ address: ADDRESS, openTs: 10, closeTs: 5, url: 'https://x.test/' })).toThrow(RangeError);
  });
});
