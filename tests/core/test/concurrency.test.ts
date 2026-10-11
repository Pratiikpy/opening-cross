// Bidders who place at the same moment must not collide. Each build below reads the cross BEFORE any of the others
// lands, exactly as eight wallets do when they all fetch the cross and then sign: an arrival-order shard rule would
// make every one but the first fail with WrongShard. The shard is a function of the owner and nonce, so all land.
import { describe, expect, it } from 'vitest';
import type { Instruction } from '@solana/kit';
import { Disclosure, OrderSide, buildCancel, buildPlaceOrder, buildReveal, shardAddress, shardIndexFor } from '@opening-cross/sdk';
import { World } from '../src/world.js';
import { salt } from '../src/harness.js';

describe('concurrent bidders', () => {
  it('eight bids built from the same snapshot all land, and every one is in the book', async () => {
    const w = await World.create();
    const cross = await w.newCross({ disclosure: Disclosure.Open, shards: 4, ticks: 20 });
    const buyers = [];
    for (let i = 0; i < 8; i++) buyers.push(await w.trader(10_000_000_000n));
    const snapshot = w.view(cross.address);
    const built: { ix: Instruction; owner: (typeof buyers)[number] }[] = [];
    for (const [i, owner] of buyers.entries()) {
      built.push({ ix: await buildPlaceOrder({ cross: snapshot, owner, nonce: BigInt(i), side: OrderSide.Buy, price: 1_000_000n + BigInt(i % 5) * 100_000n, quantity: 1_000_000n }), owner });
    }
    for (const { ix, owner } of built) await w.h.send([ix], owner);
    expect(w.view(cross.address).data.ordersTotal).toBe(8);
    expect(w.view(cross.address).data.ordersOpen).toBe(8);
  });

  it('an order can only go to the shard its owner and nonce name', async () => {
    const w = await World.create();
    const cross = await w.newCross({ disclosure: Disclosure.Open, shards: 4 });
    const b = await w.trader(10_000_000_000n);
    const right = shardIndexFor(b.address, 0n, 4);
    const ix = await buildPlaceOrder({ cross: w.view(cross.address), owner: b, nonce: 0n, side: OrderSide.Buy, price: 1_000_000n, quantity: 1_000_000n });
    const wrong = await shardAddress(cross.address, (right + 1) % 4);
    const right_ = await shardAddress(cross.address, right);
    const tampered = { ...ix, accounts: (ix.accounts ?? []).map((a) => (a.address === right_ ? { ...a, address: wrong } : a)) } as Instruction;
    expect(await w.h.fail([tampered], b)).toContain('WrongShard');
    // The right one lands.
    await w.h.send([ix], b);
    expect(w.view(cross.address).data.ordersTotal).toBe(1);
  });

  it('cancel and reveal find the same shard from the stored owner and nonce', async () => {
    const w = await World.create();
    const open = await w.newCross({ disclosure: Disclosure.Open, shards: 4 });
    const sealed = await w.newCross({ disclosure: Disclosure.Sealed, shards: 4 });
    const a = await w.trader(10_000_000_000n);
    // Several nonces, so more than one shard is exercised.
    for (let n = 0n; n < 6n; n++) {
      await w.h.send([await buildPlaceOrder({ cross: w.view(open.address), owner: a, nonce: n, side: OrderSide.Buy, price: 1_000_000n, quantity: 1_000_000n })], a);
    }
    for (let n = 0n; n < 6n; n += 2n) {
      await w.h.send([await buildCancel(w.view(open.address), a, n, OrderSide.Buy, true)], a);
    }
    expect(w.view(open.address).data.ordersOpen).toBe(3);

    const salts = new Map<bigint, Uint8Array>();
    for (let n = 0n; n < 6n; n++) {
      const s = salt();
      salts.set(n, s);
      await w.h.send([await buildPlaceOrder({ cross: w.view(sealed.address), owner: a, nonce: n, side: OrderSide.Buy, price: 1_000_000n, quantity: 1_000_000n, salt: s })], a);
    }
    w.h.setTime(sealed.data.closeTs + 1n);
    for (let n = 0n; n < 6n; n++) {
      await w.h.send([await buildReveal(w.view(sealed.address), a, n, 1_000_000n, 1_000_000n, salts.get(n)!)], a);
    }
    expect(w.view(sealed.address).data.ordersOpen).toBe(6);
  });
});
