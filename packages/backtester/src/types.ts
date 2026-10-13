// The vocabulary of a replay. A "historical cross" is a settled cross as the chain and the index recorded it: its grid, its
// guards, its fees, the merged book at settlement and what the program printed.
export type Side = 'buy' | 'sell';
export type Order = { readonly side: Side; readonly price: bigint; readonly quantity: bigint };

export type Grid = { readonly min: bigint; readonly tick: bigint; readonly ticks: number; readonly priceScale: bigint };

export type Printed = { readonly printed: true; readonly price: bigint; readonly matched: bigint; readonly rationed: Side | null };
export type NotPrinted = { readonly printed: false; readonly reason: string };
export type Outcome = Printed | NotPrinted;

export type HistoricalCross = {
  readonly address: string;
  readonly baseMint: string;
  readonly quoteMint: string;
  /** Unix seconds when the call closed; crosses are replayed in this order. */
  readonly closeTs: bigint;
  readonly kind: string;
  /** `escrow` crosses take sell orders and charge the fee to the seller; the minting modes take only buys. */
  readonly supplyMode: string;
  readonly disclosure: 'open' | 'sealed';
  readonly grid: Grid;
  readonly referencePrice: bigint | null;
  readonly minMatched: bigint;
  readonly maxImbalanceBps: bigint | null;
  /** Protocol plus integrator fee in basis points; charged on a seller's proceeds. */
  readonly feeBps: number;
  /** The merged book at settlement, one order per side per price level. */
  readonly book: readonly Order[];
  /** What the program recorded; null when the cross is not settled. */
  readonly recorded: Outcome | null;
  /** The cross carries an oracle guard: the book alone cannot reproduce a no-print caused by the oracle. */
  readonly oracleGuard: boolean;
};

export type BaselineCheck = 'match' | 'mismatch' | 'external';

export type Unreplayable = { readonly address: string; readonly reason: string };

export type StrategyContext = {
  readonly cross: HistoricalCross;
  /** The book the strategy faces: everyone else's orders. */
  readonly book: readonly Order[];
  /** The latest printed price of the same pair before this cross (same price scale), or null. */
  readonly reference: bigint | null;
};

export type Strategy = {
  readonly name: string;
  readonly description: string;
  /** The orders to add to this cross, or an empty list to sit it out. A price off the grid is an error reported for the cross. */
  orders(ctx: StrategyContext): readonly Order[];
};

export type OrderResult = { readonly order: Order; readonly filled: bigint; readonly quote: bigint; readonly avgPrice: bigint | null; readonly feePaid: bigint };

export type CrossReplay = {
  readonly cross: string;
  readonly closeTs: bigint;
  /** The cross replayed as it was against what the chain recorded. */
  readonly baselineCheck: BaselineCheck;
  readonly baseline: Outcome;
  readonly participated: boolean;
  readonly withStrategy: Outcome | null;
  readonly orders: readonly OrderResult[];
  /** Change of clearing price caused by the strategy's own orders, in grid ticks (null if either side did not print). */
  readonly impactTicks: number | null;
  readonly note: string | null;
};
