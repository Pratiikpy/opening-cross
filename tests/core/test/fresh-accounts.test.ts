// Accounts a real deployment does not have yet. The harness prepares every token account up front, which hid two failures that
// a live devnet deployment hit at once: an issuer who has never held the quote token could not create a cross (create_cross
// reads the creator's quote account), and no cross on a quote mint the fee recipient had never held could be finalized (the fee,
// integrator and proceeds accounts did not exist), so a keeper retried it forever. Here the quote and base mints are new, and
// neither the issuer, the integrator nor the fee recipient owns any account for them.
import { describe, expect, it } from 'vitest';
import { TOKEN_2022_PROGRAM_ADDRESS, findAssociatedTokenPda } from '@solana-program/token-2022';
import type { Address } from '@solana/kit';
import { CrossState, Disclosure, OrderSide, SupplyMode, buildCreateCross, buildFinalize, buildFinalizeWithAccounts, buildMissingShards, shardAddress } from '@opening-cross/sdk';
import { CrossKind } from '@opening-cross/cross-core-client';
import { SCALE, World } from '../src/world.js';
import { T0 } from '../src/harness.js';

describe('a cross whose token accounts do not exist yet', () => {
  it('is created by an issuer with no quote account and finalized into fee accounts that did not exist', async () => {
    const w = await World.create();
    w.quoteMint = await w.h.mint(w.admin, 6);
    w.baseMint = await w.h.mint(w.admin, 6);
    const issuer = await w.h.wallet(100n);
    const taken = async (owner: Address, mint: Address) => w.h.exists((await findAssociatedTokenPda({ owner, mint, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS }))[0]);
    expect(await taken(issuer.address, w.quoteMint)).toBe(false);
    expect(await taken(w.feeRecipient.address, w.quoteMint)).toBe(false);

    const { cross, create, shards, ensureCreatorQuote } = await buildCreateCross({
      creator: issuer,
      baseMint: w.baseMint,
      quoteMint: w.quoteMint,
      baseTokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
      quoteTokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
      crossId: 1n,
      kind: CrossKind.Launch,
      supplyMode: SupplyMode.Escrow,
      disclosure: Disclosure.Open,
      minPrice: 1_000_000n,
      tick: 100_000n,
      ticks: 20,
      priceScale: SCALE,
      openTs: T0,
      closeTs: T0 + 100n,
      revealEndTs: T0 + 100n,
      referencePrice: null,
      minMatched: 0n,
      maxImbalanceBps: null,
      integratorFeeBps: 20,
      integrator: w.integrator.address,
      gateMint: null,
      shards: 1,
      maxOrders: 8,
      proceedsTo: issuer.address,
      schedule: [],
      oracle: null,
      calendar: null,
      settler: null,
      settleDeadlineTs: 0n,
    });
    // Without the idempotent account creation the program refuses, which is what the console showed an issuer.
    expect(await w.h.fail([create], issuer)).toContain('creator_quote');
    // The creator also pays a small dust bond (ADR-0003) from that account, so it needs the account and a few quote atoms.
    await w.h.send([ensureCreatorQuote], issuer);
    await w.h.fund(w.quoteMint, w.admin, issuer.address, 1_000_000n);
    await w.h.send([ensureCreatorQuote, create], issuer);
    for (const s of shards) await w.h.send([s], issuer);
    w.h.setTime(T0);

    const seller = await w.trader(0n, 2_000_000_000n);
    const buyer = await w.trader(10_000_000_000n);
    const open = w.view(cross);
    const orders = [await w.place(open, seller, OrderSide.Sell, 1_100_000n, 2_000_000_000n), await w.place(open, buyer, OrderSide.Buy, 1_300_000n, 1_000_000_000n)];
    const settled = await w.settle(open);
    expect(settled.data.state).toBe(CrossState.Cleared);
    await w.claimAll(settled, orders);

    // The plain instruction still needs the accounts; the builder the keeper and the API use creates them.
    expect(await w.h.fail([await buildFinalize(w.view(cross), w.admin)], w.admin)).toContain('AccountNotInitialized');
    await w.h.send(await buildFinalizeWithAccounts(w.view(cross), w.admin), w.admin);
    expect(w.view(cross).data.state).toBe(CrossState.Finalized);
    expect(await w.h.balanceOf(w.feeRecipient.address, w.quoteMint)).toBeGreaterThan(0n);
    for (const owner of [w.feeRecipient.address, w.integrator.address, issuer.address]) expect(await taken(owner, w.quoteMint)).toBe(true);
  });

  it('finishes a cross whose create stopped after the first shard transaction', async () => {
    const w = await World.create();
    const issuer = w.creator;
    const { cross, create, shards } = await buildCreateCross({
      creator: issuer,
      baseMint: w.baseMint,
      quoteMint: w.quoteMint,
      baseTokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
      quoteTokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
      crossId: 9n,
      kind: CrossKind.Launch,
      supplyMode: SupplyMode.Escrow,
      disclosure: Disclosure.Open,
      minPrice: 1_000_000n,
      tick: 100_000n,
      ticks: 20,
      priceScale: SCALE,
      openTs: T0,
      closeTs: T0 + 100n,
      revealEndTs: T0 + 100n,
      referencePrice: null,
      minMatched: 0n,
      maxImbalanceBps: null,
      integratorFeeBps: 0,
      integrator: issuer.address,
      gateMint: null,
      shards: 3,
      maxOrders: 8,
      proceedsTo: issuer.address,
      schedule: [],
      oracle: null,
      calendar: null,
      settler: null,
      settleDeadlineTs: 0n,
    });
    await w.h.send([create], issuer);
    await w.h.send([shards[0]!], issuer); // the connection drops here: two shards were never created
    const exists = async (a: Address) => w.h.exists(a);
    const stranger = await w.h.wallet(); // init_shard has no authority check: anyone may pay
    const missing = await buildMissingShards(w.view(cross), stranger, exists);
    expect(missing).toHaveLength(2);
    for (const ix of missing) await w.h.send([ix], stranger);
    for (let i = 0; i < 3; i++) expect(w.h.exists(await shardAddress(cross, i))).toBe(true);
    expect(await buildMissingShards(w.view(cross), stranger, exists)).toHaveLength(0);
  });
});
