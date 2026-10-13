// Identity limits, allocation classes, the class-1 lottery and locked fills (ADR-0453 to ADR-0454). The
// fills the program pays are compared with the independent TypeScript reference, order by order.
import { describe, expect, it } from 'vitest';
import {
  CrossState,
  Disclosure,
  OrderSide,
  SupplyMode,
  gatePassAddress,
  lockupAddress,
  getLockupDecoder,
  readOrderExt,
  orderAddress,
  type CrossView,
} from '@opening-cross/sdk';
import { Mode, findConfigPda, getCreateConfigInstruction, getGrantPassInstruction } from '@opening-cross/cross-gate-client';
import type { Address, KeyPairSigner } from '@solana/kit';
import { referenceClearCapped, referenceFills2, type Order2, type Rules2 } from '@opening-cross/verifier';
import { SCALE, type PlacedOrder } from '../src/world.js';
import { RulesWorld } from '../src/rules-world.js';
import { T0 } from '../src/harness.js';

const G = { min: 1_000_000n, tick: 100_000n, ticks: 20 };
const schedule = [{ price: 1_000_000n, quantity: 100_000_000n }];
const TOKEN = 1_000_000n;

async function gate(w: RulesWorld, passes: KeyPairSigner[]): Promise<Address> {
  const gateMint = await w.h.mint(w.admin, 6);
  const [config] = await findConfigPda({ mint: gateMint });
  await w.h.send([getCreateConfigInstruction({ payer: w.admin, mintAuthority: w.admin, mint: gateMint, config, authority: w.admin.address, mode: Mode.Allowlist })], w.admin);
  for (const p of passes) await w.h.send([getGrantPassInstruction({ authority: w.admin, config, pass: await gatePassAddress(gateMint, p.address), owner: p.address })], w.admin);
  return gateMint;
}

describe('identity limits', () => {
  it('one application per identity, a cap on what an identity escrows, and cancel frees the room', async () => {
    const w = await RulesWorld.createRules();
    const alice = await w.trader(100_000_000_000n);
    const bob = await w.trader(100_000_000_000n);
    const gateMint = await gate(w, [alice, bob]);
    const cross = await w.newRuledCross({
      supplyMode: SupplyMode.Mint,
      schedule,
      gateMint,
      rules: { identity: { maxOrders: 1, capQuote: 30_000_000n } },
    });
    const first = await w.place(cross, alice, OrderSide.Buy, 1_000_000n, 10n * TOKEN);
    await expect(w.place(cross, alice, OrderSide.Buy, 1_000_000n, 5n * TOKEN)).rejects.toThrow(/IdentityLimit/);
    // The room is the identity's, not the wallet's order count: cancelling frees it.
    await w.cancel(cross, first);
    await expect(w.place(cross, alice, OrderSide.Buy, 1_000_000n, 31n * TOKEN)).rejects.toThrow(/IdentityLimit/);
    await w.place(cross, alice, OrderSide.Buy, 1_000_000n, 30n * TOKEN);
    await w.place(cross, bob, OrderSide.Buy, 1_000_000n, 30n * TOKEN);
  });

  it('refuses identity rules on a cross without a gate: a cap without an identity is theatre', async () => {
    const w = await RulesWorld.createRules();
    await expect(w.newRuledCross({ supplyMode: SupplyMode.Mint, schedule, rules: { identity: { maxOrders: 1 } } })).rejects.toThrow(/InvalidParams/);
  });
});

describe('allocation classes with a lottery', () => {
  it('reserves shares, spills what a class cannot use, draws the lots, and every fill matches the reference', async () => {
    const w = await RulesWorld.createRules();
    // Sequentially: each setup transaction takes the harness blockhash, so concurrent ones invalidate each other.
    const many = async (n: number) => {
      const out: KeyPairSigner[] = [];
      for (let i = 0; i < n; i++) out.push(await w.trader(100_000_000_000n));
      return out;
    };
    const traders = { lot: await many(10), locked: await many(2), early: await w.trader(100_000_000_000n), general: await many(2) };
    const gateMint = await gate(w, [...traders.lot, ...traders.locked, traders.early, ...traders.general]);
    const reserveBps: [number, number, number] = [3_000, 2_000, 1_000];
    const cross = await w.newRuledCross({
      supplyMode: SupplyMode.Mint,
      disclosure: Disclosure.Open,
      schedule,
      gateMint,
      rules: {
        alloc: { reserveBps, smallCapQuote: 5_000_000n, lotteryUnit: 5n * TOKEN, minLockSecs: 3_600, lockVestSecs: 7_200, earlyUntilTs: T0 + 50n },
      },
      closeTs: T0 + 200n,
    });
    const placed: PlacedOrder[] = [];
    const classes: number[] = [];
    // Early commitment qualifies for the priority class.
    w.h.setTime(T0 + 10n);
    placed.push(await w.place(cross, traders.early, OrderSide.Buy, 1_000_000n, 40n * TOKEN, { class: 3 }));
    classes.push(3);
    w.h.setTime(T0 + 100n);
    for (const t of traders.lot) {
      placed.push(await w.place(cross, t, OrderSide.Buy, 1_000_000n, 5n * TOKEN, { class: 1 }));
      classes.push(1);
    }
    for (const t of traders.locked) {
      placed.push(await w.place(cross, t, OrderSide.Buy, 1_000_000n, 30n * TOKEN, { class: 2, lockSecs: 3_600 }));
      classes.push(2);
    }
    for (const t of traders.general) {
      placed.push(await w.place(cross, t, OrderSide.Buy, 1_000_000n, 50n * TOKEN));
      classes.push(0);
    }
    // Class 3 after the early window needs a priority pass; class 1 orders must be exactly one lot; class 2 needs a long enough lock.
    await expect(w.place(cross, traders.general[0]!, OrderSide.Buy, 1_000_000n, 5n * TOKEN, { class: 3 })).rejects.toThrow(/ClassNotAllowed|NotEligible/);
    await expect(w.place(cross, traders.general[0]!, OrderSide.Buy, 1_000_000n, 30n * TOKEN, { class: 2, lockSecs: 60 })).rejects.toThrow(/ClassNotAllowed/);
    await expect(w.place(cross, traders.lot[0]!, OrderSide.Buy, 1_000_000n, 4n * TOKEN, { class: 1 })).rejects.toThrow(/LotSize/);

    // The lottery ticket cannot be withdrawn.
    await expect(w.cancel(cross, placed[1]!)).rejects.toThrow(/CancelClosed/);

    w.h.setTime(cross.data.closeTs + 1n);
    await w.draw(cross.address, 1);
    for (const ix of await w.settleIxs(w.view(cross.address))) await w.h.send([ix], w.admin);
    const settled = w.view(cross.address);
    expect(settled.data.state).toBe(CrossState.Cleared);
    const x = settled.ext!;
    expect(x.clearing.tickets).toBe(10);

    const orders: Order2[] = [
      ...schedule.map((s) => ({ side: 'sell' as const, price: s.price, quantity: s.quantity, class: 0, insider: false })),
      ...placed.map((o, i) => ({ side: 'buy' as const, price: o.price, quantity: o.quantity, class: classes[i]!, insider: false })),
    ];
    const rules: Rules2 = {
      supplyCap: null, minRaiseQuote: 0n, priceScale: SCALE, totalSupply: 0n, minFloatBps: 0n, maxFdvX100: 0n, anchorPrice: 0n, moveBps: 0n,
      reserveBps: [BigInt(reserveBps[0]), BigInt(reserveBps[1]), BigInt(reserveBps[2])], lotteryUnit: 5n * TOKEN, rho: BigInt(x.clearing.rho),
    };
    const ref = referenceClearCapped(orders, G, null, null)!;
    const want = referenceFills2(orders, ref, rules).slice(schedule.length);
    expect(settled.data.clearing.__option === 'Some' ? settled.data.clearing.value.price : 0n).toBe(ref.price);
    // 6 of the 10 tickets win a lot (30% of 100 tokens = 30 / 5).
    expect(want.slice(1, 11).filter((f) => f >= 5n * TOKEN).length).toBeGreaterThanOrEqual(6);

    await w.claimAll(settled, placed);
    let total = 0n;
    for (const [i, o] of placed.entries()) {
      const wallet = await w.h.balanceOf(o.owner.address, settled.data.baseMint);
      const lockedFill = classes[i] === 2;
      // Class-2 fills are locked, so they are in the lock vault and not the wallet.
      expect(wallet).toBe(lockedFill ? 0n : want[i]);
      total += want[i]!;
    }
    expect(total <= 100n * TOKEN).toBe(true);

    // The locked fills vest: nothing before the lock, linear over the vesting period after it.
    const locked = placed.filter((_, i) => classes[i] === 2);
    const o = locked[0]!;
    const fill = want[placed.indexOf(o)]!;
    const lockupAddr = await lockupAddress(settled.address, o.owner.address, o.nonce);
    const acc = w.h.svm.getAccount(lockupAddr);
    if (!acc.exists) throw new Error('lockup missing');
    const lockup = getLockupDecoder().decode(acc.data);
    expect(lockup.amount).toBe(fill);
    expect(lockup.cliffSecs).toBe(3_600);
    const release = async () => w.h.send(await w.releaseIxs(w.view(settled.address), w.admin, o.owner.address, o.nonce), w.admin);
    await expect(release()).rejects.toThrow(/NothingToRelease/);
    w.h.setTime(lockup.startTs + 3_600n + 3_600n);
    await release();
    expect(await w.h.balanceOf(o.owner.address, settled.data.baseMint)).toBe(fill / 2n);
    w.h.setTime(lockup.startTs + 3_600n + 7_200n + 1n);
    await release();
    expect(await w.h.balanceOf(o.owner.address, settled.data.baseMint)).toBe(fill);
    expect(w.h.svm.getAccount(lockupAddr).exists).toBe(false);

    const final = await w.finalize(settled);
    expect(final.data.state).toBe(CrossState.Finalized);
    void readOrderExt;
    void orderAddress;
    void (null as unknown as CrossView);
  });
});
