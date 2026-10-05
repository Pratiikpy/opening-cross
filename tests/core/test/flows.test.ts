import { describe, expect, it } from 'vitest';
import { CrossState, Disclosure, OrderSide, SupplyMode, quoteVaultAddress, baseVaultAddress, costCeil } from '@opening-cross/sdk';
import { FEES, SCALE, World, type PlacedOrder } from '../src/world.js';
import { referenceClear, referenceFills, type RefOrder } from '../src/reference.js';

const refOf = (orders: PlacedOrder[], schedule: { price: bigint; quantity: bigint }[] = []): RefOrder[] => [
  ...orders.filter((o) => o.reveal).map((o) => ({ side: o.side === OrderSide.Buy ? ('buy' as const) : ('sell' as const), price: o.price, quantity: o.quantity })),
  ...schedule.map((s) => ({ side: 'sell' as const, price: s.price, quantity: s.quantity })),
];

describe('launch in mint mode, open book', () => {
  it('clears at one price, mints fills, splits fees, pays the issuer and revokes the mint authority', async () => {
    const w = await World.create();
    const schedule = [
      { price: 1_000_000n, quantity: 1_000_000_000n },
      { price: 1_200_000n, quantity: 1_000_000_000n },
      { price: 1_500_000n, quantity: 1_000_000_000n },
    ];
    const cross = await w.newCross({ supplyMode: SupplyMode.Mint, disclosure: Disclosure.Open, schedule });
    const a = await w.trader(10_000_000_000n);
    const b = await w.trader(10_000_000_000n);
    const c = await w.trader(10_000_000_000n);
    const orders = [
      await w.place(cross, a, OrderSide.Buy, 1_500_000n, 1_500_000_000n),
      await w.place(cross, b, OrderSide.Buy, 1_200_000n, 800_000_000n),
      await w.place(cross, c, OrderSide.Buy, 1_100_000n, 500_000_000n),
    ];
    const settled = await w.settle(cross);
    expect(settled.data.state).toBe(CrossState.Cleared);

    const grid = { min: 1_000_000n, tick: 100_000n, ticks: 20 };
    const ref = referenceClear(refOf(orders, schedule), grid, null)!;
    const summary = settled.data.clearing.__option === 'Some' ? settled.data.clearing.value : null;
    expect(summary?.price).toBe(ref.price);
    expect(summary?.matched).toBe(ref.matched);

    const fills = referenceFills(refOf(orders), ref);
    const before = await Promise.all(orders.map((o) => w.h.balanceOf(o.owner.address, w.quoteMint)));
    await w.claimAll(cross, orders);
    let paid = 0n;
    for (const [i, o] of orders.entries()) {
      const baseMint = settled.data.baseMint;
      expect(await w.h.balanceOf(o.owner.address, baseMint)).toBe(fills[i]);
      const pay = costCeil(fills[i]!, ref.price, SCALE);
      paid += pay;
      // Refund of the unused escrow lands back in the wallet.
      expect(await w.h.balanceOf(o.owner.address, w.quoteMint)).toBe(before[i]! + o.escrow - pay);
    }

    const proceedsBefore = await w.h.balanceOf(w.creator.address, w.quoteMint);
    const final = await w.finalize(cross);
    expect(final.data.state).toBe(CrossState.Finalized);
    const totalFee = (paid * BigInt(FEES[0] + 20)) / 10_000n;
    const protocolFee = (totalFee * BigInt(FEES[0])) / BigInt(FEES[0] + 20);
    expect(await w.h.balanceOf(w.feeRecipient.address, w.quoteMint)).toBe(protocolFee);
    expect(await w.h.balanceOf(w.integrator.address, w.quoteMint)).toBe(totalFee - protocolFee);
    // Issuer receives buyers' payments less fees, plus the unused dust bond back.
    expect(await w.h.balanceOf(w.creator.address, w.quoteMint)).toBe(proceedsBefore + paid - totalFee + settled.data.dustBond);
    expect(w.h.mintInfo(settled.data.baseMint).mintAuthority.__option).toBe('None');
    expect(w.h.balance(await quoteVaultAddress(cross.address))).toBe(0n);
  });
});

describe('reopen in escrow mode, sealed book', () => {
  it('reveals, clears against the reference, settles buyers and sellers and empties the vaults', async () => {
    const w = await World.create();
    const cross = await w.newCross({ supplyMode: SupplyMode.Escrow, disclosure: Disclosure.Sealed, reference: 1_500_000n, shards: 3 });
    const s1 = await w.trader(0n, 2_000_000_000n);
    const s2 = await w.trader(0n, 2_000_000_000n);
    const b1 = await w.trader(10_000_000_000n);
    const b2 = await w.trader(10_000_000_000n);
    const b3 = await w.trader(10_000_000_000n);
    const quoteTotal = 30_000_000_000n + 1_000_000_000_000n; // traders + creator
    const orders = [
      await w.place(cross, s1, OrderSide.Sell, 1_300_000n, 1_000_000_000n),
      await w.place(cross, s2, OrderSide.Sell, 1_600_000n, 1_500_000_000n),
      await w.place(cross, b1, OrderSide.Buy, 1_700_000n, 900_000_000n, { escrow: 5_000_000_000n }), // over-escrows to hide price
      await w.place(cross, b2, OrderSide.Buy, 1_500_000n, 600_000_000n),
      await w.place(cross, b3, OrderSide.Buy, 1_900_000n, 400_000_000n, { reveal: false }), // never reveals
    ];
    await w.revealAll(cross, orders);
    const settled = await w.settle(cross);
    expect(settled.data.state).toBe(CrossState.Cleared);
    const ref = referenceClear(refOf(orders), { min: 1_000_000n, tick: 100_000n, ticks: 20 }, 1_500_000n)!;
    const summary = settled.data.clearing.__option === 'Some' ? settled.data.clearing.value : null;
    expect([summary?.price, summary?.matched]).toEqual([ref.price, ref.matched]);

    await w.claimAll(cross, orders);
    // The non-revealer gets everything back.
    expect(await w.h.balanceOf(b3.address, w.quoteMint)).toBe(10_000_000_000n);
    await w.finalize(cross);
    expect(w.h.balance(await quoteVaultAddress(cross.address))).toBe(0n);
    expect(w.h.balance(await baseVaultAddress(cross.address))).toBe(0n);

    // Conservation: every quote and base atom is still owned by someone.
    const holders = [s1, s2, b1, b2, b3, w.creator, w.feeRecipient, w.integrator];
    const sum = async (mint: typeof w.quoteMint) => (await Promise.all(holders.map((x) => w.h.balanceOf(x.address, mint)))).reduce((a, b) => a + b, 0n);
    expect(await sum(w.quoteMint)).toBe(quoteTotal);
    expect(await sum(w.baseMint)).toBe(4_000_000_000n);
  });
});

describe('no print', () => {
  it('refunds every order and returns the mint authority to the issuer when nothing crosses', async () => {
    const w = await World.create();
    const schedule = [{ price: 2_000_000n, quantity: 1_000_000_000n }];
    const cross = await w.newCross({ supplyMode: SupplyMode.Mint, schedule });
    const a = await w.trader(10_000_000_000n);
    const o = await w.place(cross, a, OrderSide.Buy, 1_500_000n, 1_000_000_000n);
    const settled = await w.settle(cross);
    expect(settled.data.state).toBe(CrossState.NoPrint);
    await w.claimAll(cross, [o]);
    expect(await w.h.balanceOf(a.address, w.quoteMint)).toBe(10_000_000_000n);
    await w.finalize(cross);
    const auth = w.h.mintInfo(settled.data.baseMint).mintAuthority;
    expect(auth.__option === 'Some' && auth.value).toBe(w.creator.address);
  });

  it('does not print below the minimum volume guard', async () => {
    const w = await World.create();
    const cross = await w.newCross({ minMatched: 5_000_000_000n });
    const s = await w.trader(0n, 1_000_000_000n);
    const b = await w.trader(10_000_000_000n);
    const orders = [await w.place(cross, s, OrderSide.Sell, 1_000_000n, 1_000_000_000n), await w.place(cross, b, OrderSide.Buy, 1_000_000n, 1_000_000_000n)];
    const settled = await w.settle(cross);
    expect(settled.data.state).toBe(CrossState.NoPrint);
    await w.claimAll(cross, orders);
    expect(await w.h.balanceOf(b.address, w.quoteMint)).toBe(10_000_000_000n);
    expect(await w.h.balanceOf(s.address, w.baseMint)).toBe(1_000_000_000n);
  });
});
