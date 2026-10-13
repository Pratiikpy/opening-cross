// Print guards beyond volume and imbalance, the hard cap, the standard grid, the halt state and the lender
// feed (ADR-0451, ADR-0455). Every verdict that can be recomputed from the
// book is also checked against the independent TypeScript reference.
import { describe, expect, it } from 'vitest';
import {
  CrossState,
  Disclosure,
  FLAG_FEEDS_LENDERS,
  FLAG_RESUMES_HALT,
  FLAG_STANDARD_GRID,
  NoPrintReason,
  OrderSide,
  SupplyMode,
  getInitHaltStateInstruction,
  getInitPrintFeedInstruction,
  getSetCorporateActionInstruction,
  getSetHaltInstruction,
  haltStateAddress,
  printFeedAddress,
  protocolAddress,
  quoteVaultAddress,
} from '@opening-cross/sdk';
import type { Address } from '@solana/kit';
import { referenceClearCapped, referenceFills2, type Order2, type Rules2 } from '@opening-cross/verifier';
import { type CrossOptions, type PlacedOrder, SCALE } from '../src/world.js';
import { RulesWorld, type RuledOptions } from '../src/rules-world.js';

const G = { min: 1_000_000n, tick: 100_000n, ticks: 20 };
const reason = (w: RulesWorld, cross: Address) => {
  const d = w.view(cross).data;
  return d.noPrintReason.__option === 'Some' ? d.noPrintReason.value : null;
};
const price = (w: RulesWorld, cross: Address) => {
  const d = w.view(cross).data;
  return d.clearing.__option === 'Some' ? d.clearing.value.price : null;
};

/** A mint-mode launch: the issuer sells `100 @ 1.0` and `100 @ 1.5` (in whole tokens x1e6), one buyer takes `qty @ limit`. */
async function launch(w: RulesWorld, rules: RuledOptions['rules'], qty: bigint, limit: bigint, schedule = [{ price: 1_000_000n, quantity: 1_000_000_000n }]) {
  const cross = await w.newRuledCross({ supplyMode: SupplyMode.Mint, disclosure: Disclosure.Open, schedule, ...(rules ? { rules } : {}) });
  const buyer = await w.trader(100_000_000_000n);
  const order = await w.place(cross, buyer, OrderSide.Buy, limit, qty);
  const settled = await w.settle(cross);
  return { cross: settled, order };
}

describe('minimum raise, float, valuation', () => {
  // 100 tokens at 1.0 raise 100,000,000 quote atoms out of a declared supply of 1,000 tokens.
  const qty = 100_000_000n;
  it('minimum raise: met exactly prints, one atom short does not', async () => {
    const w = await RulesWorld.createRules();
    expect((await launch(w, { guards: { minRaiseQuote: 100_000_000n } }, qty, 1_500_000n)).cross.data.state).toBe(CrossState.Cleared);
    const short = await launch(w, { guards: { minRaiseQuote: 100_000_001n } }, qty, 1_500_000n);
    expect(short.cross.data.state).toBe(CrossState.NoPrint);
    expect(reason(w, short.cross.address)).toBe(NoPrintReason.BelowMinimumRaise);
  });

  it('float and valuation are two readings of one ratio', async () => {
    const w = await RulesWorld.createRules();
    const base = { totalSupply: 1_000_000_000n };
    expect((await launch(w, { guards: { ...base, minFloatBps: 1_000, maxFdvX100: 1_000 } }, qty, 1_500_000n)).cross.data.state).toBe(CrossState.Cleared);
    const thin = await launch(w, { guards: { ...base, minFloatBps: 1_001 } }, qty, 1_500_000n);
    expect(reason(w, thin.cross.address)).toBe(NoPrintReason.FloatTooLow);
    const rich = await launch(w, { guards: { ...base, maxFdvX100: 999 } }, qty, 1_500_000n);
    expect(reason(w, rich.cross.address)).toBe(NoPrintReason.FdvTooHigh);
  });

  it('a refused print refunds every order in full', async () => {
    const w = await RulesWorld.createRules();
    const { cross, order } = await launch(w, { guards: { minRaiseQuote: 1_000_000_000n } }, qty, 1_500_000n);
    const before = await w.h.balanceOf(order.owner.address, w.quoteMint);
    await w.claimAll(cross, [order]);
    expect(await w.h.balanceOf(order.owner.address, w.quoteMint)).toBe(before + order.escrow);
    await w.finalize(cross);
    expect(w.h.balance(await quoteVaultAddress(cross.address))).toBe(0n);
  });
});

describe('price move (the re-sign rule)', () => {
  const schedule = [
    { price: 1_000_000n, quantity: 50_000_000n },
    { price: 1_500_000n, quantity: 50_000_000n },
  ];
  it('prints inside the bound and refuses beyond it, in both directions', async () => {
    const w = await RulesWorld.createRules();
    const inside = await launch(w, { guards: { anchorPrice: 1_000_000n, moveBps: 5_000 } }, 100_000_000n, 1_500_000n, schedule);
    expect(inside.cross.data.state).toBe(CrossState.Cleared);
    expect(price(w, inside.cross.address)).toBe(1_500_000n);
    const outside = await launch(w, { guards: { anchorPrice: 1_000_000n, moveBps: 4_999 } }, 100_000_000n, 1_500_000n, schedule);
    expect(reason(w, outside.cross.address)).toBe(NoPrintReason.PriceMoved);
    // Anchor above: the same print is a drop of a third.
    const below = await launch(w, { guards: { anchorPrice: 2_250_000n, moveBps: 3_000 } }, 100_000_000n, 1_500_000n, schedule);
    expect(reason(w, below.cross.address)).toBe(NoPrintReason.PriceMoved);
  });
});

describe('hard cap', () => {
  const schedule = [
    { price: 1_000_000n, quantity: 100_000_000n },
    { price: 1_500_000n, quantity: 100_000_000n },
    { price: 2_000_000n, quantity: 200_000_000n },
  ];
  const buys = [
    { limit: 2_000_000n, qty: 60_000_000n },
    { limit: 1_800_000n, qty: 60_000_000n },
    { limit: 1_300_000n, qty: 60_000_000n },
  ];
  for (const cap of [null, 1n, 80_000_000n, 100_000_000n, 150_000_000n, 10_000_000_000n]) {
    it(`cap ${cap ?? 'none'}: the program and the independent reference agree on price, volume and every fill`, async () => {
      const w = await RulesWorld.createRules();
      const cross = await w.newRuledCross({ supplyMode: SupplyMode.Mint, disclosure: Disclosure.Open, schedule, ...(cap === null ? {} : { rules: { guards: { maxMatched: cap } } }) });
      const placed: PlacedOrder[] = [];
      for (const b of buys) placed.push(await w.place(cross, await w.trader(100_000_000_000n), OrderSide.Buy, b.limit, b.qty));
      const settled = await w.settle(cross);
      const orders: Order2[] = [
        ...schedule.map((s) => ({ side: 'sell' as const, price: s.price, quantity: s.quantity, class: 0, insider: false })),
        ...placed.map((o) => ({ side: 'buy' as const, price: o.price, quantity: o.quantity, class: 0, insider: false })),
      ];
      const ref = referenceClearCapped(orders, G, null, cap);
      if (!ref) {
        expect(settled.data.state).toBe(CrossState.NoPrint);
        return;
      }
      expect(settled.data.state).toBe(CrossState.Cleared);
      const chain = settled.data.clearing.__option === 'Some' ? settled.data.clearing.value : null;
      expect(chain?.price).toBe(ref.price);
      expect(chain?.matched).toBe(ref.matched);
      const rules: Rules2 = { supplyCap: cap, minRaiseQuote: 0n, priceScale: SCALE, totalSupply: 0n, minFloatBps: 0n, maxFdvX100: 0n, anchorPrice: 0n, moveBps: 0n, reserveBps: [0n, 0n, 0n], lotteryUnit: 0n, rho: 0n };
      const want = referenceFills2(orders, ref, rules).slice(schedule.length);
      await w.claimAll(settled, placed);
      for (const [i, o] of placed.entries()) expect(await w.h.balanceOf(o.owner.address, settled.data.baseMint)).toBe(want[i]);
      if (cap !== null) expect(settled.data.baseBought <= cap).toBe(true);
    });
  }
});

describe('standard price grid', () => {
  it('accepts a grid with the reserve at half the estimate and ticks within one percent', async () => {
    const w = await RulesWorld.createRules();
    const cross = await w.newRuledCross({ minPrice: 750_000n, tick: 10_000n, ticks: 200, rules: { flags: FLAG_STANDARD_GRID, guards: { gridEstimate: 1_500_000n } } });
    expect(cross.ext?.guards.gridEstimate).toBe(1_500_000n);
  });
  it('refuses a reserve below half, a tick above one percent and a grid that misses the estimate', async () => {
    const w = await RulesWorld.createRules();
    const rules = { flags: FLAG_STANDARD_GRID, guards: { gridEstimate: 1_500_000n } };
    await expect(w.newRuledCross({ minPrice: 700_000n, tick: 10_000n, ticks: 200, rules })).rejects.toThrow(/GridPolicy/);
    await expect(w.newRuledCross({ minPrice: 750_000n, tick: 20_000n, ticks: 200, rules })).rejects.toThrow(/GridPolicy/);
    await expect(w.newRuledCross({ minPrice: 750_000n, tick: 10_000n, ticks: 50, rules })).rejects.toThrow(/GridPolicy/);
  });
});

describe('halt state, corporate actions and resume crosses', () => {
  async function reopen(w: RulesWorld, rules: RuledOptions['rules'], reference = 1_500_000n) {
    const cross = await w.newRuledCross({ supplyMode: SupplyMode.Escrow, disclosure: Disclosure.Open, reference, ...(rules ? { rules } : {}) });
    const seller = await w.trader(0n, 2_000_000_000n);
    const buyer = await w.trader(10_000_000_000n);
    const orders = [await w.place(cross, seller, OrderSide.Sell, 1_400_000n, 100_000_000n), await w.place(cross, buyer, OrderSide.Buy, 1_600_000n, 100_000_000n)];
    return { cross: await w.settle(cross), orders };
  }
  async function haltState(w: RulesWorld) {
    const halt = await haltStateAddress(w.baseMint);
    await w.h.send([getInitHaltStateInstruction({ authority: w.admin, baseMint: w.baseMint, protocol: await protocolAddress(), halt, venueSigner: null, breaker: null })], w.admin);
    return halt;
  }

  it('a halted asset does not print in an ordinary cross, and a corporate action does not either', async () => {
    const w = await RulesWorld.createRules();
    const halt = await haltState(w);
    const rules = { guards: { haltSource: halt } };
    expect((await reopen(w, rules)).cross.data.state).toBe(CrossState.Cleared);
    await w.h.send([getSetHaltInstruction({ signer: w.admin, halt })], w.admin);
    const halted = await reopen(w, rules);
    expect(halted.cross.data.state).toBe(CrossState.NoPrint);
    expect(reason(w, halted.cross.address)).toBe(NoPrintReason.Halted);
  });

  it('only a printing resume cross run by the halt authority lifts the halt', async () => {
    const w = await RulesWorld.createRules();
    const halt = await haltState(w);
    await w.h.send([getSetHaltInstruction({ signer: w.admin, halt })], w.admin);
    await w.h.send([getSetCorporateActionInstruction({ signer: w.admin, halt, flag: true })], w.admin);
    const resume = { flags: FLAG_RESUMES_HALT, guards: { haltSource: halt } };
    // A cross run by anyone else cannot be flagged to resume the asset (a wash cross would lift every halt).
    await expect(reopen(w, resume)).rejects.toThrow(/Unauthorized/);
    // The halt state's authority (the admin) runs the resume cross.
    w.creator = w.admin;
    await w.h.ata(w.admin.address, w.baseMint, w.admin);
    await w.h.ata(w.admin.address, w.quoteMint, w.admin);
    await w.h.fund(w.quoteMint, w.admin, w.admin.address, 1_000_000_000_000n);
    const printed = await reopen(w, resume);
    expect(printed.cross.data.state).toBe(CrossState.Cleared);
    const { getHaltStateDecoder } = await import('@opening-cross/sdk');
    const acc = w.h.svm.getAccount(halt);
    if (!acc.exists) throw new Error('halt state missing');
    const h = getHaltStateDecoder().decode(acc.data);
    expect(h.halted).toBe(false);
    expect(h.corporateAction).toBe(false);
    expect(h.lastResumePrice).toBe(printed.cross.data.clearing.__option === 'Some' ? printed.cross.data.clearing.value.price : -1n);
    // After the resume, ordinary crosses print again.
    expect((await reopen(w, { guards: { haltSource: halt } })).cross.data.state).toBe(CrossState.Cleared);
  });

  it('the halt is the issuer authority\'s or the venue\'s alone', async () => {
    const w = await RulesWorld.createRules();
    const halt = await haltState(w);
    const stranger = await w.h.wallet();
    expect(await w.h.fail([getSetHaltInstruction({ signer: stranger, halt })], stranger)).toMatch(/Unauthorized/);
    expect(await w.h.fail([getSetCorporateActionInstruction({ signer: stranger, halt, flag: true })], stranger)).toMatch(/Unauthorized/);
  });

  it('a cross naming a halt state that is not its base mint\'s is refused', async () => {
    const w = await RulesWorld.createRules();
    await haltState(w);
    const other = await haltStateAddress(w.quoteMint);
    await expect(w.newRuledCross({ supplyMode: SupplyMode.Escrow, rules: { guards: { haltSource: other } } })).rejects.toThrow(/HaltMismatch/);
  });
});

describe('lender price feed', () => {
  async function feed(w: RulesWorld, publishers: Address[], minMatched: bigint) {
    const f = await printFeedAddress(w.baseMint);
    await w.h.send([getInitPrintFeedInstruction({ authority: w.admin, baseMint: w.baseMint, quoteMint: w.quoteMint, protocol: await protocolAddress(), feed: f, publishers, minMatched })], w.admin);
    return f;
  }
  async function reopenFeeding(w: RulesWorld, size: bigint) {
    const cross = await w.newRuledCross({ supplyMode: SupplyMode.Escrow, disclosure: Disclosure.Open, reference: 1_500_000n, rules: { flags: FLAG_FEEDS_LENDERS } });
    const seller = await w.trader(0n, 2_000_000_000n);
    const buyer = await w.trader(10_000_000_000n);
    await w.place(cross, seller, OrderSide.Sell, 1_400_000n, size);
    await w.place(cross, buyer, OrderSide.Buy, 1_600_000n, size);
    return w.settle(cross);
  }
  const read = async (w: RulesWorld, f: Address) => {
    const { getPrintFeedDecoder } = await import('@opening-cross/sdk');
    const acc = w.h.svm.getAccount(f);
    if (!acc.exists) throw new Error('feed missing');
    return getPrintFeedDecoder().decode(acc.data);
  };

  it('a thin cross never moves the feed; a sufficient one from a publisher does', async () => {
    const w = await RulesWorld.createRules();
    const f = await feed(w, [w.creator.address], 50_000_000n);
    await reopenFeeding(w, 10_000_000n);
    expect((await read(w, f)).prints).toBe(0n);
    const thick = await reopenFeeding(w, 80_000_000n);
    const after = await read(w, f);
    expect(after.prints).toBe(1n);
    expect(after.cross).toBe(thick.address);
    expect(after.price).toBe(thick.data.clearing.__option === 'Some' ? thick.data.clearing.value.price : -1n);
  });

  it('a creator who is not a publisher cannot create a cross that feeds', async () => {
    const w = await RulesWorld.createRules();
    await feed(w, [w.admin.address], 0n);
    await expect(w.newRuledCross({ supplyMode: SupplyMode.Escrow, rules: { flags: FLAG_FEEDS_LENDERS } })).rejects.toThrow(/Unauthorized/);
  });
});
