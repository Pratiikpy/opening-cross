// Pushed refunds (ADR-0457): one transaction returns the escrow of many orders to their owners, and only refunds.
import { describe, expect, it } from 'vitest';
import { CrossState, Disclosure, OrderSide, SupplyMode, baseVaultAddress, orderAddress, quoteVaultAddress } from '@opening-cross/sdk';
import { RulesWorld } from '../src/rules-world.js';
import type { PlacedOrder } from '../src/world.js';

async function noCrossBook() {
  const w = await RulesWorld.createRules();
  // Buyers bid below every seller's ask: nothing crosses.
  const cross = await w.newRuledCross({ supplyMode: SupplyMode.Escrow, disclosure: Disclosure.Open, reference: 1_500_000n });
  const orders: PlacedOrder[] = [];
  for (let i = 0; i < 3; i++) orders.push(await w.place(cross, await w.trader(0n, 500_000_000n), OrderSide.Sell, 1_800_000n, 100_000_000n));
  for (let i = 0; i < 3; i++) orders.push(await w.place(cross, await w.trader(500_000_000n), OrderSide.Buy, 1_200_000n, 100_000_000n));
  return { w, cross, orders };
}

describe('push_refunds', () => {
  it('returns every order of a cross that did not print in one transaction, and the cross then finalizes', async () => {
    const { w, cross, orders } = await noCrossBook();
    const settled = await w.settle(cross);
    expect(settled.data.state).toBe(CrossState.NoPrint);
    const before = await Promise.all(orders.map((o) => w.h.balanceOf(o.owner.address, o.side === OrderSide.Buy ? w.quoteMint : w.baseMint)));
    const payer = await w.h.wallet();
    await w.h.send([await w.pushRefundsIx(w.view(cross.address), orders)], payer);
    for (const [i, o] of orders.entries()) {
      const mint = o.side === OrderSide.Buy ? w.quoteMint : w.baseMint;
      expect(await w.h.balanceOf(o.owner.address, mint)).toBe(before[i]! + o.escrow);
      expect(w.h.svm.getAccount(await orderAddress(cross.address, o.owner.address, o.nonce)).exists).toBe(false);
    }
    expect(w.view(cross.address).data.ordersOpen).toBe(0);
    const final = await w.finalize(w.view(cross.address));
    expect(final.data.state).toBe(CrossState.Finalized);
    expect(w.h.balance(await quoteVaultAddress(cross.address))).toBe(0n);
    expect(w.h.balance(await baseVaultAddress(cross.address))).toBe(0n);
  });

  it('refunds the unfilled orders of a printed cross and leaves the filled ones to claim', async () => {
    const w = await RulesWorld.createRules();
    const cross = await w.newRuledCross({ supplyMode: SupplyMode.Escrow, disclosure: Disclosure.Sealed, reference: 1_500_000n });
    const seller = await w.place(cross, await w.trader(0n, 500_000_000n), OrderSide.Sell, 1_400_000n, 100_000_000n);
    const buyer = await w.place(cross, await w.trader(500_000_000n), OrderSide.Buy, 1_600_000n, 100_000_000n);
    const pricedOut = await w.place(cross, await w.trader(500_000_000n), OrderSide.Buy, 1_000_000n, 100_000_000n);
    const hidden = await w.place(cross, await w.trader(500_000_000n), OrderSide.Buy, 1_700_000n, 100_000_000n, { reveal: false });
    await w.revealAll(cross, [seller, buyer, pricedOut, hidden]);
    const settled = await w.settle(cross);
    expect(settled.data.state).toBe(CrossState.Cleared);
    const payer = await w.h.wallet();
    // A filled order cannot be pushed, and the failure leaves the others untouched.
    expect(await w.h.fail([await w.pushRefundsIx(w.view(cross.address), [pricedOut, hidden, buyer])], payer)).toMatch(/NotRefundOnly/);
    expect(w.h.svm.getAccount(await orderAddress(cross.address, pricedOut.owner.address, pricedOut.nonce)).exists).toBe(true);
    await w.h.send([await w.pushRefundsIx(w.view(cross.address), [pricedOut, hidden])], payer);
    expect(await w.h.balanceOf(pricedOut.owner.address, w.quoteMint)).toBe(500_000_000n);
    expect(await w.h.balanceOf(hidden.owner.address, w.quoteMint)).toBe(500_000_000n);
    await w.claimAll(w.view(cross.address), [seller, buyer]);
    const final = await w.finalize(w.view(cross.address));
    expect(final.data.state).toBe(CrossState.Finalized);
    expect(w.h.balance(await quoteVaultAddress(cross.address))).toBe(0n);
  });

  it('cannot be pointed at the wrong money', async () => {
    const { w, cross, orders } = await noCrossBook();
    await w.settle(cross);
    const view = () => w.view(cross.address);
    const payer = await w.h.wallet();
    const [sell, buy] = [orders[0]!, orders[3]!];
    const buyBefore = await w.h.balanceOf(buy.owner.address, w.quoteMint);
    const thief = await w.h.wallet();
    const thiefQuote = await w.h.ata(thief.address, w.quoteMint, w.admin);
    // Somebody else's token account.
    expect(await w.h.fail([await w.pushRefundsIx(view(), [buy], { dest: [thiefQuote] })], payer)).toMatch(/Unauthorized/);
    // The owner's own account for the wrong mint (quote for a sell, base for a buy).
    const ownerQuote = await w.h.ata(sell.owner.address, w.quoteMint, w.admin);
    const ownerBase = await w.h.ata(buy.owner.address, w.baseMint, w.admin);
    expect(await w.h.fail([await w.pushRefundsIx(view(), [sell], { dest: [ownerQuote] })], payer)).toMatch(/WrongMint/);
    expect(await w.h.fail([await w.pushRefundsIx(view(), [buy], { dest: [ownerBase] })], payer)).toMatch(/WrongMint/);
    // An order of another cross.
    const other = await w.newRuledCross({ supplyMode: SupplyMode.Escrow, reference: 1_500_000n });
    const stray = await w.place(other, await w.trader(500_000_000n), OrderSide.Buy, 1_200_000n, 100_000_000n);
    const mixed = await w.pushRefundsIx(view(), [buy]);
    const strayIx = await w.pushRefundsIx(w.view(other.address), [stray]);
    const crossWithStray = { ...mixed, accounts: [...(mixed.accounts ?? []).slice(0, -3), ...(strayIx.accounts ?? []).slice(-3)] };
    expect(await w.h.fail([crossWithStray], payer)).toMatch(/WrongCross/);
    // The same order twice, none, a count that is not a multiple of three, thirteen.
    expect(await w.h.fail([await w.pushRefundsIx(view(), [buy, buy])], payer)).toMatch(/AccountOwnedByWrongProgram|3007|AccountNotInitialized|3012/);
    const bare = await w.pushRefundsIx(view(), []);
    expect(await w.h.fail([bare], payer)).toMatch(/InvalidParams/);
    const one = await w.pushRefundsIx(view(), [buy]);
    expect(await w.h.fail([{ ...one, accounts: (one.accounts ?? []).slice(0, -1) }], payer)).toMatch(/InvalidParams/);
    const many = await w.pushRefundsIx(view(), Array.from({ length: 13 }, () => buy));
    expect(await w.h.fail([many], payer)).toMatch(/InvalidParams/);
    // Nothing above moved a token.
    expect(await w.h.balanceOf(buy.owner.address, w.quoteMint)).toBe(buyBefore);
    expect(await w.h.balanceOf(thief.address, w.quoteMint)).toBe(0n);
    // A live cross refuses.
    const live = await w.newRuledCross({ supplyMode: SupplyMode.Escrow });
    const lo = await w.place(live, await w.trader(500_000_000n), OrderSide.Buy, 1_200_000n, 100_000_000n);
    expect(await w.h.fail([await w.pushRefundsIx(w.view(live.address), [lo])], payer)).toMatch(/WrongState/);
    // The right call still works.
    await w.h.send([await w.pushRefundsIx(view(), [sell, buy])], payer);
  });
});
