// Liquidity curves and how they become orders (PRODUCT_FEATURES Z7: outside solvers and market makers supply sealed
// liquidity curves to a cross).
//
// cross_core has one way to supply liquidity: a limit order from escrow. A "curve" is therefore a convenient way to
// describe a set of limit orders, and everything here is a deterministic translation to the orders that really go on
// chain. Nothing is promised that the program does not enforce.
//
//  - A buy step is "up to `quantity` base at no more than `price`". It becomes a buy limit order, snapped DOWN to the
//    grid so the maker never pays more than it said. A sell step becomes a sell limit order snapped UP.
//  - The escrow is exact: a buy escrows ceil(quantity * price / scale) quote atoms, a sell escrows `quantity` base atoms.
//  - On a sealed cross each order's salt is derived from one master secret, so the maker keeps a single secret and can
//    always re-derive every salt to reveal. The curve itself can be committed to before the close (`commitCurve`) and
//    checked against the revealed orders afterwards (`checkRevealedOrders`).
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, concatBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { type Address, address as toAddress } from '@solana/kit';
import { OrderSide, costCeil, orderCommitment } from '@opening-cross/sdk';
import { canonicalize } from '@opening-cross/promises';

export type Grid = { readonly minPrice: bigint; readonly tick: bigint; readonly ticks: number; readonly priceScale: bigint };
export type Step = { readonly price: bigint; readonly quantity: bigint };
export type Curve = { readonly buy: readonly Step[]; readonly sell: readonly Step[] };

export class CurveError extends Error {
  override readonly name = 'CurveError';
}

const U64_MAX = (1n << 64n) - 1n;

export type Dropped = { readonly side: 'buy' | 'sell'; readonly step: Step; readonly reason: string };
export type Ladder = { readonly buy: Step[]; readonly sell: Step[]; readonly dropped: Dropped[]; readonly adjusted: string[] };

export const maxPrice = (g: Grid): bigint => g.minPrice + BigInt(g.ticks - 1) * g.tick;

function checkGrid(g: Grid): void {
  if (g.tick <= 0n || g.ticks < 1 || g.ticks > 256 || g.priceScale <= 0n || g.minPrice <= 0n) throw new CurveError('the grid is not valid (tick, ticks, price scale and minimum price must be positive; at most 256 ticks)');
}

function checkStep(s: Step, side: string): void {
  if (s.price <= 0n || s.quantity <= 0n) throw new CurveError(`a ${side} step needs a positive price and quantity`);
  if (s.price > U64_MAX || s.quantity > U64_MAX) throw new CurveError(`a ${side} step is larger than a 64-bit amount`);
}

/**
 * Snaps a curve to the grid. A buy that cannot be placed at or below its price (it is below the lowest tick) is dropped; a
 * buy above the highest tick is placed at the highest tick, which is not more than it offered. A sell mirrors this. Steps
 * that land on the same tick are merged. Every change is listed, nothing is silently moved.
 */
export function ladder(curve: Curve, grid: Grid): Ladder {
  checkGrid(grid);
  const top = maxPrice(grid);
  const dropped: Dropped[] = [];
  const adjusted: string[] = [];
  const merged = {
    buy: new Map<bigint, bigint>(),
    sell: new Map<bigint, bigint>(),
  };
  for (const side of ['buy', 'sell'] as const) {
    for (const s of curve[side]) {
      checkStep(s, side);
      let p: bigint;
      if (side === 'buy') {
        if (s.price < grid.minPrice) {
          dropped.push({ side, step: s, reason: `the bid ${s.price} is below the lowest tick ${grid.minPrice}` });
          continue;
        }
        p = s.price > top ? top : grid.minPrice + ((s.price - grid.minPrice) / grid.tick) * grid.tick;
      } else {
        if (s.price > top) {
          dropped.push({ side, step: s, reason: `the ask ${s.price} is above the highest tick ${top}` });
          continue;
        }
        const raw = s.price < grid.minPrice ? grid.minPrice : s.price;
        p = grid.minPrice + ((raw - grid.minPrice + grid.tick - 1n) / grid.tick) * grid.tick;
      }
      if (p !== s.price) adjusted.push(`${side} ${s.price} placed at ${p}`);
      merged[side].set(p, (merged[side].get(p) ?? 0n) + s.quantity);
    }
  }
  const out = (m: Map<bigint, bigint>, desc: boolean): Step[] =>
    [...m.entries()].map(([price, quantity]) => ({ price, quantity })).sort((a, b) => (a.price === b.price ? 0 : (a.price < b.price) !== desc ? -1 : 1));
  const buy = out(merged.buy, true);
  const sell = out(merged.sell, false);
  for (const s of [...buy, ...sell]) if (s.quantity > U64_MAX) throw new CurveError('merging steps made a quantity larger than a 64-bit amount');
  return { buy, sell, dropped, adjusted };
}

/** What the maker must hold: quote atoms for the buys, base atoms for the sells. Exactly what the program will escrow. */
export function requiredEscrow(l: Pick<Ladder, 'buy' | 'sell'>, priceScale: bigint): { quote: bigint; base: bigint } {
  return {
    quote: l.buy.reduce((a, s) => a + costCeil(s.quantity, s.price, priceScale), 0n),
    base: l.sell.reduce((a, s) => a + s.quantity, 0n),
  };
}

/**
 * A maker whose own bid and ask could cross each other would trade with itself and pay the seller's fee for nothing.
 * Returns the highest bid and lowest ask when they overlap, otherwise null.
 */
export function selfCross(l: Pick<Ladder, 'buy' | 'sell'>): { bid: bigint; ask: bigint } | null {
  const bid = l.buy[0]?.price;
  const ask = l.sell[0]?.price;
  return bid !== undefined && ask !== undefined && bid >= ask ? { bid, ask } : null;
}

export type PlannedOrder = {
  readonly nonce: bigint;
  readonly side: 'buy' | 'sell';
  readonly price: bigint;
  readonly quantity: bigint;
  /** Present on a sealed cross: 32 bytes, derived from the master secret. */
  readonly salt?: Uint8Array;
  /** Present on a sealed cross: what the program stores until the reveal. */
  readonly commitment?: Uint8Array;
};

/** Per-order salt: sha256("opening-cross/curve-salt/v1" || master || cross || owner || nonce). The master secret never leaves the maker. */
export function deriveSalt(master: Uint8Array, cross: string, owner: string, nonce: bigint): Uint8Array {
  if (master.length < 32) throw new CurveError('the master secret must be at least 32 bytes');
  return sha256(concatBytes(utf8ToBytes('opening-cross/curve-salt/v1\n'), master, utf8ToBytes(`${cross}\n${owner}\n${nonce}`)));
}

export type PlanInput = {
  readonly cross: string;
  readonly owner: string;
  readonly ladder: Pick<Ladder, 'buy' | 'sell'>;
  /** First nonce to use; each order takes the next one. */
  readonly firstNonce: bigint;
  /** Set on a sealed cross. */
  readonly master?: Uint8Array;
};

/** The orders, buys then sells, each with the next nonce. Placing and revealing them is the caller's signature. */
export function planOrders(i: PlanInput): PlannedOrder[] {
  const out: PlannedOrder[] = [];
  let nonce = i.firstNonce;
  for (const side of ['buy', 'sell'] as const) {
    for (const s of i.ladder[side]) {
      if (nonce > U64_MAX) throw new CurveError('the nonce range is exhausted');
      if (i.master) {
        const salt = deriveSalt(i.master, i.cross, i.owner, nonce);
        const commitment = orderCommitment(toAddress(i.cross) as Address, toAddress(i.owner) as Address, nonce, side === 'buy' ? OrderSide.Buy : OrderSide.Sell, s.price, s.quantity, salt);
        out.push({ nonce, side, price: s.price, quantity: s.quantity, salt, commitment });
      } else {
        out.push({ nonce, side, price: s.price, quantity: s.quantity });
      }
      nonce += 1n;
    }
  }
  return out;
}

/**
 * A commitment to the whole curve, publishable before the close without showing it: sha256 over the canonical ladder, the
 * cross, the maker and a secret nonce. After the reveal anyone can recompute it from the revealed orders.
 */
export function commitCurve(cross: string, maker: string, l: Pick<Ladder, 'buy' | 'sell'>, secret: Uint8Array): string {
  if (secret.length < 16) throw new CurveError('the commitment secret must be at least 16 bytes');
  const view = (s: readonly Step[]) => s.map((x) => ({ price: x.price.toString(), quantity: x.quantity.toString() }));
  const body = canonicalize({ schema: 'opening-cross/curve-commitment/v1', cross, maker, buy: view(l.buy), sell: view(l.sell) });
  return bytesToHex(sha256(concatBytes(utf8ToBytes(body + '\n'), secret)));
}

export type RevealedOrder = { readonly side: 'buy' | 'sell'; readonly price: bigint; readonly quantity: bigint };

/** Rebuilds the ladder from orders that were revealed on chain and checks it against the commitment published earlier. */
export function checkRevealedOrders(commitment: string, cross: string, maker: string, orders: readonly RevealedOrder[], secret: Uint8Array): boolean {
  const sum = (side: 'buy' | 'sell') => {
    const m = new Map<bigint, bigint>();
    for (const o of orders) if (o.side === side) m.set(o.price, (m.get(o.price) ?? 0n) + o.quantity);
    return [...m.entries()].map(([price, quantity]) => ({ price, quantity })).sort((a, b) => (a.price === b.price ? 0 : (a.price < b.price) !== (side === 'buy') ? -1 : 1));
  };
  return commitCurve(cross, maker, { buy: sum('buy'), sell: sum('sell') }, secret) === commitment;
}
