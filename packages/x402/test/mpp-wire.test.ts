// The MPP wire format against the published specification: the HMAC test vectors of draft-httpauth-payment-01 section
// 5.1.2.1.1.1, the header grammar, and credentials that are hostile or merely wrong. No chain involved.
import { describe, expect, it } from 'vitest';
import { canonicalize, toBase64Url } from '../src/codec.js';
import { MppFront } from '../src/mpp.js';
import { challengeId, decodeReceipt, encodeCredential, encodeOpaque, encodeReceipt, formatChallenge, parseChallenges, parseCredential, problem, verifyChallengeId } from '../src/mpp-wire.js';
import { WireError } from '../src/types.js';

const SECRET = Buffer.from('test-vector-secret');
const REQUEST = toBase64Url(canonicalize({ amount: '1000000' }));
const base = { realm: 'api.example.com', method: 'tempo', intent: 'charge', request: REQUEST };

describe('challenge ids (draft-httpauth-payment-01 test vectors)', () => {
  it('request canonicalises to the base64url of the specification', () => {
    expect(REQUEST).toBe('eyJhbW91bnQiOiIxMDAwMDAwIn0');
  });
  it('legacy layout, no header, no opaque', () => {
    expect(challengeId(SECRET, base)).toBe('X6v1eo7fJ76gAxqY0xN9Jd__4lUyDDYmriryOM-5FO4');
  });
  it('the header-bearing vectors reproduce from the own inputs of the specification, so the HMAC and encoding are the same ones', () => {
    // This implementation never sets the optional header parameter, so these two check the construction, not the code path.
    expect(toBase64Url(require_hmac('api.example.com|tempo|charge|eyJhbW91bnQiOiIxMDAwMDAwIn0|||Payment-Authorization|'))).toBe('S91xi-OFGZPMs-j7GsX0FDpIkmCcZT1P9XyV58WNy_U');
    expect(encodeOpaque({ pi: 'pi_123' })).toBe('eyJwaSI6InBpXzEyMyJ9');
    expect(toBase64Url(require_hmac('api.example.com|tempo|charge|eyJhbW91bnQiOiIxMDAwMDAwIn0|||Payment-Authorization|eyJwaSI6InBpXzEyMyJ9'))).toBe('CJ4X1O4aTDmS59hfdhnhBtxIQjWDOf0bcrhsswwMOW8');
  });
  it('an opaque value is the last slot of the input', () => {
    const opaque = encodeOpaque({ pi: 'pi_123' });
    expect(challengeId(SECRET, { ...base, opaque })).toBe(toBase64Url(require_hmac(`api.example.com|tempo|charge|${REQUEST}|||${opaque}`)));
  });
  it('verifies an id and refuses one parameter changed', () => {
    const id = challengeId(SECRET, { ...base, expires: '2026-01-01T00:00:00Z' });
    const c = { ...base, id, expires: '2026-01-01T00:00:00Z' };
    expect(verifyChallengeId(SECRET, c)).toBe(true);
    for (const t of [{ realm: 'evil.example' }, { method: 'x' }, { intent: 'session' }, { request: toBase64Url('{"amount":"1"}') }, { expires: '2027-01-01T00:00:00Z' }, { opaque: encodeOpaque({ a: 'b' }) }, { digest: 'sha-256=:AAAA:' }]) {
      expect(verifyChallengeId(SECRET, { ...c, ...t }), JSON.stringify(t)).toBe(false);
    }
    expect(verifyChallengeId(Buffer.from('another-secret'), c)).toBe(false);
    expect(verifyChallengeId(SECRET, { ...c, id: id.slice(0, -1) })).toBe(false);
  });
});

import { createHmac } from 'node:crypto';
function require_hmac(input: string): Buffer {
  return createHmac('sha256', SECRET).update(input).digest();
}

describe('WWW-Authenticate: Payment', () => {
  const params = { id: 'x7Tg2pLqR9mKvNwY3hBcZa', realm: 'api.example.com', method: 'solana', intent: 'charge', request: REQUEST, expires: '2026-03-15T12:05:00Z', description: 'He said "hi" \\ bye' };
  it('formats and parses back, quoting included', () => {
    const header = formatChallenge(params);
    expect(header.startsWith('Payment id="x7Tg2pLqR9mKvNwY3hBcZa", realm="api.example.com"')).toBe(true);
    expect(parseChallenges(header)).toEqual([params]);
  });
  it('finds a Payment challenge among challenges of other schemes', () => {
    const header = `Bearer realm="api", error="invalid_token", ${formatChallenge(params)}, Basic realm="x"`;
    expect(parseChallenges(header)).toEqual([params]);
  });
  it('finds several Payment challenges', () => {
    const second = { ...params, id: 'second', method: 'tempo' };
    expect(parseChallenges(`${formatChallenge(params)}, ${formatChallenge(second)}`).map((c) => c.id)).toEqual(['x7Tg2pLqR9mKvNwY3hBcZa', 'second']);
  });
  it('ignores a challenge missing a required parameter, and garbage', () => {
    expect(parseChallenges('Payment id="a", realm="b"')).toEqual([]);
    expect(parseChallenges('')).toEqual([]);
    expect(parseChallenges('Payment ,,, ===')).toEqual([]);
  });
});

describe('credentials', () => {
  const challenge = { id: 'abc', realm: 'api.example.com', method: 'solana', intent: 'charge', request: REQUEST, expires: '2026-03-15T12:05:00Z' };
  const good = { challenge, source: 'W', payload: { type: 'transaction' as const, transaction: 'AQID' } };
  it('round-trips through the Authorization header form', () => {
    const header = encodeCredential(good);
    expect(header).toMatch(/^Payment [A-Za-z0-9_-]+$/);
    expect(parseCredential(header)).toEqual(good);
  });
  it('refuses everything that is not a credential, each with the specified problem class', () => {
    const cases = ['', 'Bearer abc', 'Payment', 'Payment !!!', 'Payment ' + toBase64Url('not json'), 'Payment ' + toBase64Url('[]'), 'Payment ' + toBase64Url('{}'), 'Payment ' + toBase64Url('{"challenge":{"id":"a"},"payload":{"type":"transaction"}}'), 'Payment ' + toBase64Url(JSON.stringify({ challenge, payload: {} })), 'Payment ' + 'A'.repeat(20_000)];
    for (const c of cases) {
      try {
        parseCredential(c);
        expect.unreachable(c.slice(0, 40));
      } catch (e) {
        expect(e, c.slice(0, 40)).toBeInstanceOf(WireError);
        expect((e as WireError).code).toBe('malformed-credential');
      }
    }
  });
  it('round-trips a receipt', () => {
    const r = { method: 'solana', challengeId: 'abc', reference: 'sig', status: 'success' as const, timestamp: '2026-03-10T21:00:00Z' };
    expect(decodeReceipt(encodeReceipt(r))).toEqual(r);
  });
  it('builds RFC 9457 problem documents with the registered problem types', () => {
    expect(JSON.parse(problem('invalid-challenge', 'Bad', 'why'))).toEqual({ type: 'https://paymentauth.org/problems/invalid-challenge', title: 'Bad', status: 402, detail: 'why' });
  });
});

describe('MppFront admission', () => {
  const now = 1_800_000_000_000;
  const feePayer = '11111111111111111111111111111112';
  const mk = (over: Partial<ConstructorParameters<typeof MppFront>[0]> = {}) =>
    new MppFront({ secret: Buffer.alloc(32, 9), asset: '11111111111111111111111111111113', payTo: '11111111111111111111111111111114', network: 'solana:test', ttlSeconds: 120, maxTimeoutSeconds: 60, now: () => now, mpp: { realm: 'api.example.com', network: 'localnet', decimals: 6, tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' }, ...over });
  const front = mk();
  const rk = 'request-key-1';
  const pay = (header: string, transaction = 'AQID', type = 'transaction') => {
    const params = parseChallenges(header)[0]!;
    return encodeCredential({ challenge: params, payload: { type, transaction } as never });
  };
  const issue = (amount = 10_000n, request = rk) => front.challenge({ requestKey: request, amount, description: 'A thing' }, feePayer);

  it('issues a challenge whose id verifies and whose request carries the memo and the fee payer', () => {
    const { header, params } = issue();
    expect(verifyChallengeId(Buffer.alloc(32, 9), params)).toBe(true);
    const request = JSON.parse(Buffer.from(params.request, 'base64url').toString());
    expect(request).toMatchObject({ amount: '10000', currency: '11111111111111111111111111111113', recipient: '11111111111111111111111111111114', methodDetails: { network: 'localnet', decimals: 6, feePayer: true, feePayerKey: feePayer } });
    expect(request.externalId).toMatch(/^[A-Za-z0-9_-]{11}$/);
    expect(params.expires).toBe('2027-01-15T08:02:00Z');
    expect(header).toContain('description="A thing"');
  });
  it('gives two challenges for one request different memos and ids', () => {
    expect(issue().params.id).not.toBe(issue().params.id);
  });
  it('admits a credential for this request at this price', () => {
    const adm = front.admit(pay(issue().header), { requestKey: rk, amount: 10_000n }, [feePayer]);
    expect(adm).toMatchObject({ ok: true, required: { amount: '10000', extra: { feePayer } } });
  });
  it('refuses another request, another price, and an unknown fee payer', () => {
    const header = issue().header;
    expect(front.admit(pay(header), { requestKey: 'other', amount: 10_000n }, [feePayer])).toMatchObject({ ok: false, problem: 'invalid-challenge', code: 'challenge_invalid' });
    expect(front.admit(pay(header), { requestKey: rk, amount: 10_001n }, [feePayer])).toMatchObject({ ok: false, problem: 'invalid-challenge' });
    expect(front.admit(pay(header), { requestKey: rk, amount: 10_000n }, ['11111111111111111111111111111115'])).toMatchObject({ ok: false, code: 'fee_payer_not_managed_by_facilitator' });
  });
  it('refuses a challenge this server did not issue, and one whose parameters were edited', () => {
    const other = mk({ secret: Buffer.alloc(32, 1) });
    const foreign = other.challenge({ requestKey: rk, amount: 10_000n }, feePayer).header;
    expect(front.admit(pay(foreign), { requestKey: rk, amount: 10_000n }, [feePayer])).toMatchObject({ ok: false, problem: 'invalid-challenge' });
    const params = parseChallenges(issue().header)[0]!;
    const edited = { ...params, request: toBase64Url(canonicalize({ ...JSON.parse(Buffer.from(params.request, 'base64url').toString()), amount: '1' })) };
    expect(front.admit(encodeCredential({ challenge: edited, payload: { type: 'transaction', transaction: 'AQID' } }), { requestKey: rk, amount: 1n }, [feePayer])).toMatchObject({ ok: false, problem: 'invalid-challenge' });
  });
  it('refuses an expired challenge as payment-expired, on the server\'s clock', () => {
    const header = issue().header;
    const late = mk({ now: () => now + 121_000 });
    expect(late.admit(pay(header), { requestKey: rk, amount: 10_000n }, [feePayer])).toMatchObject({ ok: false, problem: 'payment-expired' });
    const justInTime = mk({ now: () => now + 120_000 });
    expect(justInTime.admit(pay(header), { requestKey: rk, amount: 10_000n }, [feePayer])).toMatchObject({ ok: true });
  });
  it('refuses push mode with the reason the specification gives, and payload types it does not offer', () => {
    const header = issue().header;
    const push = encodeCredential({ challenge: parseChallenges(header)[0]!, payload: { type: 'signature', signature: '5U' } as never });
    expect(front.admit(push, { requestKey: rk, amount: 10_000n }, [feePayer])).toMatchObject({ ok: false, code: 'push_mode_not_accepted', problem: 'verification-failed' });
    expect(front.admit(pay(header, 'AQID', 'bundle'), { requestKey: rk, amount: 10_000n }, [feePayer])).toMatchObject({ ok: false, code: 'unsupported_payload_type' });
    expect(front.admit(pay(header, 'not base64!'), { requestKey: rk, amount: 10_000n }, [feePayer])).toMatchObject({ ok: false, code: 'invalid_payload' });
  });
  it('refuses a credential for the wrong method, intent or realm', () => {
    const params = parseChallenges(issue().header)[0]!;
    for (const edit of [{ method: 'tempo' }, { intent: 'session' }, { realm: 'evil.example' }]) {
      const c = encodeCredential({ challenge: { ...params, ...edit }, payload: { type: 'transaction', transaction: 'AQID' } });
      expect(front.admit(c, { requestKey: rk, amount: 10_000n }, [feePayer])).toMatchObject({ ok: false, problem: 'invalid-challenge' });
    }
  });
});
