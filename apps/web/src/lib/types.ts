import type { SafetyReport } from './safety';
// Shapes returned by the API's cross endpoints (all integers are decimal strings).
export type CrossDetail = {
  address: string;
  state: 'Live' | 'Cleared' | 'NoPrint' | 'Finalized';
  disclosure: 'open' | 'sealed';
  kind: string;
  supplyMode: string;
  creator: string;
  baseMint: string | null;
  quoteMint: string;
  window: { openTs: string; closeTs: string; revealEndTs: string };
  grid: { minPrice: string; tick: string; ticks: number; priceScale: string };
  decimals: { base: number; quote: number };
  fees: { protocolBps: number; integratorBps: number; integrator: string };
  orders: { total: number; open: number; max: number };
  clearing: { price: string; matched: string; rationed: 'none' | 'buy' | 'sell' } | null;
  noPrintReason: string | null;
  gateMint: string | null;
  oracleGuard: boolean;
  settlement: { settleDeadlineTs: string; baseBound: boolean };
  /** Fairness figures for this cross once it has printed and finalized; null before, and null if the index could not be read. */
  fairness?: CrossFairness | null;
  /** What the base token's issuer can do to holders (from /v1/tokens/:mint/safety); null when the mint is unbound or unreadable. */
  safety?: SafetyReport | null;
};

export type BookResponse = {
  disclosure: 'open' | 'sealed';
  levels: { price: string; buy: string; sell: string; buyOrders: number; sellOrders: number }[];
  indicative: { price: string; matched: string } | null;
  note: string;
};

export type OwnerOrder = {
  cross_address: string;
  idx: number;
  address: string;
  side: 'buy' | 'sell';
  escrow: string;
  sealed: boolean;
  price: string | null;
  quantity: string | null;
  status: 'committed' | 'revealed' | 'cancelled' | 'claimed';
  fill: string | null;
  quote_out: string | null;
  base_out: string | null;
  fee: string | null;
};

// ---- measured metrics (GET /v1/metrics/*). Counts are numbers, ratios are 0..1, atoms are decimal strings; null means "no data", never zero.
export type Quantiles = { median: number | null; p10: number | null };

export type ExecutionMetrics = {
  network: string;
  generatedAt: string;
  method: string;
  crosses: number;
  finalizedWithoutPrint: number;
  bids: { placed: number; filled: number; fillRate: number | null; fullyFilled: number; partiallyFilled: number; notFilledPricedOut: number; cancelled: number; unrevealed: number; unaccounted: number };
  priceImprovement: {
    filledBids: number;
    atClearingPrice: number;
    bps: Quantiles;
    quoteAtoms: { median: string | null; p10: string | null; quoteDecimals: number[] };
    inconsistent: number;
  };
  refundShare: { crosses: number; median: number | null; min: number | null; max: number | null };
  closeToFinalizedSeconds: { n: number; median: number | null; p90: number | null; max: number | null; excluded: number };
  closeToClearedSeconds: { n: number; median: number | null; p90: number | null; max: number | null; excluded: number };
};

export type SideShare = { wallets: number; top1: number | null; top5: number | null; top10: number | null };

export type CrossFairness = {
  address: string;
  bidders: number;
  sellers: number;
  wallets: number;
  buy: SideShare;
  sell: SideShare;
  bothSides: number;
  identity: { count: number; basis: 'gate-passing wallets' | 'wallets, not people'; gated: boolean };
};

export type FairnessMetrics = {
  network: string;
  generatedAt: string;
  method: string;
  crosses: number;
  threshold: number;
  topBuyerAboveThreshold: { k: number; n: number; proportion: number | null; wilsonLo: number | null; wilsonHi: number | null };
  medianBuySide: { top1: number | null; top5: number | null; top10: number | null; crossesOver1: number; crossesOver5: number; crossesOver10: number };
  crossesWithSelfCross: number;
  wallets: { distinctAcrossCrosses: number; medianBiddersPerCross: number | null; maxBiddersInACross: number | null };
  perCross: CrossFairness[];
};

export type ExternalFlowMetrics = {
  network: string;
  generatedAt: string;
  method: string;
  ownWalletsConfigured: number;
  crosses: { withOrders: number; withAnExternalWallet: number; onlyOwnWallets: number };
  wallets: { total: number; own: number; external: number; externalShare: number | null };
  filledWallets: { total: number; own: number; external: number };
  orders: { total: number; byExternal: number; filled: number; filledByExternal: number };
  verdict: 'no external wallets seen' | 'external wallets seen, ownership list not configured (upper bound)' | 'external wallets seen, not known to be ours (upper bound on outside users)';
};
