// Shapes returned by the Opening Cross API. Every integer is a decimal string, so nothing loses precision in JSON.

export type CrossStateName = 'Live' | 'Cleared' | 'NoPrint' | 'Finalized';
export type DisclosureName = 'open' | 'sealed';

export type Stats = {
  network: string;
  crosses_printed: number;
  crosses_total: number;
  buyers_filled: number;
  quote_to_sellers: string;
  quote_refunded_to_buyers: string;
  crosses_no_print: number;
};

export type CrossSummary = {
  address: string;
  state: CrossStateName;
  creator: string;
  base_mint: string;
  quote_mint: string;
  open_ts: string;
  close_ts: string;
  reveal_end_ts: string;
  clearing_price: string | null;
  matched: string | null;
  orders_committed: number;
};

export type CrossDetail = {
  address: string;
  state: CrossStateName;
  disclosure: DisclosureName;
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
};

export type BookLevel = { price: string; buy: string; sell: string; buyOrders: number; sellOrders: number };

export type BookResponse = {
  disclosure: DisclosureName;
  levels: BookLevel[];
  indicative: { price: string; matched: string } | null;
  note: string;
};

export type OrderStatus = 'committed' | 'revealed' | 'cancelled' | 'claimed';

/** An order as the indexer recorded it. */
export type OwnerOrder = {
  cross_address: string;
  idx: number;
  address: string;
  side: 'buy' | 'sell';
  escrow: string;
  sealed: boolean;
  price: string | null;
  quantity: string | null;
  status: OrderStatus;
  fill: string | null;
  quote_out: string | null;
  base_out: string | null;
  fee: string | null;
};

/** One row of GET /v1/orders: an open order read from chain, a closed one from the index, or not found. */
export type OrderLookup =
  | { address: string; found: false }
  | { address: string; found: true; open: true; cross: string; owner: string; nonce: string; index: number; side: 'buy' | 'sell'; revealed: boolean; escrow: string }
  | ({ address: string; found: true; open: false } & Omit<OwnerOrder, 'address'>);

/** The fairness proof (`opening-cross/fairness-proof/v1`) as the API returns it. */
export type FairnessProofView = {
  schema: string;
  program: string;
  cross: string;
  state: CrossStateName;
  params: { minPrice: string; tick: string; ticks: number; priceScale: string; referencePrice: string | null; minMatched: string; maxImbalanceBps: number | null; oracleGuard: boolean };
  book: BookLevel[];
  onchain: { printed: boolean; price: string | null; matched: string | null; rationed: string | null; noPrintReason: number | null };
  recomputed: { printed: boolean; price: string | null; matched: string | null; rationed: string | null; noPrintReason: string | null };
  verified: boolean;
  notes: string[];
};

/** An unsigned transaction as the API (or the local builder) returns it: wire bytes in base64, signature slots empty. */
export type UnsignedTransaction = { transaction: string; signers: string[] };

/** The result of building an action: the transactions to sign and send in order, plus builder-specific facts (for example `order`, the new order's address). */
export type BuiltAction = { transactions: UnsignedTransaction[]; extra: Record<string, unknown> };

export type Side = 'buy' | 'sell';
