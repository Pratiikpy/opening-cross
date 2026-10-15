import { describe, expect, it } from 'vitest';
import {
  ALL_TOPICS,
  MAX_WATCH,
  TOPIC_LABEL,
  type Subject,
  ageText,
  allWatched,
  isMovementKind,
  isWatching,
  parseSaved,
  parseWatch,
  subjectSummary,
  toggleTopic,
  toggleWatch,
} from '../src/lib/holder-alerts';

const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const TREASURY = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const CROSS = 'ELVKGevyF2qarSYiZHAkRdAkfKruKSgKL7aS9XTrVBK8';
const empty = { crosses: [], markets: [], tokens: [], treasuries: [] };

describe('topics: reminders and movements are one list', () => {
  it('names all six, with words for each', () => {
    expect(ALL_TOPICS).toEqual(['claimable', 'closing', 'opening', 'insider', 'team', 'treasury']);
    for (const t of ALL_TOPICS) expect(TOPIC_LABEL[t].title.length, t).toBeGreaterThan(10);
  });

  it('reads saved topics in the order the page shows them, once each, and drops anything it does not know', () => {
    const saved = parseSaved(JSON.stringify({ topics: ['treasury', 'spam', 'claimable', 'insider', 'claimable'] }));
    expect(saved.topics).toEqual(['claimable', 'insider', 'treasury']);
    for (const raw of [null, undefined, '', 'not json', '[]', '{"topics":5}', '{"topics":["spam"]}']) expect(parseSaved(raw).topics, String(raw)).toEqual(['claimable', 'closing']);
  });

  it('flips a topic keeping the order, and never turns off the last one', () => {
    const a = toggleTopic(toggleTopic(['claimable'], 'treasury'), 'insider');
    expect(a).toEqual(['claimable', 'insider', 'treasury']);
    expect(toggleTopic(a, 'insider')).toEqual(['claimable', 'treasury']);
    expect(toggleTopic(['insider'], 'insider')).toEqual(['insider']);
  });
});

describe('what a browser follows', () => {
  it('reads nothing, junk and foreign values as nothing, never trusting them', () => {
    for (const raw of [null, undefined, '', 'not json', '[]', '{"crosses":5,"tokens":"x"}']) expect(parseWatch(raw), String(raw)).toEqual(empty);
    expect(parseWatch(JSON.stringify({ crosses: [CROSS], tokens: [MINT, 'nope', MINT, 5], treasuries: [TREASURY] }))).toEqual({ crosses: [CROSS], markets: [], tokens: [MINT], treasuries: [TREASURY] });
  });

  it('reads the earlier two-list storage as it was, with no tokens or treasuries', () => {
    expect(parseWatch(JSON.stringify({ crosses: [CROSS], markets: [MINT] }))).toEqual({ crosses: [CROSS], markets: [MINT], tokens: [], treasuries: [] });
  });

  it('flips an address on and off in the list of its kind', () => {
    const f = toggleWatch(empty, 'tokens', MINT);
    expect(f.tokens).toEqual([MINT]);
    expect(isWatching(f, 'tokens', MINT)).toBe(true);
    expect(isWatching(f, 'treasuries', MINT)).toBe(false);
    expect(toggleWatch(f, 'tokens', MINT).tokens).toEqual([]);
    expect(toggleWatch(empty, 'tokens', 'not an address')).toBe(empty);
  });

  it('stops at the one limit the server has, counting crosses, markets, tokens and treasuries together', () => {
    const addr = (i: number) => `${'A'.repeat(40)}${'ABCDEFGHJK'[Math.floor(i / 10)]}${'ABCDEFGHJK'[i % 10]}`;
    const full = { crosses: Array.from({ length: 20 }, (_, i) => addr(i)), markets: Array.from({ length: 10 }, (_, i) => addr(20 + i)), tokens: Array.from({ length: 20 }, (_, i) => addr(30 + i)), treasuries: [] };
    expect(MAX_WATCH).toBe(50);
    expect(toggleWatch(full, 'treasuries', TREASURY)).toBe(full);
    // Unfollowing is always allowed, however full the list is.
    expect(toggleWatch(full, 'tokens', full.tokens[0]!).tokens).toHaveLength(19);
  });

  it('sends the server one list: every kind, an address followed twice only once', () => {
    expect(allWatched({ crosses: [CROSS], markets: [], tokens: [MINT], treasuries: [TREASURY, MINT] })).toEqual([CROSS, MINT, TREASURY]);
    expect(allWatched(empty)).toEqual([]);
  });
});

describe('words for the feed', () => {
  it('says how long ago a movement was seen', () => {
    expect(ageText(1000, 1030)).toBe('just now');
    expect(ageText(1000, 1000 + 600)).toBe('10 min ago');
    expect(ageText(1000, 1000 + 7200)).toBe('2 h ago');
    expect(ageText(1000, 1000 + 3 * 86_400)).toBe('3 days ago');
    expect(ageText(2000, 1000)).toBe('just now');
    expect(isMovementKind('insider') && isMovementKind('team') && isMovementKind('treasury')).toBe(true);
    expect(isMovementKind('closing')).toBe(false);
  });

  const subject = (over: Partial<Subject>): Subject => ({ address: MINT, kind: 'token', tokens: [], treasuries: [], available: {}, movementThresholdPercent: 0.1, note: '', ...over });
  it('explains what following each kind of address covers, and what cannot be followed', () => {
    const token = { mint: MINT, isToken: true, insiders: [] };
    expect(subjectSummary(subject({ kind: 'token', tokens: [token] }))).toMatchObject({ follow: 'tokens' });
    expect(subjectSummary(subject({ kind: 'cross', tokens: [token], treasuries: [TREASURY] }))).toMatchObject({ follow: 'tokens' });
    expect(subjectSummary(subject({ kind: 'cross', tokens: [token], treasuries: [TREASURY] })).text).toContain('its treasury');
    expect(subjectSummary(subject({ kind: 'treasury', address: TREASURY, tokens: [token], treasuries: [TREASURY] }))).toMatchObject({ follow: 'treasuries' });
    expect(subjectSummary(subject({ kind: 'market' }))).toMatchObject({ follow: null });
    expect(subjectSummary(subject({ kind: 'none' }))).toMatchObject({ follow: null });
    expect(subjectSummary(subject({ kind: 'unknown' })).text).toContain('cannot read the chain');
    expect(subjectSummary(subject({ kind: 'cross', tokens: [{ mint: MINT, isToken: null, insiders: null }] }))).toMatchObject({ follow: null });
  });
});
