import { describe, expect, it } from 'vitest';
import { getAddressEncoder } from '@solana/kit';
import { EMPTY_RULING, buildRuling, decodeArbiterRegistry, standingText } from '../src/lib/arbiter';

const A = '2E2aBsgDe255cqMZ7MWkyZx2qMEnMsU3ALuK8NWxKQrr';
const B = '6TLfAfu8dxF9YrTLuE4kgx3dapLNbkpsa8hcz36EhZHx';
const ctx = { cross: B, id: 2, arbiter: A, bondHeld: '100000000', quoteDecimals: 6 };

describe('buildRuling', () => {
  it('rejects a challenge: nothing is slashed and the deposit goes to the protocol', () => {
    const r = buildRuling({ decision: 'reject', slash: '' }, ctx);
    expect(r.body).toEqual({ cross: B, arbiter: A, id: 2, upheld: false });
    expect(r.sentence).toMatch(/deposit to the protocol/);
  });
  it('refuses a rejection that names a slash', () => {
    expect(buildRuling({ decision: 'reject', slash: '5' }, ctx)).toMatchObject({ body: null, error: expect.stringMatching(/slashes nothing/) });
    expect(buildRuling({ decision: 'reject', slash: '0' }, ctx).body).not.toBeNull();
  });
  it('upholds with a slash in atoms and says where it goes', () => {
    const r = buildRuling({ decision: 'uphold', slash: '40' }, ctx);
    expect(r.body).toEqual({ cross: B, arbiter: A, id: 2, upheld: true, slash: '40000000' });
    expect(r.sentence).toMatch(/slashes 40 quote from the bond: 20 quote to the challenger and the rest to the protocol/);
  });
  it('allows upholding with a slash of zero, and the whole bond, but not more', () => {
    expect(buildRuling({ decision: 'uphold', slash: '0' }, ctx).body).toMatchObject({ upheld: true, slash: '0' });
    expect(buildRuling({ decision: 'uphold', slash: '100' }, ctx).body).toMatchObject({ slash: '100000000' });
    expect(buildRuling({ decision: 'uphold', slash: '100.000001' }, ctx)).toMatchObject({ body: null, error: expect.stringMatching(/at most the bond still held, 100 quote/) });
  });
  it('makes the arbiter say how much to slash, and reads the figure exactly', () => {
    expect(buildRuling({ decision: 'uphold', slash: '' }, ctx).error).toMatch(/how much of the bond/);
    expect(buildRuling({ decision: 'uphold', slash: '1.0000001' }, ctx).error).toMatch(/6 decimal places/);
    expect(buildRuling({ decision: 'uphold', slash: '-3' }, ctx).body).toBeNull();
  });
  it('builds nothing without a connected arbiter', () => {
    expect(buildRuling(EMPTY_RULING, { ...ctx, arbiter: null })).toEqual({ body: null, error: null, sentence: null });
  });
});

describe('the registry and the standing text', () => {
  it('reads the arbiter after the 8-byte discriminator', () => {
    const data = new Uint8Array(41);
    data.set(getAddressEncoder().encode(A as never), 8);
    expect(decodeArbiterRegistry(data)).toBe(A);
    expect(decodeArbiterRegistry(new Uint8Array(20))).toBeNull();
  });
  it('tells each visitor where they stand', () => {
    expect(standingText({ state: 'none' }, A)).toMatch(/No arbiter has been named yet/);
    expect(standingText({ state: 'named', arbiter: A }, null)).toMatch(/Connect a wallet/);
    expect(standingText({ state: 'named', arbiter: A }, A)).toMatch(/This wallet is the arbiter/);
    expect(standingText({ state: 'named', arbiter: A }, B)).toMatch(/not the arbiter/);
    expect(standingText({ state: 'unread', reason: 'boom' }, A)).toMatch(/could not be read.*boom/);
  });
});
