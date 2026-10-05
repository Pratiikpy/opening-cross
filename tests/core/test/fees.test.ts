// Fee rules (ROADMAP C4, ADR-0010): fees are snapshotted at creation, charged only on fills,
// never on bids, cancels or refunds; the protocol takes at most 20% of a cross's total fees, and a
// cross with no integrator fee pays no protocol fee.
import { describe, expect, it } from 'vitest';
import { CrossState, OrderSide, SupplyMode, getSetProtocolFeesInstruction, protocolAddress } from '@opening-cross/sdk';
import { World } from '../src/world.js';

describe('fees', () => {
  it('protocol share is min(schedule, integrator / 4) and never above 20% of total fees', async () => {
    const w = await World.create();
    for (const integratorFeeBps of [0, 3, 20, 120, 300]) {
      const c = await w.newCross({ integratorFeeBps });
      const p = c.data.protocolFeeBps;
      expect(p).toBe(Math.min(30, Math.floor(integratorFeeBps / 4)));
      expect(p * 5 <= p + integratorFeeBps).toBe(true);
    }
  });

  it('public-good tier: no integrator fee → no fees at all, buyers and sellers get every atom', async () => {
    const w = await World.create();
    const cross = await w.newCross({ integratorFeeBps: 0 });
    const s = await w.trader(0n, 1_000_000_000n);
    const b = await w.trader(10_000_000_000n);
    const orders = [await w.place(cross, s, OrderSide.Sell, 1_000_000n, 1_000_000_000n), await w.place(cross, b, OrderSide.Buy, 1_000_000n, 1_000_000_000n)];
    await w.settle(cross);
    await w.claimAll(w.view(cross.address), orders);
    await w.finalize(w.view(cross.address));
    expect(await w.h.balanceOf(s.address, w.quoteMint)).toBe(1_000_000_000n);
    expect(await w.h.balanceOf(w.feeRecipient.address, w.quoteMint)).toBe(0n);
    expect(await w.h.balanceOf(w.integrator.address, w.quoteMint)).toBe(0n);
  });

  it('a fee change never touches live crosses, and cancels and refunds are free', async () => {
    const w = await World.create();
    const cross = await w.newCross({ integratorFeeBps: 300 });
    const before = cross.data.protocolFeeBps;
    await w.h.send([getSetProtocolFeesInstruction({ admin: w.admin, protocol: await protocolAddress(), feeRecipient: w.feeRecipient.address, feeBps: [100, 100, 100, 100] })], w.admin);
    expect(w.view(cross.address).data.protocolFeeBps).toBe(before);
    const b = await w.trader(10_000_000_000n);
    const o = await w.place(cross, b, OrderSide.Buy, 1_000_000n, 1_000_000_000n);
    await w.cancel(cross, o);
    expect(await w.h.balanceOf(b.address, w.quoteMint)).toBe(10_000_000_000n);
    // A refunded (no-print) order is also free.
    const c2 = await w.newCross({ integratorFeeBps: 300, supplyMode: SupplyMode.Escrow });
    const o2 = await w.place(c2, b, OrderSide.Buy, 1_000_000n, 1_000_000_000n);
    expect((await w.settle(c2)).data.state).toBe(CrossState.NoPrint);
    await w.claimAll(w.view(c2.address), [o2]);
    expect(await w.h.balanceOf(b.address, w.quoteMint)).toBe(10_000_000_000n);
  });
});
