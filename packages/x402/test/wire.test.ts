// Parsers, encodings and the challenge MAC: exact outputs and hostile inputs.
import { describe, expect, it } from 'vitest';
import { checkChallenge, mintChallenge } from '../src/challenge.js';
import { canonicalize, decodeBase64Json, encodeBase64Json, fromBase64Url, toBase64Url } from '../src/codec.js';
import { WireError, parsePaymentPayload, parseRequirements, sameRequirements } from '../src/types.js';
import { requestKeyOf } from '../src/gate.js';

const A = '11111111111111111111111111111112';
const good = { scheme: 'exact', network: 'solana:x', amount: '10', asset: A, payTo: A, maxTimeoutSeconds: 60, extra: { feePayer: A, memo: 'm' } };

describe('canonicalize (RFC 8785)', () => {
  it('sorts keys by UTF-16 code unit and drops whitespace', () => {
    expect(canonicalize({ b: 1, a: 2, 'é': 3, z: [true, null, 'x'] })).toBe('{"a":2,"b":1,"z":[true,null,"x"],"é":3}');
    // RFC 8785 section 3.2.3: U+20AC sorts before U+D83D U+DE00 by code unit, though it is the larger code point's neighbour.
    expect(canonicalize({ '€': 1, '😀': 2 })).toBe('{"€":1,"😀":2}');
  });
  it('serializes numbers the ECMAScript way and refuses what JSON cannot hold', () => {
    expect(canonicalize([1e30, 4.5, 0.002, -0, 100])).toBe('[1e+30,4.5,0.002,0,100]');
    expect(() => canonicalize(NaN)).toThrow(TypeError);
    expect(() => canonicalize({ f: () => 1 })).toThrow(TypeError);
  });
  it('matches the MPP specification vector', () => {
    // draft-httpauth-payment-01 section 5.1.2.1.1.1: {"amount":"1000000"} encodes to this base64url.
    expect(toBase64Url(canonicalize({ amount: '1000000' }))).toBe('eyJhbW91bnQiOiIxMDAwMDAwIn0');
  });
});

describe('base64 JSON headers', () => {
  it('round-trips and refuses junk and oversize values', () => {
    expect(decodeBase64Json(encodeBase64Json({ a: 1 }), 'h')).toEqual({ a: 1 });
    for (const bad of ['', '!!!', 'AAAA', Buffer.from('{').toString('base64'), 'a'.repeat(20_000)]) expect(() => decodeBase64Json(bad, 'h')).toThrow(WireError);
    expect(() => fromBase64Url('a b', 'x')).toThrow(WireError);
  });
});

describe('payment requirements and payload parsing', () => {
  it('accepts the canonical shape', () => {
    expect(parseRequirements(good)).toEqual(good);
  });
  it('refuses every malformed field', () => {
    const bad: unknown[] = [null, [], 'x', { ...good, scheme: 'upto' }, { ...good, amount: '1.5' }, { ...good, amount: '-1' }, { ...good, amount: '1'.repeat(21) }, { ...good, asset: 'nope' }, { ...good, payTo: 5 }, { ...good, maxTimeoutSeconds: 0 }, { ...good, maxTimeoutSeconds: 7200 }, { ...good, extra: null }, { ...good, extra: { memo: 'm' } }, { ...good, extra: { feePayer: 'bad' } }, { ...good, extra: { feePayer: A, memo: 'é'.repeat(200) } }];
    for (const b of bad) expect(() => parseRequirements(b), JSON.stringify(b)).toThrow(WireError);
  });
  it('parses a payload and refuses the wrong version or a non-base64 transaction', () => {
    const ok = { x402Version: 2, accepted: good, payload: { transaction: 'AQID' } };
    expect(parsePaymentPayload(ok).payload.transaction).toBe('AQID');
    expect(() => parsePaymentPayload({ ...ok, x402Version: 1 })).toThrow(/x402Version/);
    expect(() => parsePaymentPayload({ ...ok, payload: { transaction: 'not base64!' } })).toThrow(WireError);
    expect(() => parsePaymentPayload({ ...ok, payload: {} })).toThrow(WireError);
    expect(() => parsePaymentPayload({ ...ok, resource: 'x' })).toThrow(WireError);
  });
  it('compares requirements field by field, memo included', () => {
    expect(sameRequirements(parseRequirements(good), parseRequirements(good))).toBe(true);
    expect(sameRequirements(parseRequirements(good), parseRequirements({ ...good, extra: { feePayer: A, memo: 'n' } }))).toBe(false);
    expect(sameRequirements(parseRequirements(good), parseRequirements({ ...good, amount: '11' }))).toBe(false);
  });
});

describe('challenge memo', () => {
  const secret = Buffer.alloc(32, 7);
  const terms = { requestKey: 'abc', network: 'solana:x', asset: A, payTo: A, amount: '10' };
  const t0 = 1_800_000_000_000;

  it('verifies for the request it was issued for, until it expires', () => {
    const memo = mintChallenge(secret, terms, t0, 120);
    expect(memo.length).toBeLessThanOrEqual(40);
    expect(checkChallenge(secret, memo, terms, t0 + 119_000)).toMatchObject({ ok: true, expiresAt: t0 / 1000 + 120 });
    expect(checkChallenge(secret, memo, terms, t0 + 121_000)).toEqual({ ok: false, code: 'challenge_expired' });
  });
  it('refuses another request, price, recipient, network or key', () => {
    const memo = mintChallenge(secret, terms, t0, 120);
    for (const other of [{ ...terms, requestKey: 'abd' }, { ...terms, amount: '11' }, { ...terms, payTo: '11111111111111111111111111111113' }, { ...terms, network: 'solana:y' }, { ...terms, asset: '11111111111111111111111111111113' }]) {
      expect(checkChallenge(secret, memo, other, t0)).toEqual({ ok: false, code: 'challenge_invalid' });
    }
    expect(checkChallenge(Buffer.alloc(32, 8), memo, terms, t0)).toEqual({ ok: false, code: 'challenge_invalid' });
  });
  it('refuses a tampered expiry, nonce or MAC and anything malformed', () => {
    const memo = mintChallenge(secret, terms, t0, 120);
    const [v, exp, nonce, mac] = memo.split('.') as [string, string, string, string];
    expect(checkChallenge(secret, `${v}.${(parseInt(exp, 36) + 3600).toString(36)}.${nonce}.${mac}`, terms, t0)).toEqual({ ok: false, code: 'challenge_invalid' });
    expect(checkChallenge(secret, `${v}.${exp}.${'A'.repeat(8)}.${mac}`, terms, t0)).toEqual({ ok: false, code: 'challenge_invalid' });
    for (const junk of ['', 'oc1', 'oc1.1.2.3', memo + 'x', memo.slice(1)]) expect(checkChallenge(secret, junk, terms, t0)).toEqual({ ok: false, code: 'challenge_malformed' });
  });
  it('gives two challenges for one request different memos', () => {
    expect(mintChallenge(secret, terms, t0, 120)).not.toBe(mintChallenge(secret, terms, t0, 120));
  });
});

describe('requestKeyOf', () => {
  it('is stable under query order and differs for every part of the request', () => {
    const base = requestKeyOf({ method: 'GET', path: '/v1/paid/x', query: { a: '1', b: '2' } });
    expect(requestKeyOf({ method: 'get', path: '/v1/paid/x', query: { b: '2', a: '1' } })).toBe(base);
    expect(requestKeyOf({ method: 'GET', path: '/v1/paid/y', query: { a: '1', b: '2' } })).not.toBe(base);
    expect(requestKeyOf({ method: 'GET', path: '/v1/paid/x', query: { a: '1', b: '3' } })).not.toBe(base);
    expect(requestKeyOf({ method: 'POST', path: '/v1/paid/x', query: { a: '1', b: '2' } })).not.toBe(base);
    expect(requestKeyOf({ method: 'GET', path: '/v1/paid/x', query: { a: '1', b: '2' }, body: { z: 1 } })).not.toBe(base);
  });
});
