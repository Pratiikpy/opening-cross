// ADR-0025: `finalize` on an escrow-mode cross refuses a call that leaves out the accounts which
// sweep base dust, instead of finalizing and stranding the dust in the base vault.
//
// The book is vector E2 of docs/spec/OCIP-1.md §16 (sell side rationed, rounding up): buyers take 12
// base atoms and sellers give 13, so one atom of base dust remains in the vault after every claim.
import { describe, expect, it } from 'vitest';
import { type CrossView, CrossKind, CrossState, OrderSide, baseVaultAddress, buildFinalize, getFinalizeInstruction, quoteVaultAddress, ata } from '@opening-cross/sdk';
import { World, type PlacedOrder } from '../src/world.js';

const GRID = { minPrice: 90_000_000n, tick: 1_000_000n, ticks: 21, reference: 100_000_000n, maxOrders: 100, integratorFeeBps: 100 };

/** A `finalize` as a careless client would send it: the dust accounts (`base_mint`, `proceeds_base`) left out, and the
 *  base vault too unless `withVault`. */
async function finalizeWithout(w: World, cross: CrossView, withVault: boolean) {
  const c = cross.data;
  return getFinalizeInstruction({
    payer: w.admin,
    cross: cross.address,
    ...(withVault ? { baseVault: await baseVaultAddress(cross.address) } : {}),
    quoteMint: c.quoteMint,
    quoteVault: await quoteVaultAddress(cross.address),
    feeRecipientQuote: await ata(c.feeRecipient, c.quoteMint, c.quoteTokenProgram),
    integratorQuote: await ata(c.integrator, c.quoteMint, c.quoteTokenProgram),
    proceedsQuote: await ata(c.proceedsTo, c.quoteMint, c.quoteTokenProgram),
    baseTokenProgram: c.baseTokenProgram,
    quoteTokenProgram: c.quoteTokenProgram,
  });
}

/** Builds E2 and claims every order. Returns the world, the settled cross and the orders. */
async function claimedE2(withDust: boolean) {
  const w = await World.create();
  const cross = await w.newCross({ kind: CrossKind.Reopen, ...GRID });
  const buyers = [await w.trader(10_000n), await w.trader(10_000n)];
  const sellers = [await w.trader(0n, 100n), await w.trader(0n, 100n), await w.trader(0n, 100n), await w.trader(0n, 100n)];
  const orders: PlacedOrder[] = [];
  if (withDust) {
    orders.push(await w.place(cross, buyers[0]!, OrderSide.Buy, 101_000_000n, 5n));
    orders.push(await w.place(cross, buyers[1]!, OrderSide.Buy, 100_000_000n, 7n));
    orders.push(await w.place(cross, sellers[0]!, OrderSide.Sell, 99_000_000n, 4n));
    orders.push(await w.place(cross, sellers[1]!, OrderSide.Sell, 100_000_000n, 5n));
    orders.push(await w.place(cross, sellers[2]!, OrderSide.Sell, 100_000_000n, 7n));
    orders.push(await w.place(cross, sellers[3]!, OrderSide.Sell, 100_000_000n, 11n));
  } else {
    // One buyer and one seller for the same quantity: nothing is rationed, so no dust.
    orders.push(await w.place(cross, buyers[0]!, OrderSide.Buy, 101_000_000n, 5n));
    orders.push(await w.place(cross, sellers[0]!, OrderSide.Sell, 99_000_000n, 5n));
  }
  const settled = await w.settle(cross);
  expect(settled.data.state).toBe(CrossState.Cleared);
  await w.claimAll(settled, orders);
  return { w, cross: w.view(cross.address) };
}

describe('finalize sweeps base dust or refuses (ADR-0025)', () => {
  it('refuses to finalize a cross holding base dust when the dust accounts are omitted', async () => {
    const { w, cross } = await claimedE2(true);
    expect(cross.data.baseSold - cross.data.baseBought).toBe(1n);
    const baseVault = await baseVaultAddress(cross.address);
    expect(w.h.balance(baseVault)).toBe(1n);

    const c = cross.data;
    const bare = await finalizeWithout(w, cross, false);
    expect(await w.h.fail([bare], w.admin)).toContain('BaseDustAccountsMissing');
    // Nothing moved and the cross is still open to a correct call.
    expect(w.view(cross.address).data.state).toBe(CrossState.Cleared);
    expect(w.h.balance(baseVault)).toBe(1n);

    // The vault alone is not enough: all three base accounts are required.
    const vaultOnly = await finalizeWithout(w, cross, true);
    expect(await w.h.fail([vaultOnly], w.admin)).toContain('BaseDustAccountsMissing');

    // The SDK builder supplies everything: the dust reaches proceeds_to and the vault empties.
    const before = await w.h.balanceOf(c.proceedsTo, c.baseMint);
    await w.h.send([await buildFinalize(cross, w.admin)], w.admin);
    expect(w.view(cross.address).data.state).toBe(CrossState.Finalized);
    expect(w.h.balance(baseVault)).toBe(0n);
    expect(await w.h.balanceOf(c.proceedsTo, c.baseMint)).toBe(before + 1n);
  });

  it('still accepts a call without the dust accounts when the cross holds no dust', async () => {
    const { w, cross } = await claimedE2(false);
    expect(cross.data.baseSold - cross.data.baseBought).toBe(0n);
    const c = cross.data;
    const bare = await finalizeWithout(w, cross, false);
    await w.h.send([bare], w.admin);
    expect(w.view(cross.address).data.state).toBe(CrossState.Finalized);
  });

  it('still accepts a call without the dust accounts on a cross that did not print', async () => {
    const w = await World.create();
    const cross = await w.newCross({ kind: CrossKind.Reopen, ...GRID });
    const settled = await w.settle(cross); // no orders: nothing to match
    expect(settled.data.state).toBe(CrossState.NoPrint);
    const c = settled.data;
    const bare = await finalizeWithout(w, cross, false);
    await w.h.send([bare], w.admin);
    expect(w.view(cross.address).data.state).toBe(CrossState.Finalized);
  });
});
