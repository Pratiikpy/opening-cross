// Every way a user, cranker or attacker can misuse cross_core, and the exact refusal expected.
import { describe, expect, it } from 'vitest';
import { TOKEN_2022_PROGRAM_ADDRESS } from '@solana-program/token-2022';
import {
  CrossState,
  Disclosure,
  OrderSide,
  SupplyMode,
  bookAddress,
  buildClaim,
  buildFinalize,
  buildPlaceOrder,
  buildReveal,
  buildSettleBook,
  getClearInstruction,
  getMergeShardInstruction,
  getSetPausedInstruction,
  protocolAddress,
  shardAddress,
} from '@opening-cross/sdk';
import {
  Mode,
  findConfigPda,
  getCreateConfigInstruction,
  getGrantPassInstruction,
} from '@opening-cross/cross-gate-client';
import { World } from '../src/world.js';
import { salt } from '../src/harness.js';

describe('order entry', () => {
  it('refuses orders before the call opens and after it closes', async () => {
    const w = await World.create();
    const cross = await w.newCross();
    const b = await w.trader(10_000_000_000n);
    w.h.setTime(cross.data.openTs - 1n);
    expect(await w.h.fail([await buildPlaceOrder({ cross: w.view(cross.address), owner: b, nonce: 1n, side: OrderSide.Buy, price: 1_000_000n, quantity: 1_000n })], b)).toContain('NotInCallWindow');
    w.h.setTime(cross.data.closeTs);
    expect(await w.h.fail([await buildPlaceOrder({ cross: w.view(cross.address), owner: b, nonce: 1n, side: OrderSide.Buy, price: 1_000_000n, quantity: 1_000n })], b)).toContain('NotInCallWindow');
  });

  it('refuses prices off the grid and escrow that does not cover the order', async () => {
    const w = await World.create();
    const cross = await w.newCross();
    const b = await w.trader(10_000_000_000n);
    expect(await w.h.fail([await buildPlaceOrder({ cross, owner: b, nonce: 1n, side: OrderSide.Buy, price: 1_050_000n, quantity: 1_000n })], b)).toContain('OffGrid');
    expect(await w.h.fail([await buildPlaceOrder({ cross, owner: b, nonce: 1n, side: OrderSide.Buy, price: 999_999n, quantity: 1_000n })], b)).toContain('OffGrid');
    expect(await w.h.fail([await buildPlaceOrder({ cross, owner: b, nonce: 1n, side: OrderSide.Buy, price: 1_000_000n, quantity: 1_000_000n, escrow: 999_999n })], b)).toContain('InsufficientEscrow');
  });

  it('refuses sell orders in mint mode', async () => {
    const w = await World.create();
    const cross = await w.newCross({ supplyMode: SupplyMode.Mint, schedule: [{ price: 1_000_000n, quantity: 1_000n }] });
    const s = await w.trader();
    await w.h.ata(s.address, cross.data.baseMint, w.admin); // so the account checks pass and the rule itself is exercised
    expect(await w.h.fail([await buildPlaceOrder({ cross, owner: s, nonce: 1n, side: OrderSide.Sell, price: 1_000_000n, quantity: 1_000n })], s)).toContain('SellsNotAccepted');
  });

  it('enforces the order cap', async () => {
    const w = await World.create();
    const cross = await w.newCross({ maxOrders: 1 });
    const b = await w.trader(10_000_000_000n);
    await w.place(cross, b, OrderSide.Buy, 1_000_000n, 1_000n);
    expect(await w.h.fail([await buildPlaceOrder({ cross: w.view(cross.address), owner: b, nonce: 9n, side: OrderSide.Buy, price: 1_000_000n, quantity: 1_000n })], b)).toContain('CrossFull');
  });

  it('cancel returns the full escrow and removes the order from the book', async () => {
    const w = await World.create();
    const cross = await w.newCross();
    const s = await w.trader(0n, 1_000_000_000n);
    const b = await w.trader(10_000_000_000n);
    const sell = await w.place(cross, s, OrderSide.Sell, 1_000_000n, 1_000_000_000n);
    const buy = await w.place(cross, b, OrderSide.Buy, 1_000_000n, 1_000_000_000n);
    await w.cancel(cross, buy);
    expect(await w.h.balanceOf(b.address, w.quoteMint)).toBe(10_000_000_000n);
    const settled = await w.settle(cross);
    expect(settled.data.state).toBe(CrossState.NoPrint); // the only buy was cancelled
    await w.claimAll(cross, [sell]);
    expect(await w.h.balanceOf(s.address, w.baseMint)).toBe(1_000_000_000n);
  });

  it('cancel is refused after the call closes', async () => {
    const w = await World.create();
    const cross = await w.newCross();
    const b = await w.trader(10_000_000_000n);
    const o = await w.place(cross, b, OrderSide.Buy, 1_000_000n, 1_000n);
    w.h.setTime(cross.data.closeTs);
    await expect(w.cancel(cross, o)).rejects.toThrow(/NotInCallWindow/);
  });
});

describe('sealed reveal', () => {
  it('rejects a reveal that does not match the commitment, and reveals outside the window', async () => {
    const w = await World.create();
    const cross = await w.newCross({ disclosure: Disclosure.Sealed });
    const b = await w.trader(10_000_000_000n);
    const o = await w.place(cross, b, OrderSide.Buy, 1_200_000n, 1_000_000n, { escrow: 5_000_000n });
    // Too early: still in the call window.
    expect(await w.h.fail([await buildReveal(w.view(cross.address), b, o.nonce, o.index, o.price, o.quantity, o.salt)], b)).toContain('NotInRevealWindow');
    w.h.setTime(cross.data.closeTs + 1n);
    expect(await w.h.fail([await buildReveal(w.view(cross.address), b, o.nonce, o.index, 1_300_000n, o.quantity, o.salt)], b)).toContain('CommitmentMismatch');
    expect(await w.h.fail([await buildReveal(w.view(cross.address), b, o.nonce, o.index, o.price, o.quantity, salt())], b)).toContain('CommitmentMismatch');
    // Escrow too small for the true order: commitments can hide the price but not underfund it.
    const c2 = await w.trader(10_000_000_000n);
    w.h.setTime(cross.data.openTs);
    const under = await w.place(cross, c2, OrderSide.Buy, 1_900_000n, 10_000_000n, { escrow: 1_000_000n });
    w.h.setTime(cross.data.closeTs + 1n);
    expect(await w.h.fail([await buildReveal(w.view(cross.address), c2, under.nonce, under.index, under.price, under.quantity, under.salt)], c2)).toContain('InsufficientEscrow');
    // The honest reveal works once, and only once.
    await w.h.send([await buildReveal(w.view(cross.address), b, o.nonce, o.index, o.price, o.quantity, o.salt)], b);
    expect(await w.h.fail([await buildReveal(w.view(cross.address), b, o.nonce, o.index, o.price, o.quantity, o.salt)], b)).toContain('AlreadyRevealed');
    // After the reveal window closes, reveals are refused.
    w.h.setTime(cross.data.revealEndTs);
    expect(await w.h.fail([await buildReveal(w.view(cross.address), b, o.nonce, o.index, o.price, o.quantity, o.salt)], b)).toMatch(/NotInRevealWindow|AlreadyRevealed/);
  });

  it('nobody else can reveal or cancel your order', async () => {
    const w = await World.create();
    const cross = await w.newCross({ disclosure: Disclosure.Sealed });
    const b = await w.trader(10_000_000_000n);
    const mallory = await w.trader(10_000_000_000n);
    const o = await w.place(cross, b, OrderSide.Buy, 1_200_000n, 1_000_000n, { escrow: 5_000_000n });
    w.h.setTime(cross.data.closeTs + 1n);
    // Mallory signs as owner of an order that is not hers: the PDA derivation does not match.
    const forged = await buildReveal(w.view(cross.address), mallory, o.nonce, o.index, o.price, o.quantity, o.salt);
    expect(await w.h.fail([forged], mallory)).toMatch(/AccountNotInitialized|ConstraintHasOne|Unauthorized/);
  });
});

describe('book settlement', () => {
  it('cannot clear before every shard is merged, or merge a shard twice', async () => {
    const w = await World.create();
    const cross = await w.newCross({ shards: 3 });
    w.h.setTime(cross.data.revealEndTs + 1n);
    const book = await bookAddress(cross.address);
    expect(await w.h.fail([getClearInstruction({ cross: cross.address, book })], w.admin)).toContain('ShardsNotMerged');
    const merge0 = getMergeShardInstruction({ cross: cross.address, book, shard: await shardAddress(cross.address, 0) });
    await w.h.send([merge0], w.admin);
    expect(await w.h.fail([merge0], w.admin)).toContain('AlreadyMerged');
  });

  it('cannot merge before the reveal window ends', async () => {
    const w = await World.create();
    const cross = await w.newCross({ disclosure: Disclosure.Sealed });
    w.h.setTime(cross.data.closeTs + 1n);
    const [merge] = await buildSettleBook(cross);
    expect(await w.h.fail([merge!], w.admin)).toContain('CallNotOver');
  });

  it('cannot claim before the clear or finalize with orders outstanding', async () => {
    const w = await World.create();
    const cross = await w.newCross();
    const b = await w.trader(10_000_000_000n);
    const o = await w.place(cross, b, OrderSide.Buy, 1_000_000n, 1_000n);
    expect(await w.h.fail([await buildClaim(w.view(cross.address), w.admin, b.address, o.nonce)], w.admin)).toContain('WrongState');
    await w.settle(cross);
    expect(await w.h.fail([await buildFinalize(w.view(cross.address), w.admin)], w.admin)).toContain('OrdersOutstanding');
  });

  it('a claim pays the owner even when cranked by a stranger, and only once', async () => {
    const w = await World.create();
    const cross = await w.newCross();
    const s = await w.trader(0n, 1_000_000_000n);
    const b = await w.trader(10_000_000_000n);
    const orders = [await w.place(cross, s, OrderSide.Sell, 1_000_000n, 1_000_000_000n), await w.place(cross, b, OrderSide.Buy, 1_000_000n, 1_000_000_000n)];
    await w.settle(cross);
    const stranger = await w.trader();
    await w.claimAll(cross, orders, stranger);
    expect(await w.h.balanceOf(b.address, w.baseMint)).toBe(1_000_000_000n);
    expect(await w.h.balanceOf(stranger.address, w.baseMint)).toBe(0n);
    expect(await w.h.fail([await buildClaim(w.view(cross.address), stranger, b.address, orders[1]!.nonce)], stranger)).toMatch(/AccountNotInitialized/);
  });
});

describe('pause', () => {
  it('blocks new orders but never claims or refunds', async () => {
    const w = await World.create();
    const cross = await w.newCross();
    const b = await w.trader(10_000_000_000n);
    const o = await w.place(cross, b, OrderSide.Buy, 1_000_000n, 1_000n);
    await w.h.send([getSetPausedInstruction({ signer: w.guardian, protocol: await protocolAddress(), paused: true })], w.guardian);
    expect(await w.h.fail([await buildPlaceOrder({ cross: w.view(cross.address), owner: b, nonce: 77n, side: OrderSide.Buy, price: 1_000_000n, quantity: 1_000n })], b)).toContain('Paused');
    const stranger = await w.trader();
    expect(await w.h.fail([getSetPausedInstruction({ signer: stranger, protocol: await protocolAddress(), paused: false })], stranger)).toContain('Unauthorized');
    await w.settle(cross);
    await w.claimAll(cross, [o]);
    expect(await w.h.balanceOf(b.address, w.quoteMint)).toBe(10_000_000_000n);
  });
});

describe('gated crosses', () => {
  it('only wallets holding a cross_gate pass may place orders', async () => {
    const w = await World.create();
    const gateMint = await w.h.mint(w.admin, 6);
    const [config] = await findConfigPda({ mint: gateMint });
    await w.h.send([getCreateConfigInstruction({ payer: w.admin, mintAuthority: w.admin, mint: gateMint, config, authority: w.admin.address, mode: Mode.Allowlist })], w.admin);
    const cross = await w.newCross({ gateMint });
    const allowed = await w.trader(10_000_000_000n);
    const blocked = await w.trader(10_000_000_000n);
    const { gatePassAddress } = await import('@opening-cross/sdk');
    await w.h.send([getGrantPassInstruction({ authority: w.admin, config, pass: await gatePassAddress(gateMint, allowed.address), owner: allowed.address })], w.admin);
    await w.place(cross, allowed, OrderSide.Buy, 1_000_000n, 1_000n);
    expect(await w.h.fail([await buildPlaceOrder({ cross: w.view(cross.address), owner: blocked, nonce: 5n, side: OrderSide.Buy, price: 1_000_000n, quantity: 1_000n })], blocked)).toContain('NotEligible');
    // Someone else's pass does not help: swap the allowed wallet's pass into the blocked
    // wallet's order.
    const fake = await buildPlaceOrder({ cross: w.view(cross.address), owner: blocked, nonce: 6n, side: OrderSide.Buy, price: 1_000_000n, quantity: 1_000n });
    const ownPass = await gatePassAddress(gateMint, blocked.address);
    const stolenPass = await gatePassAddress(gateMint, allowed.address);
    const forged = { ...fake, accounts: fake.accounts!.map((a) => (a.address === ownPass ? { ...a, address: stolenPass } : a)) };
    expect(await w.h.fail([forged], blocked)).toContain('NotEligible');
  });
});

describe('creation', () => {
  it('rejects bad parameters and fees above their caps', async () => {
    const w = await World.create();
    await expect(w.newCross({ ticks: 0 })).rejects.toThrow(/InvalidParams/);
    await expect(w.newCross({ ticks: 257 })).rejects.toThrow(/InvalidParams/);
    await expect(w.newCross({ shards: 33 })).rejects.toThrow(/InvalidParams/);
    await expect(w.newCross({ integratorFeeBps: 301 })).rejects.toThrow(/FeeTooHigh/);
    await expect(w.newCross({ reference: 1_050_000n })).rejects.toThrow(/OffGrid/);
    await expect(w.newCross({ supplyMode: SupplyMode.Escrow, schedule: [{ price: 1_000_000n, quantity: 1n }] })).rejects.toThrow(/InvalidParams/);
  });

  it('mint mode requires the cross to hold the mint authority', async () => {
    const w = await World.create();
    const { buildCreateCross } = await import('@opening-cross/sdk');
    const baseMint = await w.h.mint(w.admin, 6); // authority stays with admin
    const { create } = await buildCreateCross({
      creator: w.creator, baseMint, quoteMint: w.quoteMint, baseTokenProgram: TOKEN_2022_PROGRAM_ADDRESS, quoteTokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
      crossId: 999n, kind: 0, supplyMode: SupplyMode.Mint, disclosure: Disclosure.Open, minPrice: 1_000_000n, tick: 100_000n, ticks: 10, priceScale: 1_000_000n,
      openTs: 1_800_000_000n, closeTs: 1_800_000_100n, revealEndTs: 1_800_000_200n, referencePrice: null, minMatched: 0n, maxImbalanceBps: null,
      integratorFeeBps: 0, integrator: w.integrator.address, gateMint: null, shards: 1, maxOrders: 8, proceedsTo: w.creator.address, schedule: [{ price: 1_000_000n, quantity: 1_000n }],
    });
    expect(await w.h.fail([create], w.creator)).toContain('MintAuthorityNotCross');
  });
});
