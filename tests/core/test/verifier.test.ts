// The verifier must catch a book that does not support the recorded clearing.
import { describe, expect, it } from 'vitest';
import { lamports } from '@solana/kit';
import { OrderSide } from '@opening-cross/sdk';
import { bookAddressOf, verifyCross, PROOF_SCHEMA } from '@opening-cross/verifier';
import { World } from '../src/world.js';

describe('verifier', () => {
  it('verifies a cleared cross and flags a tampered book', async () => {
    const w = await World.create();
    const cross = await w.newCross();
    const s = await w.trader(0n, 2_000_000_000n);
    const b = await w.trader(10_000_000_000n);
    await w.place(cross, s, OrderSide.Sell, 1_100_000n, 2_000_000_000n);
    await w.place(cross, b, OrderSide.Buy, 1_300_000n, 1_000_000_000n);
    await w.settle(cross);
    const fetch = async (a: Parameters<typeof bookAddressOf>[0]) => { const x = w.h.svm.getAccount(a); return x.exists ? x.data : null; };
    const proof = await verifyCross(fetch, cross.address);
    expect(proof.schema).toBe(PROOF_SCHEMA);
    expect(proof.verified).toBe(true);
    expect(proof.recomputed.price).toBe(proof.onchain.price);
    expect(proof.book.length).toBe(2);

    // Inflate the buy quantity at 1.3 in the stored book: the recorded clearing no longer follows.
    const bookAddr = await bookAddressOf(cross.address);
    const acct = w.h.svm.getAccount(bookAddr);
    if (!acct.exists) throw new Error('book missing');
    const data = new Uint8Array(acct.data);
    const tick = Number((1_300_000n - cross.data.minPrice) / cross.data.tick);
    new DataView(data.buffer).setBigUint64(8 + 32 + tick * 8, 5_000_000_000n, true);
    w.h.svm.setAccount({ address: bookAddr, data, executable: false, lamports: lamports(BigInt(acct.lamports)), programAddress: acct.programAddress, space: BigInt(data.length) });
    const tampered = await verifyCross(fetch, cross.address);
    expect(tampered.verified).toBe(false);
  });
});
