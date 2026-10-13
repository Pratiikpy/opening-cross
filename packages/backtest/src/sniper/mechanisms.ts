/**
 * Primary-sale mechanisms: pump.fun curve, Meteora DBC (typical and anti-sniper) and the
 * uniform-price call auction. Ports of research/scripts/sim/sim.py:217-263 and 328-408.
 */
import { clearAdr, clearBudget, fillBuy, type Clearing, type Level } from "./clearing.js";
import { BUNDLER, INFORMED, MECH, Q, RETAIL, SNIPER, WHALE, type AuctionOptions, type Scenario } from "./params.js";
import type { Agents, Launch } from "./population.js";
import { Market, Pool, cpCurve, expFeeFn } from "./pool.js";
import type { Rng } from "./prng.js";

export type MechName = "pump" | "dbc_typ" | "dbc_as" | "uniform";
export const MECH_INDEX: Record<MechName, number> = { pump: 0, dbc_typ: 1, dbc_as: 2, uniform: 4 };

/** Quote that leaves the system at pool migration (fees paid to the protocol), for the accounting check. */
export interface Leaks {
  migration: number;
}

export interface MechResult {
  failed: boolean;
  mkt: Market | null;
  curve: boolean;
  refunds: number;
  issuerCash: number;
  pDisc: number | null;
  raised: number;
  saleTokens: number;
  firstSwapMinFee: number | null;
  clearing: Clearing | null;
}

const failedResult = (refunds: number): MechResult => ({
  failed: true,
  mkt: null,
  curve: false,
  refunds,
  issuerCash: 0,
  pDisc: null,
  raised: 0,
  saleTokens: 0,
  firstSwapMinFee: null,
  clearing: null,
});

const buyerMask = (typ: number) => typ === RETAIL || typ === INFORMED || typ === WHALE;

/** Curve arrivals: t = horizon * u^pow; snipers land 1-5 slots in, the creator bundle at t = 0 (sim.py:210-214). */
function curveArrivals(A: Agents, sc: Scenario, rng: Rng): void {
  for (let i = 0; i < A.n; i++) {
    let t = sc.curveHorizon * Math.pow(A.u[i]!, sc.curvePow);
    if (A.typ[i] === SNIPER) t = rng.uniform(0.4, 2.0);
    else if (A.typ[i] === BUNDLER) t = 0;
    A.tArr[i] = t;
  }
}

export function mechPump(A: Agents, sc: Scenario, rng: Rng, leaks: Leaks): MechResult {
  const m = MECH.pump;
  const sol = MECH.solUsd;
  const graduate = (pool: Pool): Pool[] => {
    const q = pool.realQuote() - m.graduationCostSol * sol;
    leaks.migration += pool.realQuote() - q;
    return [
      new Pool(q, m.pumpswapTokens, m.pumpswapFee, "pumpswap", {
        lpFrac: m.pumpswapLpFrac,
        issuerFrac: m.pumpswapIssuerFrac,
      }),
    ];
  };
  const curve = new Pool(m.virtualSol * sol, m.virtualTokens, m.feeRate, "pump_curve", {
    xv: m.virtualSol * sol,
    yv: m.virtualTokens - m.tokensOnCurve,
    issuerFrac: m.creatorFeeShare,
    onSoldout: graduate,
  });
  curveArrivals(A, sc, rng);
  return {
    failed: false,
    mkt: new Market([curve]),
    curve: true,
    refunds: 0,
    issuerCash: 0,
    pDisc: null,
    raised: 0,
    saleTokens: m.tokensOnCurve,
    firstSwapMinFee: null,
    clearing: null,
  };
}

function dbc(
  A: Agents,
  sc: Scenario,
  rng: Rng,
  leaks: Leaks,
  o: { p0: number; p1: number; baseFee: number; antisniper: boolean; postFee: number; name: string },
): MechResult {
  const m = MECH.dbc;
  const sold = m.soldFrac * Q;
  const graduate = (pool: Pool): Pool[] => {
    const rq = pool.realQuote();
    const q = rq * (1 - m.migrationFee);
    leaks.migration += rq - q;
    const p = pool.price();
    return [new Pool(q, q / p, o.postFee, "damm_v2", { lpFrac: 0, issuerFrac: m.issuerFrac })];
  };
  let feeFn: ((t: number) => number) | null = null;
  if (o.antisniper) {
    const n = rng.integers(m.asPeriodsLo, m.asPeriodsHiExclusive);
    feeFn = expFeeFn(m.asCliff, o.baseFee, n);
  }
  const curve = cpCurve(o.p0, o.p1, sold, o.baseFee, o.name, { issuerFrac: m.issuerFrac, feeFn, onSoldout: graduate });
  curveArrivals(A, sc, rng);
  return {
    failed: false,
    mkt: new Market([curve]),
    curve: true,
    refunds: 0,
    issuerCash: 0,
    pDisc: null,
    raised: 0,
    saleTokens: sold,
    firstSwapMinFee: o.antisniper ? o.baseFee : null,
    clearing: null,
  };
}

export function mechDbcTyp(A: Agents, sc: Scenario, _L: Launch, rng: Rng, leaks: Leaks): MechResult {
  const m = MECH.dbc;
  return dbc(A, sc, rng, leaks, {
    p0: m.typP0Usd / Q,
    p1: m.typP1Usd / Q,
    baseFee: m.typBaseFee,
    antisniper: false,
    postFee: m.typBaseFee,
    name: "dbc_typ",
  });
}

export function mechDbcAs(A: Agents, sc: Scenario, L: Launch, rng: Rng, leaks: Leaks): MechResult {
  const m = MECH.dbc;
  const [p0, p1] = sc.meme
    ? [m.typP0Usd / Q, m.typP1Usd / Q]
    : [m.asProjectP0Mult * L.phat, m.asProjectP1Mult * L.phat];
  return dbc(A, sc, rng, leaks, {
    p0,
    p1,
    baseFee: m.asBaseFee,
    antisniper: true,
    postFee: m.asBaseFee,
    name: "dbc_as",
  });
}

const ATOM = 1e6; // base-token atoms per whole token

/**
 * Sealed-bid uniform-price call auction.
 *
 * What a bidder can do here is bid. Everyone who fills pays the same clearing price, there is no
 * arrival-order priority, and the creator bundle gets no early access, so a sniper's only edge is
 * what it knows (its limit price) and what it can do afterwards with the allocation.
 */
export function mechUniform(
  A: Agents,
  sc: Scenario,
  L: Launch,
  rng: Rng,
  opts: AuctionOptions,
): MechResult {
  const S = sc.saleFrac * Q;
  const floor = sc.floorMult * L.phat;
  const n = A.n;
  const u = MECH.uniform;

  const budget = new Float64Array(n);
  const lim = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const t = A.typ[i]!;
    const bids = buyerMask(t) || t === SNIPER || (t === BUNDLER && opts.bundlersBid);
    budget[i] = bids ? A.cash[i]! : 0;
    lim[i] = budget[i]! > 0 ? A.vm[i]! * L.pstar : 0;
  }
  // demand reduction (Wilson 1979): large bidders shade their limit by their market share (sim.py:381-386)
  for (let i = 0; i < n; i++) {
    const t = A.typ[i]!;
    if (t === INFORMED || t === WHALE) {
      const share = budget[i]! / Math.max(S * L.phat, 1);
      const shade = Math.min(Math.max(sc.shadeStrength * share, 0), 0.5);
      lim[i] = lim[i]! * (1 - shade);
    }
  }
  for (let i = 0; i < n; i++) {
    if (budget[i]! <= 0) continue;
    const t = A.typ[i]!;
    if (t === SNIPER) {
      if (opts.sniperBid === "low") lim[i] = L.phat * rng.uniform(u.sniperLimitLoMult, u.sniperLimitHiMult);
      else if (opts.sniperBid === "sincere") lim[i] = L.pstar * Math.exp(rng.normal(0, sc.informedValSig));
      else lim[i] = L.pstar;
    } else if (t === BUNDLER) {
      lim[i] = L.pstar * Math.exp(rng.normal(0, sc.informedValSig));
    }
  }

  let price: number;
  const tokens = new Float64Array(n);
  let clearing: Clearing | null = null;
  const tickBase = 1 + u.tick;

  if (opts.clearing === "budget") {
    const r = clearBudget(budget, lim, S, floor, u.tick);
    price = r.price;
    tokens.set(r.alloc);
  } else {
    const buys: Level[] = [];
    const idxOf = new Int32Array(n).fill(-1);
    const qtyOf: bigint[] = new Array<bigint>(n).fill(0n);
    for (let i = 0; i < n; i++) {
      if (budget[i]! <= 0 || lim[i]! < floor) continue;
      const idx = Math.floor(Math.log(lim[i]! / floor) / Math.log(tickBase) + 1e-9);
      const pIdx = floor * Math.pow(tickBase, idx);
      const qty = BigInt(Math.floor((budget[i]! / pIdx) * ATOM));
      if (qty <= 0n) continue;
      idxOf[i] = idx;
      qtyOf[i] = qty;
      buys.push({ idx, qty });
    }
    const sells: Level[] = [{ idx: 0, qty: BigInt(Math.round(S * ATOM)) }];
    clearing = clearAdr(buys, sells);
    if (clearing === null) {
      return failedResult(budget.reduce((a, b) => a + b, 0));
    }
    price = floor * Math.pow(tickBase, clearing.idx);
    for (let i = 0; i < n; i++) {
      if (idxOf[i]! < 0) continue;
      tokens[i] = Number(fillBuy(idxOf[i]!, qtyOf[i]!, clearing)) / ATOM;
    }
  }

  let raised = 0;
  let totalBudget = 0;
  for (let i = 0; i < n; i++) {
    raised += tokens[i]! * price;
    totalBudget += budget[i]!;
  }
  if (raised < sc.minRaiseMult * L.phat * S) {
    for (let i = 0; i < n; i++) A.refund[i] = A.refund[i]! + budget[i]!;
    return failedResult(totalBudget);
  }
  let saleTokens = 0;
  for (let i = 0; i < n; i++) {
    const cost = tokens[i]! * price;
    A.refund[i] = A.refund[i]! + (budget[i]! - cost);
    A.tok[i] = A.tok[i]! + tokens[i]!;
    A.saleTok[i] = A.saleTok[i]! + tokens[i]!;
    A.spent[i] = A.spent[i]! + cost;
    A.basis[i] = A.basis[i]! + cost;
    A.cash[i] = A.cash[i]! - cost;
    if (tokens[i]! > 0) A.tFirst[i] = 0;
    saleTokens += tokens[i]!;
  }
  const seed = sc.seedShare;
  const usd = seed * raised;
  const pool = new Pool(usd, usd / price, u.poolFee, "uni_pool", { lpFrac: 1.0, issuerFrac: 0 });
  return {
    failed: false,
    mkt: new Market([pool]),
    curve: false,
    refunds: totalBudget - raised,
    issuerCash: (1 - seed) * raised,
    pDisc: price,
    raised,
    saleTokens,
    firstSwapMinFee: null,
    clearing,
  };
}
