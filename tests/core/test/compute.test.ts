// Compute-unit budget per instruction (DP13: placing a bid ≤ 25k CU). Measured in LiteSVM with
// the release build; the table is printed so regressions show up in CI logs.
import { describe, expect, it } from 'vitest';
import { Disclosure, OrderSide, buildClaim, buildPlaceOrder, buildReveal, buildSettleBook, orderAddress, getOrderDecoder } from '@opening-cross/sdk';
import { World } from '../src/world.js';
import { salt } from '../src/harness.js';

describe('compute budget', () => {
  it('stays within the per-instruction budget', async () => {
    const w = await World.create();
    const units: Record<string, bigint> = {};
    const open = await w.newCross({ disclosure: Disclosure.Open, shards: 4, ticks: 256 });
    const b = await w.trader(10_000_000_000n);
    units.commit_open = await w.h.send([await buildPlaceOrder({ cross: w.view(open.address), owner: b, nonce: 1n, side: OrderSide.Buy, price: 1_000_000n, quantity: 1_000_000n })], b);

    const sealed = await w.newCross({ disclosure: Disclosure.Sealed, shards: 4, ticks: 256 });
    const s = salt();
    units.commit_sealed = await w.h.send([await buildPlaceOrder({ cross: w.view(sealed.address), owner: b, nonce: 2n, side: OrderSide.Buy, price: 1_000_000n, quantity: 1_000_000n, salt: s, escrow: 2_000_000n })], b);
    w.h.setTime(sealed.data.closeTs + 1n);
    const order = getOrderDecoder().decode((w.h.svm.getAccount(await orderAddress(sealed.address, b.address, 2n)) as { data: Uint8Array }).data);
    units.reveal = await w.h.send([await buildReveal(w.view(sealed.address), b, 2n, 1_000_000n, 1_000_000n, s)], b);
    w.h.setTime(sealed.data.revealEndTs + 1n);
    const [merge, ...rest] = await buildSettleBook(w.view(sealed.address));
    units.merge_shard = await w.h.send([merge!], w.admin);
    for (const ix of rest.slice(0, -1)) await w.h.send([ix], w.admin);
    units.clear_256_ticks = await w.h.send([rest[rest.length - 1]!], w.admin);
    units.claim = await w.h.send(await buildClaim(w.view(sealed.address), w.admin, b.address, 2n), w.admin);

    console.table(Object.fromEntries(Object.entries(units).map(([k, v]) => [k, Number(v)])));
    expect(units.commit_open! <= 25_000n).toBe(true);
    expect(units.commit_sealed! <= 25_000n).toBe(true);
    expect(units.reveal! <= 25_000n).toBe(true);
  });
});
