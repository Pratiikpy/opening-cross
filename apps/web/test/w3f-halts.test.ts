import { describe, expect, it } from 'vitest';
import { EMPTY_HALT_INIT, type HaltRead, buildHaltInit, feedText, haltHeadline, parsePublishers, roleOf } from '../src/lib/halts';

const A = '2E2aBsgDe255cqMZ7MWkyZx2qMEnMsU3ALuK8NWxKQrr';
const B = '6TLfAfu8dxF9YrTLuE4kgx3dapLNbkpsa8hcz36EhZHx';
const C = '2X63vA1W5qEn53oYaYwcUc3jHLfac9dsiQ1WCN21vyXq';
const FEED = 'ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d';

const read = (o: Partial<NonNullable<HaltRead['state']>> = {}): HaltRead => ({
  baseMint: A,
  halt: B,
  state: { halted: false, reason: 'none', reasonCode: 0, corporateAction: false, since: null, issuerUnpaused: false, authority: A, venueSigner: C, breaker: null, lastResume: null, ...o },
});

describe('haltHeadline', () => {
  it('says plainly that no halt state exists', () => {
    const h = haltHeadline({ baseMint: A, halt: null, note: 'No halt state exists for this mint: nothing can halt a cross of it, and no resume cross is needed.' });
    expect(h.tone).toBe('info');
    expect(h.lines.join(' ')).toMatch(/nothing can halt/);
  });
  it('explains a halt, who set it, and that only a printing resume cross lifts it', () => {
    const h = haltHeadline(read({ halted: true, reason: 'venue-halt', reasonCode: 2, since: '1760000000' }));
    expect(h).toMatchObject({ tone: 'block', title: 'Halted' });
    expect(h.lines[0]).toMatch(/Halted by the venue since 2025-10-09/);
    expect(h.lines.join(' ')).toMatch(/resume cross.*prints at a single price/);
    expect(h.lines.join(' ')).toMatch(/refunds every order in full/);
  });
  it('notes that unpausing the token does not lift the halt', () => {
    const h = haltHeadline(read({ halted: true, reason: 'issuer-pause', reasonCode: 1, since: '1760000000', issuerUnpaused: true }));
    expect(h.lines.join(' ')).toMatch(/lifted its pause on the token itself, but the halt stays/);
  });
  it('distinguishes a flagged corporate action from a halt', () => {
    const h = haltHeadline(read({ corporateAction: true }));
    expect(h).toMatchObject({ tone: 'warn', title: 'Corporate action flagged' });
    expect(h.lines.join(' ')).toMatch(/Only the issuer can clear the flag/);
  });
  it('reports a clear state with the last resume', () => {
    const h = haltHeadline(read({ lastResume: { cross: B, price: '1500000', at: '1760000000' } }));
    expect(h.tone).toBe('ok');
    expect(h.lines.join(' ')).toMatch(/last resume cross/);
  });
  it('shows a reason it does not know as it is', () => {
    expect(haltHeadline(read({ halted: true, reason: 'unknown(9)', reasonCode: 9, since: '1760000000' })).lines[0]).toMatch(/unknown\(9\)/);
  });
});

describe('roleOf', () => {
  it('knows the authority, the venue signer and everyone else', () => {
    const s = read().state;
    expect(roleOf(s, A)).toBe('authority');
    expect(roleOf(s, C)).toBe('venue');
    expect(roleOf(s, B)).toBe('none');
    expect(roleOf(s, null)).toBe('none');
    expect(roleOf(undefined, A)).toBe('none');
  });
});

describe('buildHaltInit', () => {
  it('builds the plain halt state', () => {
    expect(buildHaltInit(EMPTY_HALT_INIT, A, B)).toEqual({ body: { authority: A, baseMint: B }, errors: {} });
  });
  it('adds a venue signer and a breaker in the units the program takes', () => {
    const b = buildHaltInit({ venueSigner: C, breaker: true, feedId: `0x${FEED.toUpperCase()}`, windowSlots: '150', movePct: '12.5' }, A, B);
    expect(b.body).toEqual({ authority: A, baseMint: B, venueSigner: C, breaker: { feedId: FEED, windowSlots: 150, moveBps: 1250 } });
  });
  it('names the field that is wrong and sends nothing', () => {
    const b = buildHaltInit({ venueSigner: 'x', breaker: true, feedId: 'abc', windowSlots: '0', movePct: '0' }, A, B);
    expect(Object.keys(b.errors).sort()).toEqual(['feedId', 'movePct', 'venueSigner', 'windowSlots']);
    expect(b.body).toBeNull();
    expect(buildHaltInit(EMPTY_HALT_INIT, null, B).body).toBeNull();
    expect(buildHaltInit(EMPTY_HALT_INIT, A, 'nope').body).toBeNull();
  });
  it('ignores breaker fields while the breaker is off', () => {
    expect(buildHaltInit({ ...EMPTY_HALT_INIT, feedId: 'garbage' }, A, B).body).toEqual({ authority: A, baseMint: B });
  });
});

describe('parsePublishers', () => {
  it('reads one to four wallets, separated by lines, commas or spaces', () => {
    expect(parsePublishers(`${A}\n${B}, ${C}`)).toEqual({ ok: true, list: [A, B, C] });
  });
  it('refuses none, five, a repeat, and a non-address', () => {
    expect(parsePublishers('  ')).toMatchObject({ ok: false, error: expect.stringMatching(/at least one/) });
    expect(parsePublishers([A, B, C, A, B].join(' '))).toMatchObject({ ok: false, error: expect.stringMatching(/at most four/) });
    expect(parsePublishers(`${A} ${A}`)).toMatchObject({ ok: false, error: expect.stringMatching(/once/) });
    expect(parsePublishers(`${A} zzzzzz`)).toMatchObject({ ok: false, error: expect.stringMatching(/not a Solana address/) });
  });
});

describe('feedText', () => {
  it('says there is no feed', () => {
    expect(feedText({ baseMint: A, feed: null, note: 'No lender print feed exists for this mint.' })).toBe('No lender print feed exists for this mint.');
  });
  it('describes publishers, the minimum and the latest print', () => {
    const t = feedText({ baseMint: A, feed: B, publishers: [A, C], minMatched: '5000', latest: { price: '1500000', priceScale: '1000000', matched: '9000', cross: C, ts: '1', slot: '2' } });
    expect(t).toMatch(/2 publishers may record prints/);
    expect(t).toMatch(/at least 5000 base atoms/);
    expect(t).toMatch(/latest print was 9000 base atoms/);
    expect(feedText({ baseMint: A, feed: B, publishers: [A], minMatched: '0', latest: null })).toMatch(/No print has been recorded yet/);
  });
});
