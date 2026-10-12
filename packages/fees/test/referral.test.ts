import { generateKeyPair, getAddressFromPublicKey } from '@solana/kit';
import { describe, expect, it } from 'vitest';
import { REFERRAL_SCHEMA, type ReferralBody, ReferralError, type ReferredOrder, referralId, referralLines, referrerAt, signReferral, validateReferral, verifyReferral } from '../src/index.js';

const NONCE = '00112233445566778899aabbccddeeff';
const A = '11111111111111111111111111111112';
const B = 'SysvarC1ock11111111111111111111111111111111';
const C = 'SysvarRent111111111111111111111111111111111';

const body = (over: Partial<ReferralBody> = {}): ReferralBody => ({ schema: REFERRAL_SCHEMA, owner: A, referrer: B, effectiveFrom: 100, nonce: NONCE, ...over });

describe('referral documents', () => {
  it('sign and verify with the owner key, and fail after any change', async () => {
    const kp = await generateKeyPair();
    const owner = await getAddressFromPublicKey(kp.publicKey);
    const signed = await signReferral(body({ owner }), kp);
    expect(await verifyReferral(signed)).toBe(true);
    expect(await verifyReferral({ ...signed, body: { ...signed.body, referrer: C } })).toBe(false);
    expect(await verifyReferral({ ...signed, signature: '0'.repeat(128) })).toBe(false);
  });

  it('are not valid when signed by someone other than the owner', async () => {
    const other = await generateKeyPair();
    const signed = await signReferral(body(), other);
    expect(await verifyReferral(signed)).toBe(false);
  });

  it('refuse self-referral, a bad nonce, a bad address and a wrong schema', () => {
    expect(() => validateReferral(body({ referrer: A }))).toThrow(ReferralError);
    expect(() => validateReferral(body({ nonce: 'xyz' }))).toThrow(ReferralError);
    expect(() => validateReferral(body({ referrer: 'not an address' }))).toThrow(ReferralError);
    expect(() => validateReferral({ ...body(), schema: 'other' } as never)).toThrow(ReferralError);
    expect(referralId(body())).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('which referrer applies', () => {
  it('is the latest document effective at or before the order, and a revocation ends it', () => {
    const docs = [body({ referrer: B, effectiveFrom: 100, nonce: '1'.repeat(16) }), body({ referrer: C, effectiveFrom: 200, nonce: '2'.repeat(16) }), body({ referrer: null, effectiveFrom: 300, nonce: '3'.repeat(16) })];
    expect(referrerAt(docs, A, 99)).toBeNull();
    expect(referrerAt(docs, A, 100)).toBe(B);
    expect(referrerAt(docs, A, 250)).toBe(C);
    expect(referrerAt(docs, A, 300)).toBeNull();
    expect(referrerAt(docs, 'someone else', 250)).toBeNull();
  });
});

describe('payouts', () => {
  const order = (over: Partial<ReferredOrder>): ReferredOrder => ({ cross: 'X', order: 'o1', owner: A, side: 'sell', placedAt: 150, notional: 1_000_000_000n, escrowFee: 2_500_000n, ...over });

  it('escrow: 10% of the protocol part of the seller fee', () => {
    // 5 + 20 bps on a 1,000 USDC sale: fee 2,500,000, protocol part 500,000, referrer 50,000.
    const cross = { cross: 'X', supplyMode: 'escrow' as const, protocolBps: 5, integratorBps: 20, protocolFee: 500_000n };
    const lines = referralLines(cross, [order({})], [body()]);
    expect(lines).toEqual([{ cross: 'X', order: 'o1', owner: A, referrer: B, protocolFeeShare: 500_000n, payout: 50_000n }]);
  });

  it('escrow: a referred buyer generates nothing', () => {
    const cross = { cross: 'X', supplyMode: 'escrow' as const, protocolBps: 5, integratorBps: 20, protocolFee: 500_000n };
    expect(referralLines(cross, [order({ side: 'buy', escrowFee: 0n })], [body()])).toEqual([]);
  });

  it('mint: a referred buyer carries their share of the issuer-paid fee', () => {
    // Buyer paid 400,000,000 of 2,400,000,000: fee floor(4e8 x 25 / 1e4) = 1,000,000; protocol part 200,000; referrer 20,000.
    const cross = { cross: 'X', supplyMode: 'mint' as const, protocolBps: 5, integratorBps: 20, protocolFee: 1_200_000n };
    const lines = referralLines(cross, [order({ side: 'buy', notional: 400_000_000n, escrowFee: 0n })], [body()]);
    expect(lines[0]?.payout).toBe(20_000n);
  });

  it('ignores orders placed before the referral took effect and orders with no referral', () => {
    const cross = { cross: 'X', supplyMode: 'escrow' as const, protocolBps: 5, integratorBps: 20, protocolFee: 500_000n };
    expect(referralLines(cross, [order({ placedAt: 99 })], [body()])).toEqual([]);
    expect(referralLines(cross, [order({ owner: C })], [body()])).toEqual([]);
  });

  it('never pays more than a tenth of the cross protocol fee, over many random books', () => {
    let seed = 7;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    for (let round = 0; round < 500; round++) {
      const pBps = rnd(31);
      const iBps = pBps * 4 + rnd(40);
      const total = BigInt(pBps + iBps);
      const orders: ReferredOrder[] = [];
      let fees = 0n;
      for (let i = 0; i < 1 + rnd(30); i++) {
        const gross = BigInt(1 + rnd(2_000_000_000));
        const fee = (gross * total) / 10_000n;
        fees += fee;
        orders.push({ cross: 'X', order: `o${i}`, owner: A, side: 'sell', placedAt: 150, notional: gross, escrowFee: fee });
      }
      const protocolFee = total === 0n ? 0n : (fees * BigInt(pBps)) / total;
      const lines = referralLines({ cross: 'X', supplyMode: 'escrow', protocolBps: pBps, integratorBps: iBps, protocolFee }, orders, [body()]);
      const paid = lines.reduce((a, l) => a + l.payout, 0n);
      expect(paid).toBeLessThanOrEqual(protocolFee / 10n);
    }
  });
});
