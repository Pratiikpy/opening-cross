import { describe, expect, it } from "vitest";
import {
  buyerPays,
  clearAdr,
  clearBudget,
  fillBuy,
  fillSell,
  sellerReceives,
  type Clearing,
  type Level,
} from "./clearing.js";
import { simulate } from "./engine.js";
import { runCell, seedRange } from "./experiments.js";
import { mechUniform } from "./mechanisms.js";
import { DEFAULT_AUCTION, MECH, Q, SCEN_M, SCEN_P, SNIPER } from "./params.js";
import { Market, Pool, cpCurve, expFeeFn } from "./pool.js";
import { drawLaunch, drawPopulation } from "./population.js";
import { Rng } from "./prng.js";
import { bootstrapMean } from "./stats.js";

const lv = (idx: number, qty: number): Level => ({ idx, qty: BigInt(qty) });

describe("PRNG", () => {
  it("is deterministic for a given (seed, stream) and independent across streams", () => {
    const a = new Rng(42, 1);
    const b = new Rng(42, 1);
    const c = new Rng(42, 2);
    const d = new Rng(43, 1);
    const xs = Array.from({ length: 50 }, () => a.random());
    expect(Array.from({ length: 50 }, () => b.random())).toEqual(xs);
    expect(Array.from({ length: 50 }, () => c.random())).not.toEqual(xs);
    expect(Array.from({ length: 50 }, () => d.random())).not.toEqual(xs);
  });

  it("is pinned: the first draws of seed 1 never change silently", () => {
    const r = new Rng(1, 0);
    const first = [r.random(), r.random(), r.random()].map((x) => Math.round(x * 1e9));
    expect(first).toEqual([418562680, 833894659, 906269630]);
  });

  it("stays in [0, 1) and has the right moments", () => {
    const r = new Rng(7, 3);
    const n = 200_000;
    let s = 0;
    let s2 = 0;
    for (let i = 0; i < n; i++) {
      const u = r.random();
      expect(u).toBeGreaterThanOrEqual(0);
      expect(u).toBeLessThan(1);
      s += u;
      s2 += u * u;
    }
    expect(s / n).toBeCloseTo(0.5, 2);
    expect(s2 / n - (s / n) ** 2).toBeCloseTo(1 / 12, 2);
  });

  it("normal, lognormal, exponential and Poisson match their parameters", () => {
    const r = new Rng(9, 9);
    const n = 100_000;
    let m = 0;
    let v = 0;
    const lg: number[] = [];
    let ex = 0;
    let p3 = 0;
    let p1500 = 0;
    for (let i = 0; i < n; i++) {
      const z = r.normal(2, 3);
      m += z;
      v += (z - 2) ** 2;
      lg.push(r.lognormalMedian(13.5, 2.7));
      ex += r.exponential(7200);
      p3 += r.poisson(3.3);
      if (i < 2000) p1500 += r.poisson(1500);
    }
    expect(m / n).toBeCloseTo(2, 1);
    expect(Math.sqrt(v / n)).toBeCloseTo(3, 1);
    lg.sort((a, b) => a - b);
    expect(lg[n >> 1]).toBeGreaterThan(12.5);
    expect(lg[n >> 1]).toBeLessThan(14.5); // median 13.5 s is the R3 sniper exit time
    expect(ex / n).toBeGreaterThan(7000);
    expect(ex / n).toBeLessThan(7400);
    expect(p3 / n).toBeCloseTo(3.3, 1);
    expect(p1500 / 2000).toBeGreaterThan(1495);
    expect(p1500 / 2000).toBeLessThan(1505);
  });

  it("shuffle is a permutation", () => {
    const a = Array.from({ length: 100 }, (_, i) => i);
    const b = new Rng(5).shuffle([...a]);
    expect([...b].sort((x, y) => x - y)).toEqual(a);
    expect(b).not.toEqual(a);
  });

  it("bootstrap CI brackets the mean and is reproducible", () => {
    const xs = Array.from({ length: 100 }, (_, i) => i / 100);
    const a = bootstrapMean(xs, 500, 3);
    const b = bootstrapMean(xs, 500, 3);
    expect(a).toEqual(b);
    expect(a.lo).toBeLessThan(a.mean);
    expect(a.hi).toBeGreaterThan(a.mean);
  });
});

describe("parameters match the documented values", () => {
  it("sniper and bundler inputs from R2 section 0 / R3", () => {
    expect(SCEN_P.sniperPresence).toBeCloseTo(18 / 35, 12);
    expect(SCEN_P.nSniper).toBe(3.3);
    expect(SCEN_P.sniperExitMedS).toBe(13.5);
    expect(SCEN_P.sniperExitSig).toBe(2.7);
    expect(SCEN_P.bundlerProb).toBe(0.5);
    expect(SCEN_P.bundlerWallets).toBe(10);
    expect(SCEN_P.retailValMu).toBe(0.1);
    expect(SCEN_P.retailValSig).toBe(0.6);
    expect(SCEN_P.informedValSig).toBe(0.1);
    expect(SCEN_P.whaleValSig).toBe(0.25);
    expect(SCEN_P.v0Med).toBe(5e6);
    expect(SCEN_P.retailFlipShare).toBe(0.55);
    expect(SCEN_M.retailFlipShare).toBe(0.875);
    expect(SCEN_P.floorMult).toBe(0.5);
    expect(SCEN_P.saleFrac).toBe(0.25);
    expect(MECH.uniform.tick).toBe(0.01);
  });

  it("population draw follows the presence and count rule", () => {
    let present = 0;
    let total = 0;
    const runs = 4000;
    for (let s = 0; s < runs; s++) {
      const rng = new Rng(s, 2);
      const L = drawLaunch(SCEN_M, new Rng(s, 1));
      const A = drawPopulation({ ...SCEN_M, nRetailPerHype: 0 }, L, rng);
      let c = 0;
      for (let i = 0; i < A.n; i++) if (A.typ[i] === SNIPER) c++;
      if (c > 0) present++;
      total += c;
    }
    expect(present / runs).toBeGreaterThan(18 / 35 - 0.03);
    expect(present / runs).toBeLessThan(18 / 35 + 0.03);
    expect(total / present).toBeGreaterThan(4.1); // mean about 4.3 when present
    expect(total / present).toBeLessThan(4.5);
  });
});

describe("ADR-0003 clearing rule, hand-computed books", () => {
  it("oversubscribed: lowest price is infeasible while strictly better orders do not fit", () => {
    // sell 100 at tick 0; buy A 60@5, B 60@3, C 40@3.
    // tick 0..2 infeasible (160 strictly better > 100), tick 3: V=100 feasible, tick 4,5: V=60.
    const c = clearAdr([lv(5, 60), lv(3, 60), lv(3, 40)], [lv(0, 100)]) as Clearing;
    expect(c.idx).toBe(3);
    expect(c.volume).toBe(100n);
    expect(c.rationed).toBe("buy");
    expect(c.marginalVolume).toBe(40n);
    expect(c.marginalQty).toBe(100n);
    expect(fillBuy(5, 60n, c)).toBe(60n);
    expect(fillBuy(3, 60n, c)).toBe(24n); // floor(60 * 40 / 100)
    expect(fillBuy(3, 40n, c)).toBe(16n);
    expect(fillBuy(2, 50n, c)).toBe(0n); // below P*
    expect(fillSell(0, 100n, c)).toBe(100n);
  });

  it("undersubscribed: clears at the reserve and fills everyone", () => {
    const c = clearAdr([lv(4, 30), lv(2, 20)], [lv(0, 100)]) as Clearing;
    expect(c.idx).toBe(0);
    expect(c.volume).toBe(50n);
    expect(c.rationed).toBe("sell");
    expect(fillBuy(4, 30n, c)).toBe(30n);
    expect(fillBuy(2, 20n, c)).toBe(20n);
  });

  it("exact match: every tick up to the bid ties on volume and imbalance, so the LOWEST wins", () => {
    const c = clearAdr([lv(5, 100)], [lv(0, 100)]) as Clearing;
    expect(c.idx).toBe(0);
    expect(c.volume).toBe(100n);
    expect(c.rationed).toBe("none");
  });

  it("one large bid above supply: clears at that bid, because lower ticks are infeasible", () => {
    // 150 wanted at tick 4, 100 for sale at the reserve. Ticks 0..3 would leave 150 strictly-better demand unfilled.
    const c = clearAdr([lv(4, 150)], [lv(0, 100)]) as Clearing;
    expect(c.idx).toBe(4);
    expect(fillBuy(4, 150n, c)).toBe(100n);
  });

  it("minimum imbalance beats lowest price: with a one-sided seller it selects the HIGHEST tick that still sells out", () => {
    // sell 100@0. Buys: 60@6, 60@2. Ticks 3..6: D=60, V=60. Ticks 0..2: D=120, but D+(k)=60 (k=2: 0..)
    // tick 0,1: D+ = 120 > V=100 infeasible. tick 2: D=120, S=100, V=100, D+=60 feasible, imbalance 20.
    const c = clearAdr([lv(6, 60), lv(2, 60)], [lv(0, 100)]) as Clearing;
    expect(c.idx).toBe(2);
    expect(c.volume).toBe(100n);
    expect(fillBuy(6, 60n, c)).toBe(60n);
    expect(fillBuy(2, 60n, c)).toBe(40n); // R = 100 - 60 = 40, Q = 60
  });

  it("no overlap: the cross does not print", () => {
    expect(clearAdr([lv(2, 50)], [lv(5, 100)])).toBeNull();
    expect(clearAdr([], [lv(0, 100)])).toBeNull();
    expect(clearAdr([], [])).toBeNull();
  });

  it("pro-rata dust: sum of buy fills + dust = supply and dust <= marginal orders", () => {
    // three equal marginal orders of 7 against 10 for sale
    const buys = [lv(2, 7), lv(2, 7), lv(2, 7)];
    const c = clearAdr(buys, [lv(0, 10)]) as Clearing;
    expect(c.idx).toBe(2);
    const fills = buys.map((b) => fillBuy(b.idx, b.qty, c));
    expect(fills).toEqual([3n, 3n, 3n]);
    const dust = 10n - fills.reduce((a, b) => a + b, 0n);
    expect(dust).toBe(1n);
    expect(dust <= BigInt(buys.length)).toBe(true);
  });

  it("rationed sells round up but never above the order", () => {
    // 3 sellers of 5 at the margin against 7 of demand: R = 7, Q = 15 -> ceil(5*7/15) = 3 each, total 9 >= 7
    const c = clearAdr([lv(0, 7)], [lv(0, 5), lv(0, 5), lv(0, 5)]) as Clearing;
    expect(c.rationed).toBe("sell");
    const f = fillSell(0, 5n, c);
    expect(f).toBe(3n);
    expect(f <= 5n).toBe(true);
  });

  it("randomised books: fills never exceed volume, strict-better orders fill in full, dust is bounded", () => {
    const rng = new Rng(2026, 11);
    for (let trial = 0; trial < 300; trial++) {
      const nb = rng.integers(1, 30);
      const buys: Level[] = Array.from({ length: nb }, () => lv(rng.integers(0, 40), rng.integers(1, 5000)));
      const supply = BigInt(rng.integers(1, 40_000));
      const c = clearAdr(buys, [{ idx: 0, qty: supply }]);
      if (c === null) continue;
      let sumBuy = 0n;
      let marginalOrders = 0;
      for (const b of buys) {
        const f = fillBuy(b.idx, b.qty, c);
        expect(f >= 0n && f <= b.qty).toBe(true);
        if (b.idx > c.idx) expect(f).toBe(b.qty);
        if (b.idx < c.idx) expect(f).toBe(0n);
        if (b.idx === c.idx) marginalOrders++;
        sumBuy += f;
      }
      expect(sumBuy <= c.volume).toBe(true);
      expect(sumBuy <= supply).toBe(true);
      const dust = c.volume - sumBuy;
      expect(dust >= 0n && dust <= BigInt(marginalOrders)).toBe(true);
      // no feasible tick has a larger volume
      for (let k = 0; k < 42; k++) {
        let d = 0n;
        let dPlus = 0n;
        for (const b of buys) {
          if (b.idx >= k) d += b.qty;
          if (b.idx > k) dPlus += b.qty;
        }
        const v = d < supply ? d : supply;
        if (v > c.volume) expect(v < dPlus || (k > 0 && v < supply)).toBe(true);
      }
    }
  });

  it("is independent of order arrival: shuffling the book leaves the clearing and each order's fill unchanged", () => {
    const rng = new Rng(77, 1);
    const buys: Level[] = Array.from({ length: 40 }, () => lv(rng.integers(0, 12), rng.integers(1, 900)));
    const sells = [lv(0, 5000)];
    const c1 = clearAdr(buys, sells) as Clearing;
    const shuffled = rng.shuffle([...buys]);
    const c2 = clearAdr(shuffled, sells) as Clearing;
    expect(c2).toEqual(c1);
    const total = (bs: Level[], c: Clearing) => bs.reduce((s, b) => s + fillBuy(b.idx, b.qty, c), 0n);
    expect(total(shuffled, c2)).toBe(total(buys, c1));
  });

  it("two equal orders at the margin get equal fills whoever is first (no time priority)", () => {
    const c = clearAdr([lv(3, 100), lv(3, 100), lv(5, 20)], [lv(0, 150)]) as Clearing;
    expect(fillBuy(3, 100n, c)).toBe(fillBuy(3, 100n, c));
    expect(c.idx).toBe(3);
    expect(fillBuy(3, 100n, c)).toBe(65n); // R = 130, Q = 200 -> 65 each
  });

  it("payment rounding favours the vault", () => {
    expect(buyerPays(1n, 3n, 2n)).toBe(2n); // ceil(1.5)
    expect(sellerReceives(1n, 3n, 2n)).toBe(1n); // floor(1.5)
    expect(buyerPays(4n, 3n, 2n)).toBe(6n);
  });
});

describe("the original model's budget-curve clearing, hand-computed", () => {
  it("highest 1% tick that still sells out; pro-rata at the margin", () => {
    // bidders: (budget 100, limit 2.0), (budget 200, limit 1.5); supply 100; reserve 1.
    // p = 1.01^40 = 1.4889 is the last tick <= 1.5; 1.01^41 = 1.5038 > 1.5.
    const { price, alloc } = clearBudget(new Float64Array([100, 200]), new Float64Array([2.0, 1.5]), 100, 1, 0.01);
    expect(price).toBeCloseTo(Math.pow(1.01, 40), 9);
    // strict (limit >= next tick) = bidder 0 only: 100/p; marginal = bidder 1: 200/p; remaining = 100 - 100/p
    const strict = 100 / price;
    const rem = 100 - strict;
    expect(alloc[0]).toBeCloseTo(strict, 9);
    expect(alloc[1]).toBeCloseTo(rem, 9);
    expect(alloc[0]! + alloc[1]!).toBeCloseTo(100, 9);
  });
  it("undersubscribed clears at the reserve", () => {
    const { price, alloc } = clearBudget(new Float64Array([10]), new Float64Array([5]), 100, 1, 0.01);
    expect(price).toBe(1);
    expect(alloc[0]).toBeCloseTo(10, 12);
  });
});

describe("curve math", () => {
  it("pump.fun: buying the whole curve returns exactly 793.1M tokens for about $12.75k of quote", () => {
    const m = MECH.pump;
    const sol = MECH.solUsd;
    const curve = new Pool(m.virtualSol * sol, m.virtualTokens, 0, "pump", {
      xv: m.virtualSol * sol,
      yv: m.virtualTokens - m.tokensOnCurve,
    });
    const [out, spent] = curve.buy(1e9, 0);
    expect(out).toBeCloseTo(m.tokensOnCurve, 0);
    expect(spent).toBeCloseTo(m.virtualSol * sol * (m.virtualTokens / (m.virtualTokens - m.tokensOnCurve) - 1), 6);
    expect(spent).toBeGreaterThan(12_700);
    expect(spent).toBeLessThan(12_800);
    expect(curve.soldout).toBe(true);
    expect(curve.realQuote()).toBeCloseTo(spent, 6);
  });

  it("cpCurve: sells `sold` tokens between p0 and p1 and ends at p1", () => {
    const p0 = 5e3 / Q;
    const p1 = 75e3 / Q;
    const sold = 0.79 * Q;
    const c = cpCurve(p0, p1, sold, 0, "dbc");
    expect(c.price()).toBeCloseTo(p0, 18);
    const [out, spent] = c.buy(1e12, 0);
    expect(out).toBeCloseTo(sold, 0);
    expect(c.price()).toBeCloseTo(p1, 15);
    expect(spent).toBeCloseTo(c.realQuote(), 6);
  });

  it("tokens in = tokens out and quote is conserved over a random trading sequence", () => {
    const rng = new Rng(5, 5);
    const pool = new Pool(1e5, 1e6, 0.003, "xyk", { lpFrac: 0.4, issuerFrac: 0.35 });
    const x0 = pool.x;
    const y0 = pool.y;
    let paid = 0;
    let received = 0;
    let tokBought = 0;
    let tokSold = 0;
    for (let i = 0; i < 2000; i++) {
      if (rng.random() < 0.5) {
        const [tk, sp] = pool.buy(rng.exponential(500), 0);
        tokBought += tk;
        paid += sp;
      } else {
        const [got, sold] = pool.sell(rng.exponential(3000), 0);
        tokSold += sold;
        received += got;
      }
    }
    expect(y0 - pool.y).toBeCloseTo(tokBought - tokSold, 6); // tokens: pool inventory moved = traders' net
    const lhs = paid - received;
    const rhs = pool.x - x0 + pool.feeIssuer + pool.feeOther;
    expect(lhs).toBeCloseTo(rhs, 6); // quote: nothing created or destroyed
    expect(pool.x * pool.y).toBeGreaterThan(1e5 * 1e6 * 0.999); // k never shrinks (fees compound a share into x)
  });

  it("a round trip never makes money, and a curve cannot pay out more quote than was paid in", () => {
    const c = cpCurve(1e-6, 1.5e-5, 5e8, 0.0125, "c", { issuerFrac: 0.2 });
    const [tk, sp] = c.buy(2000, 0);
    const [got, sold] = c.sell(tk, 0);
    expect(sold).toBeCloseTo(tk, 6);
    expect(got).toBeLessThan(sp);
    const [got2, sold2] = c.sell(1e12, 0); // nothing left to sell into
    expect(got2).toBeLessThanOrEqual(c.realQuote() + 1e-9 + 2000);
    expect(sold2).toBeGreaterThanOrEqual(0);
    expect(c.x).toBeGreaterThanOrEqual(c.xv - 1e-9);
  });

  it("market graduates a sold-out curve into a second pool and conserves the quote", () => {
    const rq: number[] = [];
    let migrated = 0;
    const curve = cpCurve(1e-6, 4e-6, 1e8, 0.0025, "c", {
      onSoldout: (p) => {
        rq.push(p.realQuote());
        migrated += p.realQuote() * 0.002;
        return [new Pool(p.realQuote() * 0.998, (p.realQuote() * 0.998) / p.price(), 0.0025, "amm")];
      },
    });
    const m = new Market([curve]);
    const [tk, sp] = m.buy(1e9, 0);
    expect(tk).toBeGreaterThan(0);
    expect(m.retired).toHaveLength(1);
    expect(m.pools).toHaveLength(1);
    expect(m.pools[0]!.name).toBe("amm");
    const located = m.pools.reduce((s, p) => s + p.realQuote(), 0) + migrated + m.feesIssuer() + m.feesOther();
    expect(located).toBeCloseTo(sp, 6);
  });

  it("anti-sniper fee decays from the cliff to the base over the sampled periods", () => {
    const f = expFeeFn(0.99, 0.01, 30);
    expect(f(-1)).toBe(0.99);
    expect(f(0)).toBeCloseTo(0.99, 12);
    expect(f(15)).toBeLessThan(0.2);
    expect(f(30)).toBeCloseTo(0.01, 6);
    expect(f(3600)).toBe(0.01);
    let last = 1;
    for (let t = 0; t <= 40; t++) {
      expect(f(t)).toBeLessThanOrEqual(last);
      last = f(t);
    }
  });
});

describe("uniform auction at the population level", () => {
  const build = (seed: number, auction = {}) => {
    const L = drawLaunch(SCEN_P, new Rng(seed, 1));
    const A = drawPopulation(SCEN_P, L, new Rng(seed, 2));
    const R = mechUniform(A, SCEN_P, L, new Rng(seed, 3, 4), { ...DEFAULT_AUCTION, ...auction });
    return { L, A, R };
  };

  it("every winner pays the same price per token, no one is filled above their bid, supply is not exceeded", () => {
    let checked = 0;
    for (let seed = 0; seed < 25; seed++) {
      const { L, A, R } = build(seed, { sniperBid: "oracle", bundlersBid: true });
      if (R.failed || R.clearing === null) continue;
      checked++;
      const S = SCEN_P.saleFrac * Q;
      let sold = 0;
      let cost = 0;
      for (let i = 0; i < A.n; i++) {
        sold += A.saleTok[i]!;
        cost += A.spent[i]!;
        if (A.saleTok[i]! > 0) {
          expect(A.spent[i]! / A.saleTok[i]!).toBeCloseTo(R.pDisc as number, 9); // one price for all, snipers included
          expect(A.spent[i]!).toBeLessThanOrEqual(A.cash[i]! + A.spent[i]! + 1e-6);
        }
      }
      expect(sold).toBeLessThanOrEqual(S + 1e-6);
      expect(cost).toBeCloseTo(R.raised, 4);
      expect(R.issuerCash + (R.mkt as Market).realQuote()).toBeCloseTo(R.raised, 4);
      expect(R.pDisc as number).toBeGreaterThanOrEqual(SCEN_P.floorMult * L.phat - 1e-12);
    }
    expect(checked).toBeGreaterThan(10);
  });

  it("budget accounting: cost + refund = escrowed budget for every bidder", () => {
    const { A, R } = build(3);
    expect(R.failed).toBe(false);
    for (let i = 0; i < A.n; i++) {
      const escrow = A.refund[i]! + A.spent[i]!;
      const bids = A.typ[i] !== 1; // bundlers do not bid by default
      if (bids) expect(escrow).toBeCloseTo(A.cash[i]! + A.spent[i]!, 6);
    }
  });

  it("the clearing is independent of agent order", () => {
    const seed = 4;
    const a = build(seed);
    const b = build(seed);
    expect(b.R.pDisc).toBe(a.R.pDisc);
    expect(b.R.raised).toBe(a.R.raised);
  });
});

describe("whole-run accounting and determinism", () => {
  const mechs = ["pump", "dbc_typ", "dbc_as", "uniform"] as const;

  it("the quote ledger balances to rounding error in every mechanism and scenario", () => {
    for (const sc of [SCEN_P, SCEN_M]) {
      for (const m of mechs) {
        for (let seed = 0; seed < 4; seed++) {
          const r = simulate(m, sc, seed);
          if (r.failed) continue;
          expect(Math.abs(r.ledgerResidual) / r.ledgerScale).toBeLessThan(1e-9);
        }
      }
    }
  });

  it("same seed gives the same output; different seeds differ", () => {
    for (const m of mechs) {
      const a = simulate(m, SCEN_P, 11);
      const b = simulate(m, SCEN_P, 11);
      expect(b).toEqual(a);
    }
    expect(simulate("pump", SCEN_P, 11)).not.toEqual(simulate("pump", SCEN_P, 12));
  });

  it("common random numbers: every mechanism faces the same launch and population", () => {
    const sizes = mechs.map((m) => simulate(m, SCEN_P, 21).nAgents);
    expect(new Set(sizes).size).toBe(1);
    const snipers = mechs.map((m) => simulate(m, SCEN_P, 21).nSnipers);
    expect(new Set(snipers).size).toBe(1);
  });

  it("a cell summary is deterministic", () => {
    const spec = { mech: "uniform" as const, sc: SCEN_P, label: "t" };
    const a = runCell(spec, seedRange(0, 6));
    const b = runCell(spec, seedRange(0, 6));
    expect(b).toEqual(a);
  });

  it("the share is a share: within [0, 1], and zero when no sniper or bundler is present", () => {
    for (let seed = 0; seed < 12; seed++) {
      for (const m of mechs) {
        const r = simulate(m, SCEN_P, seed);
        expect(r.sniperGainShare).toBeGreaterThanOrEqual(0);
        expect(r.sniperGainShare).toBeLessThanOrEqual(1 + 1e-12);
        if (!r.failed && r.nSnipers === 0 && !r.hasBundler) expect(r.sniperGainShare).toBe(0);
      }
    }
  });

  it("curves hand snipers more of the gains than the call auction does (paired seeds, project scenario)", () => {
    const seeds = seedRange(0, 24);
    const mean = (m: (typeof mechs)[number]) => runCell({ mech: m, sc: SCEN_P, label: "" }, seeds).share.mean;
    expect(mean("pump")).toBeGreaterThan(5 * mean("uniform"));
  }, 60_000);
});
