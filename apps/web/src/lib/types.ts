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
