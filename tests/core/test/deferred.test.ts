// Deferred-mint launches (ADR-0006): the base mint is created after the clear by a registered
// settler and bound to the cross; until then claims wait, and past the deadline anyone can
// abandon settlement so every bidder is refunded.
import { describe, expect, it } from 'vitest';
import { CrossState, OrderSide, SupplyMode, getAbandonSettlementInstruction, getBindBaseMintInstruction } from '@opening-cross/sdk';
import { World } from '../src/world.js';

const schedule = [{ price: 1_000_000n, quantity: 2_000_000_000n }];

async function setup(w: World) {
  const settler = await w.h.wallet();
  const cross = await w.newCross({ supplyMode: SupplyMode.DeferredMint, schedule, settler: settler.address, settleDeadlineTs: 1_800_000_500n });
  const b = await w.trader(10_000_000_000n);
  const o = await w.place(cross, b, OrderSide.Buy, 1_200_000n, 1_000_000_000n);
  const settled = await w.settle(cross);
  return { settler, cross: settled, b, o };
}

describe('deferred-mint launch', () => {
  it('clears without a base mint, refuses claims until bound, then mints fills at P*', async () => {
    const w = await World.create();
    const { settler, cross, b, o } = await setup(w);
    expect(cross.data.state).toBe(CrossState.Cleared);
    expect(cross.data.baseBound).toBe(false);
    expect(await w.h.fail(await (await import('@opening-cross/sdk')).buildClaim(cross, w.admin, b.address, o.nonce), w.admin)).toContain('SettlementPending');

    // The settler creates the mint (here directly; on devnet the DBC adapter does this) and
    // hands its authority to the cross.
    const base = await w.h.mint(settler, 6);
    await w.h.setMintAuthority(base, settler, cross.address);
    await w.h.send([getBindBaseMintInstruction({ settler, cross: cross.address, baseMint: base })], settler);
    const bound = w.view(cross.address);
    expect(bound.data.baseBound).toBe(true);
    await w.claimAll(bound, [o]);
    expect(await w.h.balanceOf(b.address, base)).toBe(1_000_000_000n);
    await w.finalize(bound);
    expect(w.h.mintInfo(base).mintAuthority.__option).toBe('None');
  });

  it('only the registered settler can bind, and only a mint the cross controls', async () => {
    const w = await World.create();
    const { settler, cross } = await setup(w);
    const mallory = await w.h.wallet();
    const base = await w.h.mint(mallory, 6);
    await w.h.setMintAuthority(base, mallory, cross.address);
    expect(await w.h.fail([getBindBaseMintInstruction({ settler: mallory, cross: cross.address, baseMint: base })], mallory)).toContain('NotSettler');
    const own = await w.h.mint(settler, 6); // authority still with the settler
    expect(await w.h.fail([getBindBaseMintInstruction({ settler, cross: cross.address, baseMint: own })], settler)).toContain('MintAuthorityNotCross');
    expect(await w.h.fail([getBindBaseMintInstruction({ settler, cross: cross.address, baseMint: w.quoteMint })], settler)).toMatch(/InvalidParams|MintAuthorityNotCross/);
  });

  it('abandoned settlement refunds every bidder after the deadline, never before', async () => {
    const w = await World.create();
    const { cross, b, o } = await setup(w);
    expect(await w.h.fail([getAbandonSettlementInstruction({ cross: cross.address })], w.admin)).toContain('DeadlineNotReached');
    w.h.setTime(1_800_000_500n);
    await w.h.send([getAbandonSettlementInstruction({ cross: cross.address })], w.admin);
    expect(w.view(cross.address).data.state).toBe(CrossState.NoPrint);
    await w.claimAll(w.view(cross.address), [o]);
    expect(await w.h.balanceOf(b.address, w.quoteMint)).toBe(10_000_000_000n);
    const final = await w.finalize(w.view(cross.address));
    expect(final.data.state).toBe(CrossState.Finalized);
  });

  // ADR-0026: the deadline splits time exactly in two. Before it only the settler can settle; from it on only
  // abandonment can run, so the outcome never depends on which transaction lands first.
  it('binds up to the last second before the deadline and not at or after it', async () => {
    const w = await World.create();
    const { settler, cross, b, o } = await setup(w);
    w.h.setTime(1_800_000_499n);
    const base = await w.h.mint(settler, 6);
    await w.h.setMintAuthority(base, settler, cross.address);
    await w.h.send([getBindBaseMintInstruction({ settler, cross: cross.address, baseMint: base })], settler);
    expect(w.view(cross.address).data.baseBound).toBe(true);
    await w.claimAll(w.view(cross.address), [o]);
    expect(await w.h.balanceOf(b.address, base)).toBe(1_000_000_000n);
  });

  it('refuses to bind from the deadline on, and abandonment then decides the outcome', async () => {
    const w = await World.create();
    const { settler, cross, b, o } = await setup(w);
    const base = await w.h.mint(settler, 6);
    await w.h.setMintAuthority(base, settler, cross.address);
    const bind = getBindBaseMintInstruction({ settler, cross: cross.address, baseMint: base });
    w.h.setTime(1_800_000_500n); // exactly the deadline: abandon_settlement would succeed here
    expect(await w.h.fail([bind], settler)).toContain('SettlementDeadlinePassed');
    w.h.setTime(1_800_009_999n); // long after, and nobody has abandoned yet
    expect(await w.h.fail([bind], settler)).toContain('SettlementDeadlinePassed');
    expect(w.view(cross.address).data.baseBound).toBe(false);
    await w.h.send([getAbandonSettlementInstruction({ cross: cross.address })], w.admin);
    expect(w.view(cross.address).data.state).toBe(CrossState.NoPrint);
    await w.claimAll(w.view(cross.address), [o]);
    expect(await w.h.balanceOf(b.address, w.quoteMint)).toBe(10_000_000_000n);
  });

  it('rejects inconsistent deferred configurations', async () => {
    const w = await World.create();
    await expect(w.newCross({ supplyMode: SupplyMode.DeferredMint, schedule })).rejects.toThrow(/InvalidParams/); // no settler
    const s = await w.h.wallet();
    await expect(w.newCross({ supplyMode: SupplyMode.DeferredMint, schedule, settler: s.address, settleDeadlineTs: 1_800_000_050n })).rejects.toThrow(/InvalidTimeline/); // before the call closes
    await expect(w.newCross({ settler: s.address })).rejects.toThrow(/InvalidParams/); // settler on an escrow cross
  });
});
