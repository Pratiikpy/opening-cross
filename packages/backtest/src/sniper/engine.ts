/**
 * One launch from sale to day 30. A port of research/scripts/sim/sim.py:simulate (lines 521-811)
 * for the mechanisms the sniper metric compares: pump.fun, DBC (typical and anti-sniper) and the
 * uniform-price call auction.
 *
 * Determinism: every random source is a stream addressed by (seed, id) so one integer seed fixes
 * the launch, the population, the mechanism's draws and the post-launch noise. The same seed gives
 * the same launch and population for every mechanism (common random numbers), so differences
 * between mechanisms are paired.
 */
import {
  BUNDLER,
  DAY,
  DEFAULT_AUCTION,
  HORIZON_DAYS,
  HOUR,
  INFORMED,
  Q,
  RETAIL,
  SNIPER,
  WHALE,
  type AuctionOptions,
  type Scenario,
} from "./params.js";
import {
  MECH_INDEX,
  mechDbcAs,
  mechDbcTyp,
  mechPump,
  mechUniform,
  type Leaks,
  type MechName,
  type MechResult,
} from "./mechanisms.js";
import { drawLaunch, drawPopulation, type Agents } from "./population.js";
import { Rng } from "./prng.js";

export interface SimResult {
  mech: MechName;
  seed: number;
  failed: boolean;
  nAgents: number;
  nSnipers: number;
  hasBundler: boolean;
  /** Sniper gain share: positive P&L of snipers and bundlers / positive P&L of all participants (R2 section 2). */
  sniperGainShare: number;
  fastPositivePnl: number;
  allPositivePnl: number;
  sniperPnl: number;
  sniperSpent: number;
  retailPnl: number;
  retailSpent: number;
  retailRoi: number;
  sniperShareSale: number;
  raised: number;
  issuerProceeds: number;
  pDisc: number;
  discRatio: number;
  graduated: boolean | null;
  /** Quote-conservation residual in USD; ~0 when the books balance. */
  ledgerResidual: number;
  /** Total quote that moved through participants, for scaling the residual. */
  ledgerScale: number;
}

export interface SimOptions {
  auction?: Partial<AuctionOptions> | undefined;
  horizonDays?: number | undefined;
}

const RETRY_CAP = 3600;

export function simulate(mech: MechName, sc: Scenario, seed: number, options: SimOptions = {}): SimResult {
  const auction: AuctionOptions = { ...DEFAULT_AUCTION, ...(options.auction ?? {}) };
  const horizonDays = options.horizonDays ?? HORIZON_DAYS;

  const L = drawLaunch(sc, new Rng(seed, 1));
  const A = drawPopulation(sc, L, new Rng(seed, 2));
  const rng = new Rng(seed, 3, MECH_INDEX[mech]);
  const leaks: Leaks = { migration: 0 };

  let R: MechResult;
  switch (mech) {
    case "pump":
      R = mechPump(A, sc, rng, leaks);
      break;
    case "dbc_typ":
      R = mechDbcTyp(A, sc, L, rng, leaks);
      break;
    case "dbc_as":
      R = mechDbcAs(A, sc, L, rng, leaks);
      break;
    case "uniform":
      R = mechUniform(A, sc, L, rng, auction);
      break;
  }

  const nSnipers = countType(A, SNIPER);
  const hasBundler = countType(A, BUNDLER) > 0;
  const empty = (): SimResult => ({
    mech,
    seed,
    failed: true,
    nAgents: A.n,
    nSnipers,
    hasBundler,
    sniperGainShare: 0,
    fastPositivePnl: 0,
    allPositivePnl: 0,
    sniperPnl: 0,
    sniperSpent: 0,
    retailPnl: 0,
    retailSpent: 0,
    retailRoi: 0,
    sniperShareSale: 0,
    raised: 0,
    issuerProceeds: 0,
    pDisc: NaN,
    discRatio: NaN,
    graduated: null,
    ledgerResidual: 0,
    ledgerScale: 0,
  });
  if (R.failed || R.mkt === null) return empty();

  const mkt = R.mkt;
  const curve = R.curve;
  const pstar0 = L.pstar;
  const n = A.n;
  const isFast = (i: number) => A.typ[i] === SNIPER || A.typ[i] === BUNDLER;
  const isBuyer = (i: number) => A.typ[i] === RETAIL || A.typ[i] === INFORMED || A.typ[i] === WHALE;

  // who shows up in the post-launch market and when
  if (!curve) {
    const rArr = new Rng(seed, 4);
    for (let i = 0; i < n; i++) {
      const interested = isBuyer(i) && A.cash[i]! > 1.0;
      A.tArr[i] = interested ? rArr.exponential(2 * HOUR) : Infinity;
      if (A.tok[i]! > 0) A.tArr[i] = 0;
    }
  }
  // forced exit delays relative to first buy (sim.py:545-549)
  const rngF = new Rng(seed, 5);
  const snDelay = new Float64Array(n);
  const bunDelay = new Float64Array(n);
  const flipDelay = new Float64Array(n);
  for (let i = 0; i < n; i++) snDelay[i] = Math.exp(rngF.normal(Math.log(sc.sniperExitMedS), sc.sniperExitSig));
  for (let i = 0; i < n; i++) bunDelay[i] = rngF.uniform(0.05, 1.0);
  for (let i = 0; i < n; i++) flipDelay[i] = rngF.uniform(1 / 24, 1.0);
  const forceDelay = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    forceDelay[i] =
      A.typ[i] === SNIPER
        ? Math.min(snDelay[i]!, DAY)
        : A.typ[i] === BUNDLER
          ? bunDelay[i]! * DAY
          : flipDelay[i]! * DAY;
    // auction-won sniper allocation: optional longer hold (sensitivity; the original uses the R3 exit time)
    if (!curve && A.typ[i] === SNIPER && auction.sniperHoldDays !== null) forceDelay[i] = auction.sniperHoldDays * DAY;
  }
  for (let i = 0; i < n; i++) A.tForce[i] = A.tok[i]! > 0 ? forceDelay[i]! : Infinity; // auction holders: from open

  let vr = 1.0; // fair value ratio V_t / V0
  let tauV: number | null = null;
  if (sc.meme && sc.valDecayDays) {
    tauV = sc.valDecayDays * Math.exp(new Rng(seed, 6).normal(0, sc.valDecaySig));
  }
  const rngM = new Rng(seed, 7);
  let arbCash = sc.arbCapShare * L.v0;
  let arbTok = 0;
  let gradT: number | null = null;
  let saleSnapshot: { p: number; t: number } | null = null;

  // quote flows of actors that are not in the agent arrays, for the conservation check
  let noiseNet = 0; // paid - received
  let arbNet = 0;

  const fstar = (t: number): number => {
    let v = vr;
    if (tauV !== null) v *= Math.exp(-t / (tauV * DAY));
    return pstar0 * v;
  };
  const curFee = (t: number): number => {
    const live = mkt.live();
    const ps = live.length > 0 ? live : mkt.pools;
    let f = Infinity;
    for (const p of ps) f = Math.min(f, p.feeAt(t));
    return f;
  };
  const isCurveLive = (): boolean => curve && mkt.pools.some((p) => p.yv > 0 && !p.soldout);

  const doBuy = (i: number, t: number, limit: number | null): void => {
    let feeOv: number | null = null;
    if (A.typ[i] === BUNDLER && R.firstSwapMinFee !== null) feeOv = R.firstSwapMinFee; // PROTO: enable_first_swap_with_min_fee
    const [tk, sp] = mkt.buy(A.cash[i]!, t, feeOv, limit);
    if (tk <= 0) return;
    A.tok[i] = A.tok[i]! + tk;
    A.spent[i] = A.spent[i]! + sp;
    A.basis[i] = A.basis[i]! + sp;
    A.cash[i] = A.cash[i]! - sp;
    if (!Number.isFinite(A.tFirst[i]!)) {
      A.tFirst[i] = t;
      A.tForce[i] = t + forceDelay[i]!;
    }
    if (isFast(i)) A.tgt[i] = (A.basis[i]! / A.tok[i]!) * (1 + A.gain[i]!);
    if (curve && saleSnapshot === null) A.saleTok[i] = A.saleTok[i]! + tk;
  };

  const retry: Array<[number, number]> = [];

  const tryBuy = (i: number, t: number): void => {
    if (A.done[i] || A.cash[i]! < 1.0 || t < A.cool[i]!) return;
    const f = curFee(t);
    if (f > A.tol[i]!) {
      for (let dt = 1; dt <= RETRY_CAP; dt++) {
        if (curFee(t + dt) <= A.tol[i]!) {
          retry.push([t + dt, i]);
          break;
        }
      }
      return;
    }
    if (isFast(i)) {
      if (Number.isFinite(A.tFirst[i]!)) return;
      doBuy(i, t, null);
      return;
    }
    doBuy(i, t, A.vm[i]! * fstar(t));
  };

  const sell = (i: number, t: number, fracReq = 1.0): void => {
    if (A.tok[i]! <= 0) return;
    const [got, sold] = mkt.sell(A.tok[i]! * fracReq, t);
    if (sold <= 0) return;
    const frac = sold / A.tok[i]!;
    A.recv[i] = A.recv[i]! + got;
    A.basis[i] = A.basis[i]! * (1 - frac);
    A.tok[i] = A.tok[i]! - sold;
    if (isFast(i) || A.flip[i]) {
      if (A.tok[i]! <= 1e-9 * Math.max(A.saleTok[i]!, 1.0)) {
        A.tok[i] = 0;
        A.done[i] = 1;
      }
    } else {
      A.cash[i] = A.cash[i]! + got;
      A.cool[i] = t + DAY;
    }
  };

  const triggers = (t: number): void => {
    const p0 = mkt.price();
    const fs = fstar(t);
    const idx: number[] = [];
    for (let i = 0; i < n; i++) {
      if (A.tok[i]! <= 1e-9) continue;
      const entry = A.tok[i]! > 0 ? A.basis[i]! / Math.max(A.tok[i]!, 1e-12) : 0;
      let hit: boolean;
      if (isFast(i)) hit = p0 >= A.tgt[i]! || t >= A.tForce[i]!;
      else if (A.flip[i])
        hit = p0 >= entry * sc.flipTake || t >= A.tForce[i]! || p0 <= entry * sc.flipStop;
      else hit = p0 >= A.vm[i]! * fs * sc.holderOvervalSell;
      if (hit) idx.push(i);
    }
    if (idx.length === 0) return;
    rngM.shuffle(idx);
    for (const i of idx) {
      const p = mkt.price();
      const e = A.basis[i]! / Math.max(A.tok[i]!, 1e-12);
      if (isFast(i)) {
        if (t >= A.tForce[i]!) sell(i, t);
        else if (p >= A.tgt[i]!) {
          sell(i, t, 0.25); // laddered profit taking: sell 25%, raise the target
          A.tgt[i] = A.tgt[i]! * (1 + A.gain[i]!);
        }
        continue;
      }
      let ok: boolean;
      if (A.flip[i]) ok = p >= e * sc.flipTake || t >= A.tForce[i]! || p <= e * sc.flipStop;
      else ok = p >= A.vm[i]! * fstar(t) * sc.holderOvervalSell;
      if (ok) sell(i, t);
    }
  };

  // event list: arrivals in time order
  const order: number[] = [];
  for (let i = 0; i < n; i++) if (Number.isFinite(A.tArr[i]!) && A.tArr[i]! < horizonDays * DAY) order.push(i);
  order.sort((a, b) => A.tArr[a]! - A.tArr[b]! || a - b);
  let evPtr = 0;
  const nh = horizonDays * 24;
  const hazard = 1 - Math.exp(-sc.holdHazardDay / 24);

  for (let h = 0; h < nh; h++) {
    const tEnd = (h + 1) * HOUR;
    for (;;) {
      const nxtEv = evPtr < order.length ? A.tArr[order[evPtr]!]! : Infinity;
      retry.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      const nxtRt = retry.length > 0 ? retry[0]![0] : Infinity;
      const tn = Math.min(nxtEv, nxtRt);
      if (tn >= tEnd) break;
      let i: number;
      if (nxtEv <= nxtRt) {
        i = order[evPtr]!;
        evPtr++;
      } else {
        i = retry.shift()![1];
      }
      tryBuy(i, tn);
      triggers(tn);
      if (curve && gradT === null && !isCurveLive()) gradT = tn;
    }
    const t = tEnd;
    if (curve && gradT === null && !isCurveLive()) gradT = t;
    if (curve && saleSnapshot === null && (gradT !== null || t >= DAY)) {
      saleSnapshot = { p: mkt.price(), t: gradT === null ? t : gradT };
    }
    // fair value update: geometric Brownian motion with drift
    vr *= Math.exp(sc.valMuDay / 24 + (sc.valSigDay / Math.sqrt(24)) * rngM.stdNormal());
    const fs = fstar(t);
    // noise traders: demand-driven volume, round trip plus a random net position
    const att = Math.exp(-t / (sc.attTauDays * DAY)) + sc.attFloor;
    let volH = (sc.turnover / 24) * att * fs * Q;
    volH = !isCurveLive() ? Math.min(volH, 0.5 * Math.max(mkt.realQuote(), 0) + 1) : Math.min(volH, 5e4);
    if (volH > 1.0) {
      const [tk, sp] = mkt.buy(volH / 2, t);
      noiseNet += sp;
      const [g1] = mkt.sell(tk, t);
      noiseNet -= g1;
      const net = volH * 0.3 * rngM.stdNormal();
      if (net > 0) {
        const [, sp2] = mkt.buy(net, t);
        noiseNet += sp2;
      } else if (net < 0) {
        const [g2] = mkt.sell(-net / Math.max(mkt.price(), 1e-12), t);
        noiseNet -= g2;
      }
    }
    // value arbitrage (capital-limited, long-only)
    let p = mkt.price();
    if (arbCash > 1 && p < fs * 0.97) {
      const usd = Math.min(arbCash, sc.arbKappa * Math.max(mkt.realQuote(), 1.0) * Math.log(fs / p));
      const [tk, sp] = mkt.buy(usd, t, null, fs);
      arbCash -= sp;
      arbTok += tk;
      arbNet += sp;
    } else if (arbTok > 0 && p > fs * 1.03) {
      const usd = sc.arbKappa * Math.max(mkt.realQuote(), 1.0) * Math.log(p / fs);
      const [got, sold] = mkt.sell(Math.min(arbTok, usd / p), t);
      arbTok -= sold;
      arbCash += got;
      arbNet -= got;
    }
    // holder hazard exits and dip buying
    for (let i = 0; i < n; i++) {
      const hold = A.tok[i]! > 0 && !isFast(i) && rngM.random() < hazard;
      if (hold) sell(i, t);
    }
    p = mkt.price();
    let nd = 0;
    for (let i = 0; i < n && nd < 200; i++) {
      if (
        isBuyer(i) &&
        A.tArr[i]! <= t &&
        !A.done[i] &&
        A.cash[i]! > 1.0 &&
        A.cool[i]! <= t &&
        A.vm[i]! * fs > p * 1.02
      ) {
        nd++;
        tryBuy(i, t);
      }
    }
    triggers(t);
  }

  // ---------------- metrics ----------------
  const p30 = mkt.price();
  let pDisc: number;
  let raised: number;
  let issuer: number;
  let graduated: boolean | null = null;
  if (curve) {
    pDisc = saleSnapshot !== null ? (saleSnapshot as { p: number }).p : mkt.price();
    graduated = gradT !== null;
    raised = graduated
      ? mkt.retired.filter((p) => p.yv > 0).reduce((s, p) => s + p.realQuote(), 0)
      : mkt.pools.filter((p) => p.yv > 0).reduce((s, p) => s + p.realQuote(), 0);
    issuer = mkt.feesIssuer();
  } else {
    pDisc = R.pDisc as number;
    raised = R.raised;
    issuer = R.issuerCash + mkt.feesIssuer();
  }

  let allPos = 0;
  let fastPos = 0;
  let sniperPnl = 0;
  let sniperSpent = 0;
  let retailPnl = 0;
  let retailSpent = 0;
  let saleAll = 0;
  let saleFast = 0;
  let sumSpent = 0;
  let sumRecv = 0;
  for (let i = 0; i < n; i++) {
    const pnl = A.recv[i]! + A.tok[i]! * p30 - A.spent[i]!;
    if (pnl > 0) allPos += pnl;
    saleAll += A.saleTok[i]!;
    sumSpent += A.spent[i]!;
    sumRecv += A.recv[i]!;
    if (isFast(i)) {
      if (pnl > 0) fastPos += pnl;
      sniperPnl += pnl;
      sniperSpent += A.spent[i]!;
      saleFast += A.saleTok[i]!;
    }
    if (A.typ[i] === RETAIL) {
      retailPnl += pnl;
      retailSpent += A.spent[i]!;
    }
  }

  // Quote conservation: what traders paid in net equals what the venue holds or has been paid out.
  const located =
    (curve ? 0 : R.issuerCash) +
    mkt.pools.reduce((s, p) => s + p.realQuote(), 0) +
    leaks.migration +
    mkt.feesIssuer() +
    mkt.feesOther();
  const paidIn = sumSpent - sumRecv + noiseNet + arbNet;

  return {
    mech,
    seed,
    failed: false,
    nAgents: n,
    nSnipers,
    hasBundler,
    sniperGainShare: allPos > 0 ? fastPos / allPos : 0,
    fastPositivePnl: fastPos,
    allPositivePnl: allPos,
    sniperPnl,
    sniperSpent,
    retailPnl,
    retailSpent,
    retailRoi: retailPnl / Math.max(retailSpent, 1.0),
    sniperShareSale: saleAll > 0 ? saleFast / saleAll : 0,
    raised,
    issuerProceeds: issuer,
    pDisc,
    discRatio: pDisc / pstar0,
    graduated,
    ledgerResidual: paidIn - located,
    ledgerScale: Math.max(Math.abs(sumSpent) + Math.abs(sumRecv) + Math.abs(noiseNet) + Math.abs(arbNet), 1),
  };
}

function countType(A: Agents, t: number): number {
  let c = 0;
  for (let i = 0; i < A.n; i++) if (A.typ[i] === t) c++;
  return c;
}
