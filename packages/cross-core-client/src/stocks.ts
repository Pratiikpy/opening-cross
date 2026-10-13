// Helpers for stock reopens (ADR-0462): the sessions of a weekly reopen calendar, pegged-to-open orders, and a
// composite reference price for thin assets. Pure functions; the chain enforces the rules these inputs feed
// (a calendar's sessions, a cross's grid, its reference and anchor prices).
import { OrderSide } from './generated/types/orderSide.js';

// ------------------------------------------------------------------ the US equity calendar

/** One session of a `cross_calendar`: Unix seconds, `startTs < endTs`. */
export type SessionInput = { startTs: bigint; endTs: bigint };

const NY = 'America/New_York';

/** Easter Sunday (Gregorian), the anonymous algorithm; Good Friday is two days before. */
function easter(year: number): { month: number; day: number } {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return { month, day };
}

/** The `n`-th weekday (0 = Sunday) of a month, or the last one for `n = -1`. */
function nthWeekday(year: number, month: number, weekday: number, n: number): number {
  if (n > 0) {
    const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
    return 1 + ((weekday - first + 7) % 7) + 7 * (n - 1);
  }
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const last = new Date(Date.UTC(year, month - 1, lastDay)).getUTCDay();
  return lastDay - ((last - weekday + 7) % 7);
}

/** The days a US equity exchange is closed for a holiday, by the usual rules (a Saturday holiday is observed the Friday
 *  before, a Sunday holiday the Monday after; New Year's Day on a Saturday is not observed). `YYYY-MM-DD`.
 *  NOT VERIFIED against the exchange's published calendar: pass `holidays` to `weeklyReopenSessions` to override. */
export function usEquityHolidays(year: number): string[] {
  const fmt = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const observed = (m: number, d: number): string | null => {
    const dow = new Date(Date.UTC(year, m - 1, d)).getUTCDay();
    if (dow === 6) return m === 1 && d === 1 ? null : fmt(...shift(year, m, d, -1));
    if (dow === 0) return fmt(...shift(year, m, d, 1));
    return fmt(year, m, d);
  };
  const out: (string | null)[] = [
    observed(1, 1),
    fmt(year, 1, nthWeekday(year, 1, 1, 3)), // Martin Luther King Jr. Day
    fmt(year, 2, nthWeekday(year, 2, 1, 3)), // Washington's Birthday
    (() => {
      const e = easter(year);
      return fmt(...shift(year, e.month, e.day, -2)); // Good Friday
    })(),
    fmt(year, 5, nthWeekday(year, 5, 1, -1)), // Memorial Day
    year >= 2022 ? observed(6, 19) : null, // Juneteenth
    observed(7, 4),
    fmt(year, 9, nthWeekday(year, 9, 1, 1)), // Labor Day
    fmt(year, 11, nthWeekday(year, 11, 4, 4)), // Thanksgiving
    observed(12, 25),
  ];
  return out.filter((d): d is string => d !== null);
}

function shift(year: number, month: number, day: number, days: number): [number, number, number] {
  const d = new Date(Date.UTC(year, month - 1, day + days));
  return [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()];
}

/** Unix seconds of a wall-clock time in New York (handles the daylight-saving change). */
export function newYorkToUnix(year: number, month: number, day: number, hour: number, minute: number): bigint {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const offsetAt = (ms: number) => {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: NY, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(ms));
    const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
    const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
    return asUtc - Math.floor(ms / 1000) * 1000;
  };
  // Two passes: the offset at the guess, then at the corrected instant.
  let ms = guess - offsetAt(guess);
  ms = guess - offsetAt(ms);
  return BigInt(Math.floor(ms / 1000));
}

/** Regular sessions (09:30 to 16:00 New York) of the trading days in `[fromUnix, fromUnix + weeks)`. With `mode: 'weekly'`
 *  only the first session of each trading week is returned: the open a weekly reopen cross closes at. A calendar holds
 *  64 sessions at most, and sessions must not overlap, which these never do. */
export function weeklyReopenSessions(opts: { fromUnix: bigint; weeks: number; mode?: 'weekly' | 'daily'; holidays?: readonly string[]; open?: [number, number]; close?: [number, number] }): SessionInput[] {
  const { fromUnix, weeks, mode = 'weekly' } = opts;
  const [oh, om] = opts.open ?? [9, 30];
  const [ch, cm] = opts.close ?? [16, 0];
  if (weeks < 1 || weeks > 64) throw new Error('weeks must be between 1 and 64');
  const out: SessionInput[] = [];
  const start = new Date(Number(fromUnix) * 1000);
  // Walk New York calendar days from the day `fromUnix` falls on.
  const dayKey = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: NY, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  let cursor = new Date(Date.UTC(Number(dayKey(start).slice(0, 4)), Number(dayKey(start).slice(5, 7)) - 1, Number(dayKey(start).slice(8, 10))));
  const holidayCache = new Map<number, Set<string>>();
  const holidays = (y: number) => {
    let s = holidayCache.get(y);
    if (!s) {
      s = new Set(opts.holidays ?? usEquityHolidays(y));
      holidayCache.set(y, s);
    }
    return s;
  };
  let weeksTaken = 0;
  let currentWeek = '';
  for (let i = 0; i < weeks * 7 + 14; i++, cursor = new Date(cursor.getTime() + 86_400_000)) {
    const y = cursor.getUTCFullYear();
    const m = cursor.getUTCMonth() + 1;
    const d = cursor.getUTCDate();
    const dow = cursor.getUTCDay();
    if (dow === 0 || dow === 6) continue;
    const key = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    if (opts.holidays ? opts.holidays.includes(key) : holidays(y).has(key)) continue;
    const s = newYorkToUnix(y, m, d, oh, om);
    const e = newYorkToUnix(y, m, d, ch, cm);
    if (e <= fromUnix) continue;
    const monday = new Date(cursor.getTime() - ((dow + 6) % 7) * 86_400_000).toISOString().slice(0, 10);
    const first = monday !== currentWeek;
    if (first) {
      if (weeksTaken === weeks) break;
      weeksTaken++;
      currentWeek = monday;
    }
    if (mode === 'weekly' && !first) continue;
    out.push({ startTs: s, endTs: e });
  }
  if (out.length > 64) throw new Error('a calendar holds 64 sessions at most');
  return out;
}

// ------------------------------------------------------------------ pegged-to-open orders (Z3)

export type PeggedGrid = { minPrice: bigint; tick: bigint; ticks: number; priceScale: bigint };

/** An order that takes whatever the open prints (PRODUCT_FEATURES Z3, "buy or sell at Monday open"). There is no special
 *  order type: in a uniform-price call a buy at the top of the grid fills at the clearing price whatever it is, a sell at
 *  the bottom likewise, and a buyer pays only the clearing price, so the excess escrow comes back at the claim.
 *  `slippageBps` limits the exposure instead: the buy limit is the reference price plus that much (rounded up to the grid),
 *  the sell limit the reference minus it (rounded down), and the order simply does not fill outside it. */
export function peggedOrder(grid: PeggedGrid, side: OrderSide, quantity: bigint, opts: { reference?: bigint; slippageBps?: number } = {}): { price: bigint; quantity: bigint; escrow: bigint } {
  const top = grid.minPrice + BigInt(grid.ticks - 1) * grid.tick;
  let price: bigint;
  if (opts.slippageBps === undefined || opts.reference === undefined) {
    price = side === OrderSide.Buy ? top : grid.minPrice;
  } else {
    const bps = BigInt(opts.slippageBps);
    if (side === OrderSide.Buy) {
      const raw = (opts.reference * (10_000n + bps) + 9_999n) / 10_000n;
      const i = (raw - grid.minPrice + grid.tick - 1n) / grid.tick;
      price = grid.minPrice + (i < 0n ? 0n : i) * grid.tick;
      if (price > top) price = top;
    } else {
      const raw = (opts.reference * (10_000n - bps)) / 10_000n;
      const i = (raw - grid.minPrice) / grid.tick;
      price = grid.minPrice + (i < 0n ? 0n : i) * grid.tick;
    }
  }
  const escrow = side === OrderSide.Buy ? (quantity * price + grid.priceScale - 1n) / grid.priceScale : quantity;
  return { price, quantity, escrow };
}

// ------------------------------------------------------------------ composite reference price (C6)

export type ReferenceInputs = {
  /** Last trade and when it happened (Unix seconds). */
  lastTrade?: { price: bigint; ts: bigint };
  bid?: bigint;
  ask?: bigint;
  /** The last valuation of the asset (a funding round, an NAV) and when it was struck. */
  valuation?: { price: bigint; ts: bigint };
};

export type ReferenceRules = {
  now: bigint;
  /** A trade or valuation older than this does not count. */
  maxAgeSecs: bigint;
  /** A quote whose spread is wider than this fraction of its mid does not count (basis points). */
  maxSpreadBps: number;
  /** Weights of the quote mid, the last trade and the valuation, in basis points. */
  weights: { quote: number; trade: number; valuation: number };
};

/** A reference price for an asset that trades too thinly for one source to be trusted: the weighted mean of the sources
 *  that pass their own freshness or tightness test, with the weights renormalised over those that do. `null` when
 *  nothing qualifies, and the cross then needs an explicit reference or none. The result always lies between the lowest
 *  and the highest qualifying source. It feeds a cross's `reference_price` or its anchor price; the chain checks the
 *  clearing price against the anchor and never trusts this number on its own. */
export function compositeReference(inputs: ReferenceInputs, rules: ReferenceRules): { price: bigint; sources: string[] } | null {
  const parts: { name: string; price: bigint; weight: bigint }[] = [];
  const { bid, ask } = inputs;
  if (bid !== undefined && ask !== undefined && bid > 0n && ask >= bid) {
    const mid = (bid + ask) / 2n;
    if ((ask - bid) * 10_000n <= BigInt(rules.maxSpreadBps) * mid) parts.push({ name: 'quote', price: mid, weight: BigInt(rules.weights.quote) });
  }
  const fresh = (ts: bigint) => rules.now >= ts && rules.now - ts <= rules.maxAgeSecs;
  if (inputs.lastTrade && inputs.lastTrade.price > 0n && fresh(inputs.lastTrade.ts)) parts.push({ name: 'trade', price: inputs.lastTrade.price, weight: BigInt(rules.weights.trade) });
  if (inputs.valuation && inputs.valuation.price > 0n && fresh(inputs.valuation.ts)) parts.push({ name: 'valuation', price: inputs.valuation.price, weight: BigInt(rules.weights.valuation) });
  const live = parts.filter((p) => p.weight > 0n);
  if (live.length === 0) return null;
  const total = live.reduce((a, p) => a + p.weight, 0n);
  const price = live.reduce((a, p) => a + p.price * p.weight, 0n) / total;
  return { price, sources: live.map((p) => p.name) };
}
