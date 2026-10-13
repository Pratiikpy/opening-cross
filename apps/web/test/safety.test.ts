// Mint safety on the cross page: the parser, the wording model, the fetcher, and the rendered badge.
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import { RISK_TITLES, badgeModel, fetchSafety, parseSafety } from '../src/lib/safety';
import { SafetyBadge } from '../src/components/cross/safety-badge';

const ISSUER = 'DTB3Jtxb6dy7GvocUbypiJb548ZLGRzVdPrNNCWAKEdC';
const report = (verdict: string, risks: Record<string, unknown>[] = [], over: Record<string, unknown> = {}) => ({
  mint: 'So11111111111111111111111111111111111111112', tokenProgram: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', decimals: 8, supply: '1000', uiMultiplier: 1,
  verdict, crossable: verdict === 'clear' || verdict === 'disclosures', summary: `summary for ${verdict}`, risks, asOf: '1800000000', checkedAt: '2026-10-13T00:00:00.000Z', clock: 'api wall clock', ...over,
});
const risk = (code: string, level: 'blocker' | 'halt' | 'disclosure', holder?: string) => ({ code, severity: level === 'blocker' ? 'block' : level === 'halt' ? 'halt' : 'disclose', level, message: `message for ${code}`, ...(holder && { holder }) });

describe('parseSafety', () => {
  it('accepts what the API serves and keeps holders', () => {
    const r = parseSafety(report('disclosures', [risk('FREEZE_AUTHORITY', 'disclosure', ISSUER)]));
    expect(r).toMatchObject({ verdict: 'disclosures', crossable: true, risks: [{ code: 'FREEZE_AUTHORITY', holder: ISSUER }] });
  });

  it.each([
    ['null', null], ['an array', []], ['a string', 'x'], ['no verdict', { ...report('clear'), verdict: undefined }], ['an unknown verdict', report('fine')],
    ['risks not a list', report('clear', undefined, { risks: 'none' })], ['a risk without a message', report('halted', [{ code: 'MINT_PAUSED', severity: 'halt', level: 'halt' }])],
    ['an unknown level', report('halted', [{ ...risk('MINT_PAUSED', 'halt'), level: 'loud' }])], ['a non-string holder', report('halted', [{ ...risk('MINT_PAUSED', 'halt'), holder: 5 }])],
    ['decimals as text', report('clear', [], { decimals: '8' })],
  ])('rejects %s', (_n, v) => expect(parseSafety(v)).toBeNull());
});

describe('badgeModel', () => {
  it('words each verdict and says how many powers a disclosure carries', () => {
    expect(badgeModel(parseSafety(report('clear'))!)).toMatchObject({ tone: 'clear', label: 'No issuer powers', items: [] });
    expect(badgeModel(parseSafety(report('disclosures', [risk('FREEZE_AUTHORITY', 'disclosure')]))!).label).toBe('1 issuer power');
    expect(badgeModel(parseSafety(report('disclosures', [risk('FREEZE_AUTHORITY', 'disclosure'), risk('MINT_AUTHORITY', 'disclosure')]))!).label).toBe('2 issuer powers');
    expect(badgeModel(parseSafety(report('halted', [risk('MINT_PAUSED', 'halt')]))!)).toMatchObject({ tone: 'halt', label: 'Printing halted' });
    expect(badgeModel(parseSafety(report('blocked', [risk('TRANSFER_HOOK', 'blocker')]))!)).toMatchObject({ tone: 'block', label: 'Token blocked' });
  });

  it('takes the sentence and the order from the API, adds a title and a level label, and falls back to the code for an unknown power', () => {
    const m = badgeModel(parseSafety(report('blocked', [risk('TRANSFER_HOOK', 'blocker', ISSUER), risk('SOMETHING_NEW', 'disclosure')]))!);
    expect(m.headline).toBe('summary for blocked');
    expect(m.items.map((i) => [i.code, i.title, i.levelLabel, i.holder])).toEqual([['TRANSFER_HOOK', 'Transfers run issuer code', 'Blocks a cross', ISSUER], ['SOMETHING_NEW', 'SOMETHING_NEW', 'Disclosed', null]]);
  });

  it('has a title for every risk code the token-safety package can emit', () => {
    const codes = ['MINT_PAUSED', 'PAUSE_AUTHORITY', 'PERMANENT_DELEGATE', 'FREEZE_AUTHORITY', 'MINT_AUTHORITY', 'SCALED_UI_MULTIPLIER', 'SCALED_UI_MULTIPLIER_CHANGE_PENDING', 'TRANSFER_HOOK', 'TRANSFER_FEE', 'DEFAULT_ACCOUNT_FROZEN', 'NON_TRANSFERABLE', 'MINT_CLOSE_AUTHORITY', 'INTEREST_BEARING', 'PERMISSIONED_BURN', 'CONFIDENTIAL_TRANSFERS', 'UNKNOWN_EXTENSION'];
    expect(Object.keys(RISK_TITLES).sort()).toEqual([...codes].sort());
  });
});

describe('fetchSafety', () => {
  const answer = (status: number, body: unknown): typeof fetch => (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;

  it('reads /v1/tokens/:mint/safety and returns the parsed report', async () => {
    let seen = '';
    const f = (async (u: string) => { seen = u; return new Response(JSON.stringify(report('clear'))); }) as unknown as typeof fetch;
    const r = await fetchSafety('http://api.test', 'MintA', f);
    expect(seen).toBe('http://api.test/v1/tokens/MintA/safety');
    expect(r).toMatchObject({ ok: true, data: { verdict: 'clear' } });
  });

  it('carries the API error text, and says so when the answer has the wrong shape or the API is down', async () => {
    expect(await fetchSafety('http://api.test', 'x', answer(404, { error: 'mint x does not exist on chain' }))).toEqual({ ok: false, error: 'mint x does not exist on chain' });
    expect(await fetchSafety('http://api.test', 'x', answer(500, 'oops'))).toMatchObject({ ok: false });
    expect(await fetchSafety('http://api.test', 'x', answer(200, { verdict: 'clear' }))).toMatchObject({ ok: false, error: expect.stringMatching(/does not understand/) });
    const down = (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch;
    expect(await fetchSafety('http://api.test', 'x', down)).toEqual({ ok: false, error: 'The Opening Cross API could not be reached.' });
  });
});

describe('SafetyBadge', () => {
  const html = (v: unknown) => renderToStaticMarkup(createElement(SafetyBadge, { safety: v === null ? null : parseSafety(v)! }));

  it('renders nothing without a report', () => {
    expect(html(null)).toBe('');
    expect(renderToStaticMarkup(createElement(SafetyBadge, { safety: undefined }))).toBe('');
  });

  it('a clear token is one pill and no list', () => {
    const h = html(report('clear'));
    expect(h).toContain('data-tone="clear"');
    expect(h).toContain('No issuer powers');
    expect(h).not.toContain('safety-items');
  });

  it('a privileged token lists its powers collapsed; a blocked one opens the list', () => {
    const p = html(report('disclosures', [risk('FREEZE_AUTHORITY', 'disclosure', ISSUER)]));
    expect(p).toContain('1 issuer power');
    expect(p).toContain('Issuer can freeze accounts');
    expect(p).toContain('Held by DTB3…KEdC');
    expect(p).not.toMatch(/<details[^>]* open/);
    const b = html(report('blocked', [risk('TRANSFER_HOOK', 'blocker')]));
    expect(b).toContain('data-tone="block"');
    expect(b).toContain('Blocks a cross');
    expect(b).toMatch(/<details[^>]* open/);
  });

  it('escapes text from the API', () => {
    const h = html(report('halted', [{ ...risk('MINT_PAUSED', 'halt'), message: '<img src=x onerror=alert(1)>' }]));
    expect(h).not.toContain('<img');
    expect(h).toContain('&lt;img');
  });
});
