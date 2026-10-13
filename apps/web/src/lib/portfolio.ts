// A wallet's holdings and results, worked out from the order records the indexer serves and from what the chain says is still open.
// Pure: nothing here fetches. Every figure is an exact bigint taken from an order record or computed from one with the same rounding
// cross_core uses (buyers pay the ceiling, sellers receive the floor), and anything that cannot be known stays null instead of zero.
//
// There is deliberately no market price. A profit-and-loss against one would need a reference this product does not have, so the only
// reference used is what the cross itself did: the price everyone paid, and the limit the order was placed at.
import type { CrossDetail, OwnerOrder } from './types';
import { buyerPays } from './units';

export type CrossFacts = Pick<CrossDetail, 'address' | 'state' | 'decimals' | 'grid' | 'baseMint' | 'quoteMint' | 'clearing' | 'noPrintReason'>;

/** An order as GET /v1/orders reads it: `open` is true while the order account still exists on chain (so it can still be claimed). */
export type ChainOrder = { address: string; open: boolean; nonce: string | null; revealed: boolean };

export type ClaimKind = 'cleared' | 'no-print' | 'unrevealed';

export type OrderResult =
  | {
      kind: 'settled';
      order: OwnerOrder;
      cross: CrossFacts;
      /** Buys: tokens received. Sells: tokens sold. */
      filled: bigint;
      /** Buys: quote paid. Sells: quote received after the fee. */
      quote: bigint;
      /** Buys: quote refunded. Sells: the fee taken. */
      quoteOther: bigint;
      /** Sells: tokens handed back. Buys: 0. */
      tokensBack: bigint;
      /** Quote atoms per whole token actually paid (buys) or received before fee (sells); null when nothing was filled. */
      average: bigint | null;
      /** The order's limit price in quote atoms per whole token, or null when it was never recorded (a sealed order that was not revealed). */
      limit: bigint | null;
      /** Quote atoms better than the limit: buys paid less than the limit would have charged, sells received more than the ask. Null when the limit is unknown. */
      improvement: bigint | null;
    }
  | { kind: 'cancelled'; order: OwnerOrder; cross: CrossFacts }
  | { kind: 'locked'; order: OwnerOrder; cross: CrossFacts; confirmed: boolean }
  | { kind: 'claimable'; order: OwnerOrder; cross: CrossFacts; nonce: string; claim: ClaimKind }
  /** Paid out on chain; the index has not recorded the amounts yet, so none are shown. */
  | { kind: 'settling'; order: OwnerOrder; cross: CrossFacts };

export type Mint = string | null;

export type CrossPosition = {
  cross: CrossFacts;
  results: OrderResult[];
  tokensReceived: bigint;
  tokensSold: bigint;
  quotePaid: bigint;
  quoteRefunded: bigint;
  quoteReceived: bigint;
  fees: bigint;
  /** Escrow of orders not yet settled and not cancelled. */
  lockedQuote: bigint;
  lockedBase: bigint;
  claimable: number;
  /** Total improvement over the limits of the filled orders whose limit is known; `improvedOrders` of `filledOrders` could be measured. */
  improvement: bigint;
  improvedOrders: number;
  filledOrders: number;
  /** Quote per whole token paid across every buy fill in this cross; null when no buy filled. */
  averagePaid: bigint | null;
};

export type MintTotal = {
  mint: string;
  decimals: number;
  tokensReceived: bigint;
  tokensSold: bigint;
  lockedBase: bigint;
  quotePaid: bigint;
  quoteRefunded: bigint;
  quoteReceived: bigint;
  fees: bigint;
  lockedQuote: bigint;
  improvement: bigint;
};

export type Portfolio = {
  positions: CrossPosition[];
  claimable: Extract<OrderResult, { kind: 'claimable' }>[];
  /** Quote side, one row per quote mint (amounts in different mints are never added together). */
  quote: MintTotal[];
  /** Base side, one row per base mint. */
  base: MintTotal[];
  orders: number;
  crosses: number;
  /** Orders with no fill (refunded in full, cancelled, or priced out) versus orders that filled. */
  filledOrders: number;
};

const scale = (c: CrossFacts) => BigInt(c.grid.priceScale);
const pow10 = (d: number) => 10n ** BigInt(d);

/** The result of one order. `chain` is the chain's view of an order the index does not yet show as final (absent when it could not be read or was not asked for). */
export function resultOf(o: OwnerOrder, c: CrossFacts, chain: ChainOrder | undefined): OrderResult {
  if (o.status === 'cancelled') return { kind: 'cancelled', order: o, cross: c };
  if (o.status === 'claimed') return settled(o, c);
  if (chain && !chain.open) return { kind: 'settling', order: o, cross: c };
  if (c.state === 'Live') return { kind: 'locked', order: o, cross: c, confirmed: true };
  if (chain?.open && chain.nonce !== null && (c.state === 'Cleared' || c.state === 'NoPrint')) {
    const claim: ClaimKind = c.state === 'NoPrint' ? 'no-print' : o.sealed && !chain.revealed ? 'unrevealed' : 'cleared';
    return { kind: 'claimable', order: o, cross: c, nonce: chain.nonce, claim };
  }
  // Settled in the index's past but not yet marked, a finalized cross, or the chain could not be read: still counted as locked, and flagged.
  return { kind: 'locked', order: o, cross: c, confirmed: Boolean(chain) };
}

function settled(o: OwnerOrder, c: CrossFacts): OrderResult {
  const bd = c.decimals.base;
  const sc = scale(c);
  const fill = BigInt(o.fill ?? '0');
  const escrow = BigInt(o.escrow);
  const quoteOut = BigInt(o.quote_out ?? '0');
  const baseOut = BigInt(o.base_out ?? '0');
  const fee = BigInt(o.fee ?? '0');
  const price = o.price !== null ? BigInt(o.price) : null;
  const limit = price !== null ? (price * pow10(bd)) / sc : null;
  if (o.side === 'buy') {
    const paid = escrow - quoteOut;
    const average = baseOut > 0n ? (paid * pow10(bd)) / baseOut : null;
    const improvement = price !== null && fill > 0n ? buyerPays(fill, price, sc) - paid : null;
    return { kind: 'settled', order: o, cross: c, filled: baseOut, quote: paid, quoteOther: quoteOut, tokensBack: 0n, average, limit, improvement };
  }
  const gross = quoteOut + fee;
  const average = fill > 0n ? (gross * pow10(bd)) / fill : null;
  const improvement = price !== null && fill > 0n ? gross - (fill * price) / sc : null;
  return { kind: 'settled', order: o, cross: c, filled: fill, quote: quoteOut, quoteOther: fee, tokensBack: baseOut, average, limit, improvement };
}

/** Groups a wallet's orders by cross and totals them. `crosses` and `chain` are keyed by cross address and order address. */
export function buildPortfolio(orders: readonly OwnerOrder[], crosses: ReadonlyMap<string, CrossFacts>, chain: ReadonlyMap<string, ChainOrder>): Portfolio {
  const byCross = new Map<string, CrossPosition>();
  const claimable: Portfolio['claimable'] = [];
  let counted = 0;
  let filledOrders = 0;
  for (const o of orders) {
    const c = crosses.get(o.cross_address);
    if (!c) continue;
    counted += 1;
    const r = resultOf(o, c, chain.get(o.address));
    let p = byCross.get(c.address);
    if (!p) {
      p = { cross: c, results: [], tokensReceived: 0n, tokensSold: 0n, quotePaid: 0n, quoteRefunded: 0n, quoteReceived: 0n, fees: 0n, lockedQuote: 0n, lockedBase: 0n, claimable: 0, improvement: 0n, improvedOrders: 0, filledOrders: 0, averagePaid: null };
      byCross.set(c.address, p);
    }
    p.results.push(r);
    if (r.kind === 'settled') {
      if (r.order.side === 'buy') {
        p.tokensReceived += r.filled;
        p.quotePaid += r.quote;
        p.quoteRefunded += r.quoteOther;
      } else {
        p.tokensSold += r.filled;
        p.quoteReceived += r.quote;
        p.fees += r.quoteOther;
      }
      if (r.filled > 0n) {
        p.filledOrders += 1;
        filledOrders += 1;
        if (r.improvement !== null) {
          p.improvement += r.improvement;
          p.improvedOrders += 1;
        }
      }
    } else if (r.kind === 'locked' || r.kind === 'claimable') {
      if (o.side === 'buy') p.lockedQuote += BigInt(o.escrow);
      else p.lockedBase += BigInt(o.escrow);
      if (r.kind === 'claimable') {
        p.claimable += 1;
        claimable.push(r);
      }
    }
  }
  const positions = [...byCross.values()];
  for (const p of positions) p.averagePaid = p.tokensReceived > 0n ? (p.quotePaid * pow10(p.cross.decimals.base)) / p.tokensReceived : null;

  const quote = new Map<string, MintTotal>();
  const base = new Map<string, MintTotal>();
  const row = (m: Map<string, MintTotal>, mint: string, decimals: number) => {
    let t = m.get(mint);
    if (!t) {
      t = { mint, decimals, tokensReceived: 0n, tokensSold: 0n, lockedBase: 0n, quotePaid: 0n, quoteRefunded: 0n, quoteReceived: 0n, fees: 0n, lockedQuote: 0n, improvement: 0n };
      m.set(mint, t);
    }
    return t;
  };
  for (const p of positions) {
    const q = row(quote, p.cross.quoteMint, p.cross.decimals.quote);
    q.quotePaid += p.quotePaid;
    q.quoteRefunded += p.quoteRefunded;
    q.quoteReceived += p.quoteReceived;
    q.fees += p.fees;
    q.lockedQuote += p.lockedQuote;
    q.improvement += p.improvement;
    if (p.cross.baseMint) {
      const b = row(base, p.cross.baseMint, p.cross.decimals.base);
      b.tokensReceived += p.tokensReceived;
      b.tokensSold += p.tokensSold;
      b.lockedBase += p.lockedBase;
    }
  }
  return { positions, claimable, quote: [...quote.values()], base: [...base.values()], orders: counted, crosses: positions.length, filledOrders };
}

/** A short plain description of what claiming this order does, from what is known before the claim is signed. */
export function claimNote(kind: ClaimKind): string {
  if (kind === 'no-print') return 'The cross did not print, so the full escrow comes back.';
  if (kind === 'unrevealed') return 'This sealed bid was not revealed in time, so it does not trade and the full escrow comes back.';
  return 'Pays out your fill and returns what the clearing price left over. The exact split is shown once it is claimed.';
}

/** `part` as a percentage of `whole` to one decimal, from bigints; null when whole is zero. */
export function percentOf(part: bigint, whole: bigint): string | null {
  if (whole <= 0n) return null;
  const tenths = (part * 1000n) / whole;
  return `${tenths / 10n}.${tenths % 10n}%`;
}
