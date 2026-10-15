// The shapes the pool routes answer (services/api/src/routes/pools.ts). Every amount is a decimal string of atoms; nothing here is computed on the page.

export type PoolKind = 'dlmm' | 'damm-v2';
export type PoolStatus = { open: boolean; reason: string | null; opensAtPoint: string | null; pointUnit: 'slot' | 'timestamp' };

export type TokenView = {
  mint: string;
  decimals: number;
  tokenProgram: string;
  reserve: string;
  transferFee: { bps: number; maxFee: string } | null;
  extensions: string[];
  paused: boolean;
};

export type DepthRow = {
  maxSlippageBps: string;
  sellBase: { maxBaseIn: string; quoteOut: string; slippageBps: string };
  buyBase: { maxQuoteIn: string; baseOut: string; slippageBps: string };
};

export type ImpactRow = { percentOfReserve: number; amountIn: string; out: string; slippageBps: string; partial: boolean };

export type LadderBin = {
  binId: number;
  role: 'active' | 'ask' | 'bid';
  quoteAtomsPerBaseAtomQ64: string;
  amountX: string;
  amountY: string;
  orderAmount: string;
  orderSide: 'ask' | 'bid' | null;
  cumulativeX: string;
  cumulativeY: string;
};

export type FeeInfo =
  | { kind: 'dlmm'; baseFeeBps: number; variableFee: string; binStepBps: number; collects: string; protocolSharePercent: number }
  | { kind: 'damm-v2'; cliffFeeBps: number; dynamicFee: boolean; collects: string; protocolFeePercent: number };

export type Persistence =
  | { window: string; observedSeconds: number; samples: number }
  | { window: string; observedSeconds: number; samples: number; limitBps: number; sizeRule: string; sellBaseShare: number; buyBaseShare: number };

export type PoolHealth = {
  schema: 'opening-cross/pool-health/v1';
  network: string;
  at: string;
  chain: { slot: string | null; epoch: string | null; unixTimestamp: string; source: string };
  pool: string;
  kind: PoolKind;
  orientation: string;
  baseIsA: boolean;
  base: TokenView;
  quote: TokenView;
  status: PoolStatus;
  price: { quoteAtomsPerWholeBase: string; quotePerBase: string; source: string };
  fee: FeeInfo;
  liquidity: { baseReserve: string; quoteReserve: string; tvlInQuote: string; counted: string };
  depth: DepthRow[];
  impact: { sellBase: ImpactRow[]; buyBase: ImpactRow[] };
  ladder: LadderBin[] | null;
  persistence: Persistence;
  swapTx: { supported: boolean; reason: string | null };
  sources: string[];
  caveats: string[];
};

/** The compact form of a pool: a list row, the dashboard, the issuer view. */
export type PoolSummary = {
  pool: string;
  kind: PoolKind;
  status: PoolStatus;
  baseMint: string;
  quoteMint: string;
  quotePerBase: string;
  quoteAtomsPerWholeBase: string;
  baseReserve: string;
  quoteReserve: string;
  tvlInQuote: string;
  depthAt100bps: { sellBase: { maxBaseIn: string; quoteOut: string }; buyBase: { maxQuoteIn: string; baseOut: string } };
  fee: FeeInfo;
};

export type PoolsOfPair = { schema: 'opening-cross/pools/v1'; base: string; quote: string; discovery: string; pools: PoolSummary[]; absent: { kind: string; address: string }[]; failed: { address: string; reason: string }[] };
export type PoolsSummaryResponse = { schema: 'opening-cross/pools-summary/v1'; network: string; pairsScanned: number; pools: (PoolSummary & { cross: string; clearingPrice: string | null })[] };

export type PoolVenueRow = {
  rank: number;
  venue: 'cross' | 'jupiter' | 'meteora-dlmm' | 'meteora-damm-v2';
  baseAtoms: string;
  quoteAtoms: string;
  pricePerBase: string;
  fill: 'full' | 'partial';
  cross?: string;
  pool?: string;
  midPricePerBase?: string;
  slippageVsPoolMidBps?: string;
  executableNow?: boolean;
  route?: { pool: string; aToB: boolean; inputMint: string; outputMint: string; amountIn: string; expectedOut: string };
};
export type RouteQuote = {
  schema: 'opening-cross/router-quote/v1';
  intent: { base: string; quote: string; side: 'buy' | 'sell'; amount: string };
  base: { decimals: number };
  venues: PoolVenueRow[];
  excluded: { venue: string; cross?: string; pool?: string; reason: string }[];
  best: { venue: string; cross?: string; pool?: string } | null;
  caveats: string[];
};

export type SwapBuilt = {
  pool: string;
  kind: PoolKind;
  swap: { inputMint: string; outputMint: string; amountIn: string; expectedOut: string; minimumAmountOut: string; toleranceBps: number | null; slippageVsMidBps: string };
};

export type IssuerPool = PoolSummary & { movedFromClearingBps: string | null; askLadder: { bins: number; baseOffered: string; fromBin: number | null; toBin: number | null } | null };
export type IssuerLiquidity = {
  schema: 'opening-cross/issuer-liquidity/v1';
  network: string;
  cross: { address: string; state: 'Live' | 'Cleared' | 'NoPrint' | 'Finalized'; creator: string; baseMint: string | null; quoteMint: string; priceScale: string; clearingPrice: string | null; matched: string | null };
  pools: IssuerPool[];
  absent: { kind: string; address: string }[];
  note: string | null;
};

export type CrossLevel = { price: string; buyQuantity: string; sellQuantity: string; buyOrders: number; sellOrders: number; cumulativeBuy: string; cumulativeSell: string };
export type CrossImpact = { side: 'buy' | 'sell'; size: string; prints: boolean; price: string | null; fill: string; impactBps: string | null };
export type CrossDepthResponse = {
  schema: 'opening-cross/cross-depth/v1';
  available: true;
  cross: string;
  market: { baseMint: string | null; quoteMint: string; baseDecimals: number; quoteDecimals: number };
  state: 'Live' | 'Cleared' | 'NoPrint' | 'Finalized';
  disclosure: 'open' | 'sealed';
  priceScale: string;
  tick: string;
  minPrice: string;
  ticks: number;
  openTs: string;
  closeTs: string;
  feeBps: number;
  bookVisible: boolean;
  hiddenBecause: string | null;
  totals: { buyQuantity: string; sellQuantity: string; buyOrders: number; sellOrders: number } | null;
  levels: CrossLevel[] | null;
  baseline: { prints: boolean; price: string | null; matched: string } | null;
  impact: CrossImpact[];
  settled: { price: string | null; matched: string } | null;
  pools: { pool: string; kind: PoolKind; status: PoolStatus; rows: ({ side: 'buy' | 'sell'; size: string; pricePerBase: string; slippageBps: string; partial: boolean; quote: string; base: string } | { side: 'buy' | 'sell'; size: string; unavailable: string })[] }[];
  poolNote: string | null;
  notes: string[];
};
