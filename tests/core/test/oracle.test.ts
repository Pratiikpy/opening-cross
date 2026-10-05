// Oracle divergence guard: a reopen does not print if P* strays from the Pyth price, or if no
// fresh, fully verified Pyth price is available.
import { describe, expect, it } from 'vitest';
import { type Address, address, generateKeyPairSigner, lamports } from '@solana/kit';
import { CrossState, OrderSide, buildSettleBook } from '@opening-cross/sdk';
import { World } from '../src/world.js';

const RECEIVER = address('rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ');
const DISC = [34, 241, 35, 99, 157, 126, 244, 205];
const FEED = new Uint8Array(32).fill(7);

function priceUpdate(price: bigint, expo: number, publishTime: bigint, full = true, feed = FEED): Uint8Array {
  const b = Buffer.alloc(8 + 32 + 2 + 32 + 8 + 8 + 4 + 8 * 6);
  let at = 0;
  Buffer.from(DISC).copy(b, at); at += 8 + 32;
  if (full) { b[at] = 1; at += 1; } else { b[at] = 0; b[at + 1] = 13; at += 2; }
  Buffer.from(feed).copy(b, at); at += 32;
  b.writeBigInt64LE(price, at); at += 8 + 8;
  b.writeInt32LE(expo, at); at += 4;
  b.writeBigInt64LE(publishTime, at);
  return new Uint8Array(b);
}

async function run(update: Uint8Array | null, owner: Address = RECEIVER) {
  const w = await World.create();
  const acct = (await generateKeyPairSigner()).address;
  if (update) w.h.svm.setAccount({ address: acct, data: update, executable: false, lamports: lamports(10_000_000n), programAddress: owner, space: BigInt(update.length) });
  // Both mints have 6 decimals and prices are quote atoms per 1e6 base atoms, so an oracle price
  // of 1.20 (120 × 10^-2) equals 1_200_000 in cross units.
  const cross = await w.newCross({ oracle: { feedId: FEED, maxDivergenceBps: 300, maxStalenessSecs: 600 } });
  const s = await w.trader(0n, 1_000_000_000n);
  const b = await w.trader(10_000_000_000n);
  await w.place(cross, s, OrderSide.Sell, 1_200_000n, 1_000_000_000n);
  await w.place(cross, b, OrderSide.Buy, 1_200_000n, 1_000_000_000n);
  return { w, cross, acct };
}

describe('oracle guard', () => {
  const t = 1_800_000_100n;
  it('prints when P* is within the band of a fresh, fully verified price', async () => {
    const { w, cross, acct } = await run(priceUpdate(121n, -2, t));
    expect((await w.settle(cross, acct)).data.state).toBe(CrossState.Cleared);
  });

  it('accepts updates written by the upgraded Pyth receiver (26 Aug 2026 upgrade)', async () => {
    const { w, cross, acct } = await run(priceUpdate(121n, -2, t), address('rec2HHDDnjLfj4kE7VyEtFA1HPGQLK33259532cRyHp'));
    expect((await w.settle(cross, acct)).data.state).toBe(CrossState.Cleared);
  });

  it('does not print when P* diverges from the oracle', async () => {
    const { w, cross, acct } = await run(priceUpdate(130n, -2, t));
    const v = await w.settle(cross, acct);
    expect(v.data.state).toBe(CrossState.NoPrint);
    expect(v.data.noPrintReason).toEqual({ __option: 'Some', value: 4 });
  });

  it('does not print on a stale, partially verified, foreign or wrong-feed price', async () => {
    for (const [u, owner] of [
      [priceUpdate(120n, -2, t - 10_000n), RECEIVER],
      [priceUpdate(120n, -2, t, false), RECEIVER],
      [priceUpdate(120n, -2, t), address('11111111111111111111111111111111')],
      [priceUpdate(120n, -2, t, true, new Uint8Array(32).fill(8)), RECEIVER],
    ] as const) {
      const { w, cross, acct } = await run(u, owner);
      const v = await w.settle(cross, acct);
      expect(v.data.state).toBe(CrossState.NoPrint);
      expect(v.data.noPrintReason).toEqual({ __option: 'Some', value: 5 });
    }
  });

  it('refuses to clear without the configured price account', async () => {
    const { w, cross, acct } = await run(priceUpdate(120n, -2, t));
    w.h.setTime(cross.data.revealEndTs + 1n);
    const ixs = await buildSettleBook(w.view(cross.address), { oraclePrice: acct });
    for (const ix of ixs.slice(0, -1)) await w.h.send([ix], w.admin);
    const clear = ixs[ixs.length - 1]!;
    // Replace the price account with the program-id placeholder Anchor uses for "None".
    const stripped = { ...clear, accounts: clear.accounts!.map((a, i) => (i === 2 ? { ...a, address: clear.programAddress } : a)) };
    expect(await w.h.fail([stripped], w.admin)).toMatch(/OracleAccountMissing|NotEnoughAccountKeys|AccountNotEnoughKeys/);
  });
});
