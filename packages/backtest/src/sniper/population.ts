/**
 * Launch and population draw. A port of research/scripts/sim/sim.py:draw_launch and draw_population
 * (lines 101-181), minus the late-whale and sybil-split sensitivity switches, which are not needed
 * for the sniper metric.
 */
import { BUNDLER, INFORMED, MECH, Q, RETAIL, SNIPER, WHALE, type Scenario } from "./params.js";
import type { Rng } from "./prng.js";

export interface Launch {
  v0: number; // latent fair FDV in USD
  pstar: number; // latent fair price per token
  phat: number; // the issuer's noisy estimate of pstar
  hype: number | null;
  dm: number; // demand multiplier
}

export interface Agents {
  n: number;
  typ: Int8Array;
  ident: Int32Array;
  vm: Float64Array; // valuation multiplier on fair price (Infinity for bots)
  u: Float64Array; // arrival quantile
  flip: Uint8Array;
  gain: Float64Array; // take-profit step for snipers / bundlers
  tol: Float64Array; // highest fee the agent will pay
  cash: Float64Array; // cash still deployable
  spent: Float64Array;
  recv: Float64Array;
  tok: Float64Array;
  basis: Float64Array;
  refund: Float64Array;
  tArr: Float64Array;
  tFirst: Float64Array;
  tForce: Float64Array;
  cool: Float64Array;
  done: Uint8Array;
  saleTok: Float64Array;
  tgt: Float64Array;
}

export function pumpStartPrice(): number {
  return (MECH.pump.virtualSol * MECH.solUsd) / MECH.pump.virtualTokens;
}

export function drawLaunch(sc: Scenario, rng: Rng): Launch {
  let v0: number;
  let hype: number | null;
  if (sc.meme) {
    hype = Math.exp(rng.normal(sc.hypeMu, sc.hypeSig));
    v0 = hype * pumpStartPrice() * Q;
  } else {
    hype = null;
    v0 = Math.exp(rng.normal(Math.log(sc.v0Med), sc.v0Sig));
  }
  const pstar = v0 / Q;
  const phat = pstar * Math.exp(rng.normal(0, sc.issuerSig));
  const dm = sc.demandSig > 0 ? Math.exp(rng.normal(sc.demandMu, sc.demandSig)) : Math.exp(sc.demandMu);
  return { v0, pstar, phat, hype, dm };
}

interface Row {
  typ: number;
  ident: number;
  budget: number;
  vm: number;
  u: number;
  flip: number;
  gain: number;
  tol: number;
}

export function drawPopulation(sc: Scenario, L: Launch, rng: Rng): Agents {
  const rows: Row[] = [];
  let ident = 0;
  const dm = L.dm;

  // snipers: bots at block 0. Present in 18/35 launches; when present 1 + Poisson(3.3) (R3).
  const nSn = rng.random() < sc.sniperPresence ? 1 + rng.poisson(sc.nSniper) : 0;
  for (let i = 0; i < nSn; i++) {
    rows.push({
      typ: SNIPER,
      ident,
      budget: rng.lognormalMedian(sc.sniperBudgetMed, 0.8) * Math.sqrt(dm),
      vm: Infinity,
      u: rng.uniform(0, 1e-5),
      flip: 0,
      gain: rng.uniform(sc.sniperGainLo, sc.sniperGainHi),
      tol: rng.uniform(sc.sniperFeeTolLo, sc.sniperFeeTolHi),
    });
    ident++;
  }
  // creator bundle: one identity, many wallets
  const farm = rng.random() < sc.farmShare;
  if (farm || rng.random() < sc.bundlerProb) {
    const b = farm ? 1e9 : rng.lognormalMedian(sc.bundlerBudgetMed, 0.8) * Math.sqrt(dm);
    const w = sc.bundlerWallets;
    for (let i = 0; i < w; i++) {
      rows.push({
        typ: BUNDLER,
        ident,
        budget: b / w,
        vm: Infinity,
        u: 0,
        flip: 0,
        gain: rng.uniform(0.3, 2.0), // sim.py:133
        tol: 1.0,
      });
    }
    ident++;
  }
  // retail
  const nr = sc.meme ? rng.poisson(Math.min(sc.nRetailPerHype * (L.hype as number), 4000)) : rng.poisson(sc.nRetail);
  for (let k = 0; k < nr; k++) {
    const budget = Math.exp(rng.normal(Math.log(sc.retailBudgetMed), sc.retailBudgetSig)) * dm;
    const vm = Math.exp(rng.normal(sc.retailValMu, sc.retailValSig));
    const u = rng.random();
    const flip = rng.random() < sc.retailFlipShare ? 1 : 0;
    const naive = rng.random() < sc.retailNaiveShare;
    rows.push({ typ: RETAIL, ident, budget, vm, u, flip, gain: 0, tol: naive ? 1.0 : sc.retailFeeTol });
    ident++;
  }
  // informed
  const nInf = rng.poisson(sc.nInformed);
  for (let i = 0; i < nInf; i++) {
    rows.push({
      typ: INFORMED,
      ident,
      budget: rng.lognormalMedian(sc.informedBudgetMed, 0.8) * dm,
      vm: Math.exp(rng.normal(0, sc.informedValSig)),
      u: rng.random(),
      flip: 0,
      gain: 0,
      tol: 0.02,
    });
    ident++;
  }
  // whales
  const nw = !sc.meme ? 1 + rng.poisson(sc.nWhaleExtra) : rng.random() < sc.whaleProb ? 1 : 0;
  for (let i = 0; i < nw; i++) {
    const b = rng.lognormalMedian(sc.whaleBudgetMed, 0.7) * dm;
    const vmw = Math.exp(rng.normal(0, sc.whaleValSig));
    const uw = rng.random();
    rows.push({ typ: WHALE, ident, budget: b, vm: vmw, u: uw, flip: 0, gain: 0, tol: 0.02 });
    ident++;
  }

  const n = rows.length;
  const A: Agents = {
    n,
    typ: new Int8Array(n),
    ident: new Int32Array(n),
    vm: new Float64Array(n),
    u: new Float64Array(n),
    flip: new Uint8Array(n),
    gain: new Float64Array(n),
    tol: new Float64Array(n),
    cash: new Float64Array(n),
    spent: new Float64Array(n),
    recv: new Float64Array(n),
    tok: new Float64Array(n),
    basis: new Float64Array(n),
    refund: new Float64Array(n),
    tArr: new Float64Array(n).fill(Infinity),
    tFirst: new Float64Array(n).fill(Infinity),
    tForce: new Float64Array(n).fill(Infinity),
    cool: new Float64Array(n),
    done: new Uint8Array(n),
    saleTok: new Float64Array(n),
    tgt: new Float64Array(n).fill(Infinity),
  };
  for (let i = 0; i < n; i++) {
    const r = rows[i]!;
    A.typ[i] = r.typ;
    A.ident[i] = r.ident;
    A.vm[i] = r.vm;
    A.u[i] = r.u;
    A.flip[i] = r.flip;
    A.gain[i] = r.gain;
    A.tol[i] = r.tol;
    A.cash[i] = r.budget;
  }
  return A;
}
