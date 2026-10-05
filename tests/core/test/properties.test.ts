// Randomized end-to-end runs: random books through commit → reveal → merge → clear → claim →
// finalize, checked against the independent reference and for exact token conservation.
import { describe, expect, it } from 'vitest';
import { CrossState, Disclosure, OrderSide, SupplyMode, baseVaultAddress, costCeil, quoteVaultAddress } from '@opening-cross/sdk';
import { SCALE, World, type PlacedOrder } from '../src/world.js';
import { referenceClear, referenceFills } from '../src/reference.js';

function rng(seed: number) {
  let x = seed >>> 0 || 1;
  return (n: number) => {
    x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0;
    return x % n;
  };
}

const RUNS = Number(process.env.PROPERTY_RUNS ?? 25);

describe('randomized crosses', () => {
  for (let run = 0; run < RUNS; run++) {
    it(`run ${run}: matches the reference, conserves every atom, empties the vaults`, async () => {
      const r = rng(0x9e3779b9 ^ (run * 7919));
      const w = await World.create();
      const ticks = 5 + r(12);
      const minPrice = 1_000_000n;
      const tick = 50_000n;
      const reference = r(2) ? minPrice + BigInt(r(ticks)) * tick : null;
      const cross = await w.newCross({ supplyMode: SupplyMode.Escrow, disclosure: Disclosure.Sealed, ticks, tick, minPrice, shards: 1 + r(4), reference });
      const holders = [w.creator, w.feeRecipient, w.integrator];
      const orders: PlacedOrder[] = [];
      const n = 1 + r(24);
      for (let i = 0; i < n; i++) {
        const side = r(2) ? OrderSide.Buy : OrderSide.Sell;
        const price = minPrice + BigInt(r(ticks)) * tick;
        const quantity = BigInt(1 + r(5_000)) * 1_000n + BigInt(r(1_000));
        const t = side === OrderSide.Buy ? await w.trader(costCeil(quantity, price, SCALE) * 3n) : await w.trader(0n, quantity * 2n);
        holders.push(t);
        const extra = side === OrderSide.Buy ? BigInt(r(3)) * 1_000n : 0n;
        orders.push(await w.place(cross, t, side, price, quantity, { escrow: (side === OrderSide.Buy ? costCeil(quantity, price, SCALE) : quantity) + extra, reveal: r(10) !== 0 }));
      }
      const sum = async (mint: string) => (await Promise.all(holders.map((x) => w.h.balanceOf(x.address, mint as never)))).reduce((a, b) => a + b, 0n);
      const quoteBefore = (await sum(w.quoteMint)) + w.h.balance(await quoteVaultAddress(cross.address));
      const baseBefore = (await sum(w.baseMint)) + w.h.balance(await baseVaultAddress(cross.address));

      await w.revealAll(cross, orders);
      const settled = await w.settle(cross);
      const revealed = orders.filter((o) => o.reveal).map((o) => ({ side: o.side === OrderSide.Buy ? ('buy' as const) : ('sell' as const), price: o.price, quantity: o.quantity }));
      const ref = referenceClear(revealed, { min: minPrice, tick, ticks }, reference);
      if (ref === null) {
        expect(settled.data.state).toBe(CrossState.NoPrint);
      } else {
        expect(settled.data.state).toBe(CrossState.Cleared);
        const s = settled.data.clearing.__option === 'Some' ? settled.data.clearing.value : null;
        expect([s?.price, s?.matched]).toEqual([ref.price, ref.matched]);
      }

      const baseBeforeClaims = await Promise.all(orders.map((o) => w.h.balanceOf(o.owner.address, w.baseMint)));
      await w.claimAll(cross, orders);
      if (ref) {
        const fills = referenceFills(revealed, ref);
        let k = 0;
        for (const [i, o] of orders.entries()) {
          if (!o.reveal) continue;
          const fill = fills[k++]!;
          if (o.side === OrderSide.Buy) {
            expect(await w.h.balanceOf(o.owner.address, w.baseMint)).toBe(baseBeforeClaims[i]! + fill);
            // Never pays more than its limit for what it received.
            expect(costCeil(fill, ref.price, SCALE) <= costCeil(fill, o.price, SCALE)).toBe(true);
          }
        }
      }
      await w.finalize(cross);
      expect(w.h.balance(await quoteVaultAddress(cross.address))).toBe(0n);
      expect(w.h.balance(await baseVaultAddress(cross.address))).toBe(0n);
      expect(await sum(w.quoteMint)).toBe(quoteBefore);
      expect(await sum(w.baseMint)).toBe(baseBefore);
    }, 120_000);
  }
});
