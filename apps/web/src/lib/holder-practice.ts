// The practice cross (S11; ADR-0410): a 60-second call with play money and simulated bidders, cleared by the same rule as a real one
// (components/cross/clearing.ts, tested against the verifier's reference). Everything here is simulated and labelled so; no wallet, no
// chain, no network. The bidders are drawn from a seeded generator, so a run can be replayed and tested exactly.
import { type Cleared, type Extra, type Level, clearBook, fillAt } from '../components/cross/clearing';
import { buyerPays } from './units';

export const GRID = { minPrice: '1000000', tick: '50000', ticks: 20, priceScale: '1000000' };
export const DECIMALS = { base: 6, quote: 6 };
export const DURATION = 60;
/** Play money the learner starts with, in quote atoms (1,000.00). */
export const PLAY_BALANCE = 1_000_000_000n;
const ONE = 1_000_000n;

export type Sim = { side: 'buy' | 'sell'; price: bigint; quantity: bigint; at: number };

/** mulberry32: a small, well-known seeded generator. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The simulated orders of one run: an issuer's supply from the start, and bidders who arrive across the call. */
export function scenario(seed: number): Sim[] {
  const r = rng(seed);
  const tick = BigInt(GRID.tick);
  const min = BigInt(GRID.minPrice);
  const at = (i: number) => min + BigInt(i) * tick;
  const out: Sim[] = [
    { side: 'sell', price: at(0), quantity: 400n * ONE, at: 0 },
    { side: 'sell', price: at(4), quantity: 300n * ONE, at: 0 },
    { side: 'sell', price: at(9), quantity: 300n * ONE, at: 8 },
  ];
  for (let i = 0; i < 9; i++) {
    const level = 2 + Math.floor(r() * 14);
    out.push({ side: 'buy', price: at(level), quantity: BigInt(40 + Math.floor(r() * 26) * 10) * ONE, at: 3 + Math.floor(r() * (DURATION - 8)) });
  }
  return out.sort((a, b) => a.at - b.at);
}

/** Per-price totals of the orders that have arrived by `t` seconds, plus the learner's order if there is one. */
export function levelsAt(orders: readonly Sim[], t: number, mine: Extra | null): Level[] {
  const by = new Map<string, { buy: bigint; sell: bigint; buyOrders: number; sellOrders: number }>();
  const add = (side: 'buy' | 'sell', price: bigint, q: bigint) => {
    const k = price.toString();
    const l = by.get(k) ?? { buy: 0n, sell: 0n, buyOrders: 0, sellOrders: 0 };
    if (side === 'buy') {
      l.buy += q;
      l.buyOrders += 1;
    } else {
      l.sell += q;
      l.sellOrders += 1;
    }
    by.set(k, l);
  };
  for (const o of orders) if (o.at <= t) add(o.side, o.price, o.quantity);
  if (mine) add(mine.side, mine.price, mine.quantity);
  return [...by.entries()]
    .sort((a, b) => (BigInt(a[0]) < BigInt(b[0]) ? -1 : 1))
    .map(([price, l]) => ({ price, buy: l.buy.toString(), sell: l.sell.toString(), buyOrders: l.buyOrders, sellOrders: l.sellOrders }));
}

export type Outcome = {
  cleared: Cleared | null;
  /** The learner's fill, price paid and escrow returned, in quote atoms and base atoms; zeros when it did not trade or there is no order. */
  fill: bigint;
  paid: bigint;
  escrow: bigint;
  refund: bigint;
  /** What the learner would have been filled for with a limit higher by `bumpTicks`, and what it would have paid: the same price. */
  higher: { limit: bigint; fill: bigint; paid: bigint } | null;
};

/** Clears the call as it ended, with the learner's buy order (if any), and answers the questions the debrief asks. */
export function outcome(orders: readonly Sim[], mine: Extra | null): Outcome {
  // `fillAt` and `clearBook` add the extra order themselves, so the book they are given is the simulated one without it.
  const book = levelsAt(orders, DURATION, null);
  if (!mine || mine.side !== 'buy') return { cleared: clearBook(book, GRID), fill: 0n, paid: 0n, escrow: 0n, refund: 0n, higher: null };
  const scale = BigInt(GRID.priceScale);
  const run = (order: Extra) => {
    const cleared = clearBook(book, GRID, order);
    const fill = cleared ? fillAt(book, GRID, cleared, order) : 0n;
    return { cleared, fill, paid: cleared ? buyerPays(fill, cleared.price, scale) : 0n };
  };
  const mineRun = run(mine);
  const escrow = buyerPays(mine.quantity, mine.price, scale);
  const top = BigInt(GRID.minPrice) + BigInt(GRID.ticks - 1) * BigInt(GRID.tick);
  const limit = mine.price + 3n * BigInt(GRID.tick) > top ? top : mine.price + 3n * BigInt(GRID.tick);
  let higher: Outcome['higher'] = null;
  if (limit > mine.price) {
    const h = run({ ...mine, price: limit });
    higher = { limit, fill: h.fill, paid: h.paid };
  }
  return { cleared: mineRun.cleared, fill: mineRun.fill, paid: mineRun.paid, escrow, refund: escrow - mineRun.paid, higher };
}
