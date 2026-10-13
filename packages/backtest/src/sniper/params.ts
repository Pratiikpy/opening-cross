/**
 * Every parameter of the sniper model, in one place, each with its provenance.
 *
 * Source tags
 *   R3     research/R3_wallet_behaviour.md (on-chain sample of 50 launches and 403 MetaDAO claimants)
 *   R2     research/R2_backtest.md (the written description of the original model)
 *   R1     the launch-outcome dataset summarised in R2
 *   PROTO  a public protocol constant, as recorded in R2 and sim.py
 *   ASSUME an assumption of the ORIGINAL model (sim.py marks it "ASSUME"). R2 section 10 lists
 *          valuations, budgets and the issuer estimation noise as assumed. These are the
 *          sensitivity parameters: no document gives an evidence base for the exact value.
 *   FIT    fitted by the original calibration scripts (calib_*.py), not observed
 *   ADR    docs/adr/0003-clearing-rule.md
 *
 * "sim.py:N" cites the line of research/scripts/sim/sim.py that holds the value. The values
 * were copied from that file, not re-derived.
 */

export const Q = 1e9; // token supply, sim.py:30
export const HOUR = 3600;
export const DAY = 86400;
export const HORIZON_DAYS = 30; // R2 section 2 "After launch: 30 days, stepped hourly"

export const SNIPER = 0;
export const BUNDLER = 1;
export const RETAIL = 2;
export const INFORMED = 3;
export const WHALE = 4;

export interface Scenario {
  name: "P" | "M";
  meme: boolean;
  v0Med: number;
  v0Sig: number;
  nRetail: number;
  demandMu: number;
  demandSig: number;
  hypeMu: number;
  hypeSig: number;
  nRetailPerHype: number;
  whaleProb: number;
  retailBudgetMed: number;
  retailBudgetSig: number;
  retailValMu: number;
  retailValSig: number;
  retailFlipShare: number;
  retailFeeTol: number;
  retailNaiveShare: number;
  nInformed: number;
  informedBudgetMed: number;
  informedValSig: number;
  nWhaleExtra: number;
  whaleBudgetMed: number;
  whaleValSig: number;
  nSniper: number;
  sniperPresence: number;
  sniperExitMedS: number;
  sniperExitSig: number;
  sniperBudgetMed: number;
  sniperGainLo: number;
  sniperGainHi: number;
  sniperFeeTolLo: number;
  sniperFeeTolHi: number;
  bundlerProb: number;
  bundlerBudgetMed: number;
  bundlerWallets: number;
  farmShare: number;
  shadeStrength: number;
  curveHorizon: number;
  curvePow: number;
  valSigDay: number;
  valMuDay: number;
  valDecayDays: number | null;
  valDecaySig: number;
  attTauDays: number;
  attFloor: number;
  turnover: number;
  arbCapShare: number;
  arbKappa: number;
  holdHazardDay: number;
  holderOvervalSell: number;
  flipTake: number;
  flipStop: number;
  saleFrac: number;
  floorMult: number;
  issuerSig: number;
  seedShare: number;
  minRaiseMult: number;
}

/** Shared by both scenarios. Mirrors sim.py BASE (lines 43-71). */
const BASE: Scenario = {
  name: "P",
  meme: false,
  v0Med: 5e6, // R2 section 1 "median fair FDV $5M"; sim.py:73
  v0Sig: 1.0, // ASSUME, sim.py:73
  nRetail: 1500, // ASSUME, sim.py:73
  demandMu: 1.0, // ASSUME, sim.py:73
  demandSig: 0.8, // ASSUME, sim.py:73
  hypeMu: 0.0, // FIT, sim.py:77
  hypeSig: 1.2, // FIT, sim.py:77
  nRetailPerHype: 60.0, // FIT, sim.py:78
  whaleProb: 0.1, // ASSUME, sim.py:81
  retailBudgetMed: 250.0, // ASSUME, sim.py:44
  retailBudgetSig: 1.2, // ASSUME, sim.py:44
  retailValMu: 0.1, // R2 section 2 "fair x e^{N(0.1, 0.6)}"; sim.py:45
  retailValSig: 0.6, // R2 section 2; sim.py:45
  retailFlipShare: 0.55, // R3 section 4.4, R2 section 0: 55% of MetaDAO claimants reduce within 24 h; sim.py:46
  retailFeeTol: 0.05, // R2 section 2 "fee tolerance 5%"; sim.py:48
  retailNaiveShare: 0.2, // R2 section 2 "20% naive"; sim.py:48
  nInformed: 20, // ASSUME, sim.py:49
  informedBudgetMed: 10_000, // ASSUME, sim.py:49
  informedValSig: 0.1, // R2 section 2 "informed +-10%"; sim.py:49
  nWhaleExtra: 2, // ASSUME, sim.py:50
  whaleBudgetMed: 150_000, // ASSUME, sim.py:50
  whaleValSig: 0.25, // R2 section 2 "whales +-25%"; sim.py:50
  nSniper: 3.3, // R3 section 4.1, R2 section 0: present => 1 + Poisson(3.3); sim.py:52
  sniperPresence: 18 / 35, // R3 section 4.1: snipers present in 18 of 35 launches; sim.py:52
  sniperExitMedS: 13.5, // R3 section 4.1: median exit 13.5 s; sim.py:53
  sniperExitSig: 2.7, // R2 section 0: lognormal sigma 2.7 (73% < 60 s, p90 ~ 11 min); sim.py:53
  sniperBudgetMed: 5_000, // ASSUME, sim.py:54
  sniperGainLo: 0.3, // ASSUME (laddered take-profit), sim.py:54
  sniperGainHi: 2.0, // ASSUME, sim.py:54
  sniperFeeTolLo: 0.01, // ASSUME, sim.py:55
  sniperFeeTolHi: 0.1, // ASSUME, sim.py:55
  bundlerProb: 0.5, // R2 section 2 "probability 0.5"; sim.py:56
  bundlerBudgetMed: 10_000, // ASSUME, sim.py:56
  bundlerWallets: 10, // R2 section 2 "10 wallets under one identity"; sim.py:56
  farmShare: 0.0, // sim.py:57. NOTE sim.py:82 holds "farm_share=0.012" inside a comment, so it is 0 in the original too
  shadeStrength: 1.0, // R2 section 2 "large bidders shade by their market share"; sim.py:58
  curveHorizon: DAY, // ASSUME, sim.py:60
  curvePow: 3.0, // ASSUME (front-loaded attention), sim.py:60
  valSigDay: 0.04, // R2 section 2 "geometric Brownian motion"; volatility ASSUME, sim.py:62
  valMuDay: -0.01, // R2 section 2 "-1% per day drift"; sim.py:62
  valDecayDays: null, // sim.py:62
  valDecaySig: 1.0, // sim.py:83
  attTauDays: 7.0, // ASSUME, sim.py:63
  attFloor: 0.02, // ASSUME, sim.py:63
  turnover: 0.1, // ASSUME, sim.py:63
  arbCapShare: 0.02, // ASSUME, sim.py:64
  arbKappa: 0.5, // ASSUME, sim.py:64
  holdHazardDay: 0.025, // R3, R2 section 0: 2.5% per day, 62% reduced within 7 days; sim.py:65
  holderOvervalSell: 1.3, // ASSUME, sim.py:66
  flipTake: 1.25, // ASSUME, sim.py:66
  flipStop: 0.5, // ASSUME, sim.py:66
  saleFrac: 0.25, // R2 section 8 "sale fraction 25%"; sim.py:68
  floorMult: 0.5, // R2 section 8 "reserve at 0.5x the issuer's estimate"; sim.py:68
  issuerSig: 0.5, // R2 section 2 "p_hat = p* e^{N(0, 0.5)}"; sim.py:68
  seedShare: 0.2, // ASSUME, sim.py:69
  minRaiseMult: 0.3, // ASSUME, sim.py:69
};

/** Project scenario P, median fair FDV $5M. Mirrors sim.py:73-74. */
export const SCEN_P: Scenario = { ...BASE, name: "P", meme: false };

/** Memecoin scenario M. Mirrors the overrides on BASE at sim.py:76-85. */
export const SCEN_M: Scenario = {
  ...BASE,
  name: "M",
  meme: true,
  curvePow: 10.0, // sim.py:78
  retailBudgetMed: 60.0, // sim.py:79
  retailValMu: 0.1, // sim.py:79
  retailValSig: 0.8, // sim.py:79
  retailFlipShare: 0.875, // R3: 87.5% of early buyers out within 24 h; sim.py:79
  nInformed: 1, // sim.py:80
  informedBudgetMed: 500, // sim.py:80
  nWhaleExtra: 0, // sim.py:80
  whaleBudgetMed: 5_000, // sim.py:81
  sniperBudgetMed: 300, // sim.py:82
  bundlerBudgetMed: 100, // R2 section 0: creator dev buy $100; sim.py:82
  valSigDay: 0.1, // sim.py:83
  valDecayDays: 0.5, // sim.py:83
  valDecaySig: 1.0, // sim.py:83
  attTauDays: 1e9, // sim.py:84
  attFloor: 0.0, // sim.py:84
  turnover: 3.0, // sim.py:84
  arbCapShare: 0.0, // sim.py:84
  holdHazardDay: 0.3, // sim.py:85
  demandMu: 0.0, // sim.py:85
  demandSig: 0.0, // sim.py:85
};

/** Mechanism constants. */
export const MECH = {
  solUsd: 150.0, // ASSUME, sim.py:41 (only sets the USD scale of the pump.fun curve)
  pump: {
    // R2 section 2 "pump.fun: virtual 30 SOL / 1.073B, 793.1M on the curve; 1.25% fee (ASSUMED split)"
    virtualSol: 30, // sim.py:226
    virtualTokens: 1.073e9, // sim.py:226
    tokensOnCurve: 793.1e6, // sim.py:226, 229
    feeRate: 0.0125, // sim.py:226 (ASSUME split)
    creatorFeeShare: 0.3 / 1.25, // sim.py:227 (ASSUME)
    graduationCostSol: 0.015, // sim.py:223
    pumpswapTokens: 206.9e6, // sim.py:224
    pumpswapFee: 0.003, // R2 "then PumpSwap at 0.3%"; sim.py:224
    pumpswapLpFrac: 0.67, // ASSUME, sim.py:224
    pumpswapIssuerFrac: 0.17, // ASSUME, sim.py:224
  },
  dbc: {
    soldFrac: 0.79, // DATA (Jupiter Studio meme preset, R2 section 2); sim.py:234
    migrationFee: 0.002, // PROTO (R5), sim.py:237
    issuerFrac: 0.8, // sim.py:239, 245
    typBaseFee: 0.0025, // DATA: R1 median DBC starting fee; sim.py:253
    typP0Usd: 5e3, // DATA: meme preset $5k mcap start; sim.py:253
    typP1Usd: 75e3, // DATA: meme preset $75k mcap end; sim.py:253
    asBaseFee: 0.01, // sim.py:262
    asCliff: 0.99, // DATA (Jupiter Studio); sim.py:244
    asPeriodsLo: 15, // DATA: randomised 15-60 s periods; sim.py:243
    asPeriodsHiExclusive: 61, // sim.py:243 (integers(15, 61))
    asProjectP0Mult: 0.25, // R2 section 2: issuer prices the curve 0.25 p_hat to 2 p_hat; sim.py:261
    asProjectP1Mult: 2.0, // sim.py:261
  },
  uniform: {
    tick: 0.01, // R2 section 2 "1% ticks"; sim.py:328
    poolFee: 0.003, // sim.py:406
    sniperLimitLoMult: 0.3, // ASSUME ("snipers bid low hoping for a cheap clear"), sim.py:387
    sniperLimitHiMult: 0.9, // ASSUME, sim.py:387
  },
} as const;

/**
 * Auction-side behaviour that the original model fixes by assumption and this model exposes.
 * Defaults reproduce the original model; the alternatives are reported in the evidence file.
 */
export interface AuctionOptions {
  /**
   * How a sniper bids in the sealed auction.
   *  low      limit = p_hat * U(0.3, 0.9): the original model's assumption (sim.py:387)
   *  sincere  limit = fair * exp(N(0, informedValSig)): bids like an informed participant
   *  oracle   limit = exact fair value: perfect information, the most favourable case for the sniper
   */
  sniperBid: "low" | "sincere" | "oracle";
  /** If true the creator bundle bids in the auction like an informed bidder (the original excludes it: sim.py:266, 372). */
  bundlersBid: boolean;
  /** Days an auction-won sniper allocation is held before the forced exit. null = R3 exit time (median 13.5 s). */
  sniperHoldDays: number | null;
  /**
   * adr     bids are (limit, quantity = budget / limit) cleared by the ADR-0003 rule
   * budget  the original model's budget demand curve budget/p, highest price with demand >= supply (sim.py:328-353)
   */
  clearing: "adr" | "budget";
}

export const DEFAULT_AUCTION: AuctionOptions = {
  sniperBid: "low",
  bundlersBid: false,
  sniperHoldDays: null,
  clearing: "adr",
};
