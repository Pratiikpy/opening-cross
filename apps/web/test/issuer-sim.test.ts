import { describe, expect, it } from 'vitest';
import { type RefOrder, referenceClear, referenceFills } from '../../../packages/verifier/src/reference';
import { type Printed, type SimGrid, type SimInput, type Step, buyAround, buyerFill, scenarios, scaleDemand, simulate } from '../src/lib/issuer-sim';

const grid: SimGrid = { minPrice: 1_000_000n, tick: 100_000n, ticks: 20, priceScale: 1_000_000n, baseDecimals: 6, quoteDecimals: 6 };
const T = (n: number) => BigInt(Math.round(n * 1_000_000));
const P = (n: number) => BigInt(Math.round(n * 1_000_000));
const base = (over: Partial<SimInput> = {}): SimInput => ({
  grid,
  supply: [{ price: P(1.2), quantity: T(1000) }],
  demand: [{ price: P(1.5), quantity: T(600) }],
  supplyMode: 'mint',
  existingSupply: T(9000),
  minMatched: 0n,
  maxImbalanceBps: null,
  protocolBps: 0,
  integratorBps: 0,
  ...over,
});
const printed = (r: ReturnType<typeof simulate>): Printed => {
  if (!r.printed) throw new Error(`did not print: ${r.reason}`);
  return r;
};

describe('simulate: the clearing rule', () => {
  it('matches the verifier’s independent reference on 600 random books', () => {
    let seed = 12345;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    for (let k = 0; k < 600; k++) {
      const supply: Step[] = [];
      const demand: Step[] = [];
      for (let i = 0, n = 1 + rnd(4); i < n; i++) supply.push({ price: grid.minPrice + BigInt(rnd(20)) * grid.tick, quantity: T(1 + rnd(900)) });
      for (let i = 0, n = rnd(6); i < n; i++) demand.push({ price: grid.minPrice + BigInt(rnd(20)) * grid.tick, quantity: T(1 + rnd(900)) });
      const orders: RefOrder[] = [...supply.map((s) => ({ side: 'sell' as const, ...s })), ...demand.map((d) => ({ side: 'buy' as const, ...d }))];
      const ref = referenceClear(orders, { min: grid.minPrice, tick: grid.tick, ticks: grid.ticks }, null);
      const mine = simulate(base({ supply, demand, existingSupply: 0n }));
      if (!ref) expect(mine.printed).toBe(false);
      else {
        const m = printed(mine);
        expect({ price: m.price, matched: m.matched, rationed: m.rationed }).toEqual(ref);
      }
    }
  });

  it('prices at the supply step when demand is short and rations the sell side', () => {
    const r = printed(simulate(base()));
    expect(r.price).toBe(P(1.2));
    expect(r.matched).toBe(T(600));
    expect(r.rationed).toBe('sell');
    expect(r.unsold).toBe(T(400));
  });

  it('prints nothing when no bid reaches the lowest supply price', () => {
    const r = simulate(base({ demand: [{ price: P(1.1), quantity: T(500) }] }));
    expect(r).toEqual({ printed: false, reason: 'NoCross', wouldClearAt: null });
  });

  it('ignores steps that are off the grid and does not let them move the price', () => {
    const r = printed(simulate(base({ demand: [{ price: P(1.5), quantity: T(600) }, { price: P(1.55), quantity: T(9999) }] })));
    expect(r.matched).toBe(T(600));
  });
});

describe('simulate: print guards (OCIP-1 §7.7)', () => {
  it('minimum volume is strict: exactly the minimum prints, one atom under does not', () => {
    expect(simulate(base({ minMatched: T(600) })).printed).toBe(true);
    const under = simulate(base({ minMatched: T(600) + 1n }));
    expect(under).toMatchObject({ printed: false, reason: 'BelowMinimumVolume', wouldClearAt: { price: P(1.2), matched: T(600) } });
  });

  it('maximum imbalance is strict and uses no division', () => {
    // 1000 offered, 600 wanted: imbalance 400 on 600 matched is 6666.67 bps.
    expect(simulate(base({ maxImbalanceBps: 6667 })).printed).toBe(true);
    expect(simulate(base({ maxImbalanceBps: 6666 }))).toMatchObject({ printed: false, reason: 'ImbalanceTooHigh' });
    // 400 on 600 is exactly 4/6; a bound of exactly the ratio prints.
    const exact = simulate(base({ demand: [{ price: P(1.5), quantity: T(500) }], maxImbalanceBps: 10_000 }));
    expect(exact.printed).toBe(true);
    expect(simulate(base({ demand: [{ price: P(1.5), quantity: T(500) }], maxImbalanceBps: 9_999 })).printed).toBe(false);
  });

  it('an oversubscribed sale fails a tight imbalance guard (the footgun the page warns about)', () => {
    const over = base({ demand: [{ price: P(1.5), quantity: T(3000) }], maxImbalanceBps: 5_000 });
    expect(simulate(over)).toMatchObject({ printed: false, reason: 'ImbalanceTooHigh', wouldClearAt: { matched: T(1000) } });
  });

  it('minimum volume is checked before imbalance', () => {
    expect(simulate(base({ minMatched: T(700), maxImbalanceBps: 1 }))).toMatchObject({ reason: 'BelowMinimumVolume' });
  });
});

describe('simulate: money, float and value', () => {
  it('raise is rounded up the way the program charges, and fees follow the formulas', () => {
    const r = printed(simulate(base({ protocolBps: 5, integratorBps: 20 })));
    expect(r.raise).toBe(T(600) * 1_200_000n / 1_000_000n); // 720 quote
    expect(r.fees).toBe((r.raise * 25n) / 10_000n);
    expect(r.net).toBe(r.raise - r.fees);
  });

  it('no integrator fee means no fee at all (protocol fee is capped at a quarter of it)', () => {
    const r = printed(simulate(base({ protocolBps: 0, integratorBps: 0 })));
    expect(r.fees).toBe(0n);
  });

  it('a minting cross adds what it sells to the existing supply; an escrow cross does not', () => {
    const mint = printed(simulate(base()));
    expect(mint.totalSupplyAfter).toBe(T(9600));
    expect(mint.floatBps).toBe((T(600) * 10_000n) / T(9600));
    expect(mint.fdv).toBe((P(1.2) * T(9600)) / 1_000_000n);
    const escrow = printed(simulate(base({ supplyMode: 'escrow', existingSupply: T(9000) })));
    expect(escrow.totalSupplyAfter).toBe(T(9000));
    expect(escrow.floatBps).toBe((T(600) * 10_000n) / T(9000));
  });

  it('FDV over raise is the reciprocal of the float when the cross is the only sale', () => {
    const r = printed(simulate(base()));
    // fdv/raise = totalSupplyAfter / matched (up to rounding of the two floors)
    expect(Number(r.fdv) / Number(r.raise)).toBeCloseTo(Number(r.totalSupplyAfter) / Number(r.matched), 6);
  });

  it('handles a 9-decimal base token and a different price scale', () => {
    const g: SimGrid = { minPrice: 1_000_000n, tick: 50_000n, ticks: 10, priceScale: 1_000_000_000n, baseDecimals: 9, quoteDecimals: 6 };
    const r = printed(simulate({ ...base(), grid: g, supply: [{ price: 1_200_000n, quantity: 5_000_000_000n }], demand: [{ price: 1_450_000n, quantity: 2_000_000_000n }], existingSupply: 0n }));
    expect(r.raise).toBe(2_400_000n); // 2 tokens at 1.20 quote, in 6-decimal quote atoms
  });
});

describe('scenarios', () => {
  it('shows the same book at half, once and twice the demand', () => {
    const s = scenarios(base({ demand: [{ price: P(1.5), quantity: T(600) }] }));
    expect(s.map((x) => x.id)).toEqual(['low', 'base', 'high']);
    expect(printed(s[0]!.result).matched).toBe(T(300));
    expect(printed(s[1]!.result).matched).toBe(T(600));
    expect(printed(s[2]!.result).matched).toBe(T(1000));
  });
  it('scaling floors and never makes a quantity negative', () => {
    expect(scaleDemand([{ price: 1n, quantity: 5n }], 1n, 2n)[0]!.quantity).toBe(2n);
    expect(scaleDemand([], 2n, 1n)).toEqual([]);
  });
});

describe('buyerFill', () => {
  it('agrees with the verifier’s per-order fills on a rationed book', () => {
    const inp = base({ supply: [{ price: P(1.2), quantity: T(500) }], demand: [{ price: P(1.2), quantity: T(300) }, { price: P(1.2), quantity: T(500) }, { price: P(1.5), quantity: T(100) }] });
    const r = printed(simulate(inp));
    expect(r.rationed).toBe('buy');
    const { atPrice, better } = buyAround(inp, r.price);
    const orders: RefOrder[] = [{ side: 'sell', price: P(1.2), quantity: T(500) }, ...inp.demand.map((d) => ({ side: 'buy' as const, ...d }))];
    const ref = referenceClear(orders, { min: grid.minPrice, tick: grid.tick, ticks: grid.ticks }, null)!;
    const fills = referenceFills(orders, ref);
    inp.demand.forEach((d, i) => expect(buyerFill(r, d.price, d.quantity, atPrice, better)).toBe(fills[i + 1]));
  });
  it('a limit below the clearing price gets nothing, above it gets everything', () => {
    const inp = base();
    const r = printed(simulate(inp));
    const { atPrice, better } = buyAround(inp, r.price);
    expect(buyerFill(r, P(1.1), T(10), atPrice, better)).toBe(0n);
    expect(buyerFill(r, P(1.3), T(10), atPrice, better)).toBe(T(10));
  });
});

describe('ladder', () => {
  it('draws the prices with orders, the clearing price and its neighbours, with the cumulative amounts the rule compares', async () => {
    const { ladder } = await import('../src/lib/issuer-sim');
    const inp = base({ supply: [{ price: P(1.2), quantity: T(1000) }], demand: [{ price: P(1.5), quantity: T(600) }, { price: P(1.3), quantity: T(100) }] });
    const r = printed(simulate(inp));
    const rows = ladder(inp, r.price);
    const at = (p: number) => rows.find((x) => x.price === P(p))!;
    expect(rows.map((x) => x.price)).toEqual([P(1.1), P(1.2), P(1.3), P(1.5)]);
    expect(at(1.2)).toMatchObject({ clearing: true, demand: T(700), supply: T(1000) });
    expect(at(1.3)).toMatchObject({ clearing: false, demand: T(700), supply: T(1000) });
    expect(at(1.5)).toMatchObject({ demand: T(600), supply: T(1000) });
    expect(at(1.1)).toMatchObject({ demand: T(700), supply: 0n });
  });
  it('with no clearing price it draws only the prices with orders', async () => {
    const { ladder } = await import('../src/lib/issuer-sim');
    const inp = base({ demand: [{ price: P(1.1), quantity: T(5) }] });
    expect(ladder(inp, null).map((x) => x.price)).toEqual([P(1.1), P(1.2)]);
  });
});

describe('bidderFill', () => {
  it('re-clears the book with the bid in it and agrees with the verifier on the bid’s fill', async () => {
    const { bidderFill } = await import('../src/lib/issuer-sim');
    let seed = 777;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    for (let k = 0; k < 300; k++) {
      const supply: Step[] = [{ price: grid.minPrice + BigInt(rnd(10)) * grid.tick, quantity: T(1 + rnd(900)) }];
      const demand: Step[] = Array.from({ length: rnd(5) }, () => ({ price: grid.minPrice + BigInt(rnd(20)) * grid.tick, quantity: T(1 + rnd(500)) }));
      const inp = base({ supply, demand, existingSupply: 0n });
      const limit = grid.minPrice + BigInt(rnd(20)) * grid.tick;
      const qty = T(1 + rnd(600));
      const mine = bidderFill(inp, limit, qty);
      const orders: RefOrder[] = [...supply.map((s) => ({ side: 'sell' as const, ...s })), ...demand.map((d) => ({ side: 'buy' as const, ...d })), { side: 'buy', price: limit, quantity: qty }];
      const ref = referenceClear(orders, { min: grid.minPrice, tick: grid.tick, ticks: grid.ticks }, null);
      if (!ref) expect(mine.fill).toBe(0n);
      else expect(mine.fill, String(k)).toBe(referenceFills(orders, ref)[orders.length - 1]);
    }
  });
});
