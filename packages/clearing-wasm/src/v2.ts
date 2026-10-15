/**
 * The clearing rule with the v2 rules in the browser or Node: the same `clearing-core` the program runs on chain, compiled to
 * WebAssembly (`rust/`, ADR-0970). Where `loadClearing` previews the base rule, this one also applies a hard supply cap, the
 * minimum-raise, float, valuation and price-move guards, allocation classes with reserved shares and the class-1 lottery, and the
 * exclusion of declared insiders from the minimum raise. Nothing here re-implements the rule: it lays the book and the rules out in
 * memory, calls the module and reads the answer back.
 *
 *   const rule = await loadClearingV2(await readFile('clearing-v2.wasm'));
 *   const r = rule.preview({ grid, orders, rules: { minRaiseQuote: 5_000n, reserveBps: [0, 3_000, 0] } });
 */
import type { Grid, NoPrintReason, Order, Side } from './index.js';
import { ClearingInputError } from './index.js';

export type AllocationClass = 0 | 1 | 2 | 3;
export interface OrderV2 extends Order {
  /** 0 is everyone; 1 is identity-verified small orders; 2 is locked; 3 is priority. Buys only. */
  class?: AllocationClass;
  /** A declared insider: this buy's allocation is left out of the minimum raise. Buys only. */
  insider?: boolean;
}

export interface RulesV2 {
  /** The most base the sell side will deliver, however much the schedule offers. */
  supplyCap?: bigint | null;
  /** Minimum raise in quote atoms: floor(counted matched volume x price / priceScale) must reach it. 0 is off. */
  minRaiseQuote?: bigint;
  /** The price scale of the cross (quote atoms per price unit). Must be positive; default 1. */
  priceScale?: bigint;
  /** Declared fully diluted supply in base atoms; 0 means unknown, which switches the float and valuation guards off. */
  totalSupply?: bigint;
  minFloatBps?: number;
  /** FDV-to-raise ratio times 100: totalSupply / counted may not exceed maxFdvX100 / 100. 0 is off. */
  maxFdvX100?: bigint;
  /** Anchor for the move guard: the issuer's estimate or the reopen reference. 0 is off. */
  anchorPrice?: bigint;
  moveBps?: number;
  /** Shares of the marginal buy volume reserved for classes 1, 2 and 3, in basis points; the sum may not exceed 10,000. */
  reserveBps?: readonly [number, number, number];
  /** Base atoms per class-1 lottery lot; 0 means class 1 is allocated pro rata within its reserve. */
  lotteryUnit?: bigint;
  /** Where the lottery window starts; the module reduces it modulo the number of tickets, as the program does. */
  rho?: number;
}

export interface PreviewInputV2 {
  grid: Grid;
  orders: readonly OrderV2[];
  reference?: bigint | null;
  minMatched?: bigint;
  maxImbalanceBps?: number | null;
  rules?: RulesV2;
}

export type NoPrintReasonV2 = NoPrintReason | 'BelowMinimumRaise' | 'FloatTooLow' | 'FdvTooHigh' | 'PriceMoved';

export interface CrossSummary {
  price: bigint;
  matched: bigint;
  demand: bigint;
  supply: bigint;
  rationed: Side | null;
  marginalOrders: number;
  marginalQuantity: bigint;
  marginalRemaining: bigint;
}

export type PreviewV2 =
  | { printed: false; reason: 'NoCross'; fills: bigint[] }
  /** A guard stopped the print: `wouldClearAt` and `cleared` say where the cross would have cleared. */
  | { printed: false; reason: Exclude<NoPrintReasonV2, 'NoCross'>; wouldClearAt: bigint; cleared: CrossSummary; insiderUpperBound: bigint; fills: bigint[] }
  | ({ printed: true; insiderUpperBound: bigint; lotteryTickets: number; lotteryRho: number; fills: bigint[] } & CrossSummary);

const ERRORS: Record<number, string> = {
  1: 'the grid is not valid',
  2: 'an order is not on the grid',
  3: 'an order is empty or malformed (a sell cannot carry a class or an insider flag, and a class is 0 to 3)',
  4: 'the reference price is not on the grid',
  5: 'the rules are not valid (the price scale must be positive and the class reserves may not add up to more than 10,000 basis points)',
};
const REASONS: Record<number, NoPrintReasonV2> = { 1: 'NoCross', 2: 'BelowMinimumVolume', 3: 'ImbalanceTooHigh', 4: 'BelowMinimumRaise', 5: 'FloatTooLow', 6: 'FdvTooHigh', 7: 'PriceMoved' };
const ORDER_SIZE = 32;
const RULES_SIZE = 96;
const OUT_HEADER = 192;
const U64 = (1n << 64n) - 1n;

interface Exports {
  memory: WebAssembly.Memory;
  alloc(len: number): number;
  dealloc(ptr: number, len: number): void;
  preview_v2(min: bigint, tick: bigint, ticks: number, hasRef: number, ref: bigint, minMatched: bigint, maxImbalance: number, rules: number, orders: number, n: number, out: number): number;
  buyer_pays(filled: bigint, price: bigint, scale: bigint): bigint;
  seller_receives(filled: bigint, price: bigint, scale: bigint): bigint;
}

export interface ClearingV2 {
  preview(input: PreviewInputV2): PreviewV2;
  /** Quote atoms a buyer pays for `filled` base atoms, rounded up. */
  buyerPays(filled: bigint, price: bigint, priceScale: bigint): bigint;
  /** Quote atoms a seller receives for `filled` base atoms, rounded down. */
  sellerReceives(filled: bigint, price: bigint, priceScale: bigint): bigint;
}

function u64(v: bigint, what: string): bigint {
  if (v < 0n || v > U64) throw new ClearingInputError(`${what} does not fit in 64 bits`);
  return v;
}
function u32(v: number, what: string, max = 0xffffffff): number {
  if (!Number.isInteger(v) || v < 0 || v > max) throw new ClearingInputError(`${what} must be a whole number from 0 to ${max}`);
  return v;
}

export async function loadClearingV2(wasm: BufferSource): Promise<ClearingV2> {
  const { instance } = await WebAssembly.instantiate(wasm, {});
  const x = instance.exports as unknown as Exports;
  const amount = (r: bigint): bigint => {
    if (BigInt.asUintN(64, r) === U64) throw new ClearingInputError('the amount does not fit in 64 bits');
    return BigInt.asUintN(64, r);
  };
  return {
    preview({ grid, orders, reference = null, minMatched = 0n, maxImbalanceBps = null, rules = {} }) {
      if (!Number.isInteger(grid.ticks) || grid.ticks < 0 || grid.ticks > 0xffff) throw new ClearingInputError(ERRORS[1]!);
      const reserve = rules.reserveBps ?? [0, 0, 0];
      const n = orders.length;
      const inBytes = Math.max(n * ORDER_SIZE, 1);
      const outBytes = OUT_HEADER + 8 * n;
      const rulesPtr = x.alloc(RULES_SIZE);
      const inPtr = x.alloc(inBytes);
      const outPtr = x.alloc(outBytes);
      try {
        // Validate and encode before anything is called, so a refused input leaves nothing half-written.
        const r = new DataView(x.memory.buffer);
        const cap = rules.supplyCap ?? null;
        r.setUint32(rulesPtr, cap === null ? 0 : 1, true);
        r.setBigUint64(rulesPtr + 8, cap === null ? 0n : u64(cap, 'the supply cap'), true);
        r.setBigUint64(rulesPtr + 16, u64(rules.minRaiseQuote ?? 0n, 'the minimum raise'), true);
        r.setBigUint64(rulesPtr + 24, u64(rules.priceScale ?? 1n, 'the price scale'), true);
        r.setBigUint64(rulesPtr + 32, u64(rules.totalSupply ?? 0n, 'the total supply'), true);
        r.setUint32(rulesPtr + 40, u32(rules.minFloatBps ?? 0, 'the minimum float'), true);
        r.setBigUint64(rulesPtr + 48, u64(rules.maxFdvX100 ?? 0n, 'the maximum valuation ratio'), true);
        r.setBigUint64(rulesPtr + 56, u64(rules.anchorPrice ?? 0n, 'the anchor price'), true);
        r.setUint32(rulesPtr + 64, u32(rules.moveBps ?? 0, 'the move bound'), true);
        reserve.forEach((b, i) => r.setUint16(rulesPtr + 68 + 2 * i, u32(b, 'a class reserve', 0xffff), true));
        r.setBigUint64(rulesPtr + 80, u64(rules.lotteryUnit ?? 0n, 'the lottery unit'), true);
        r.setUint32(rulesPtr + 88, u32(rules.rho ?? 0, 'the lottery start'), true);
        const view = new DataView(x.memory.buffer);
        orders.forEach((o, i) => {
          const at = inPtr + i * ORDER_SIZE;
          view.setUint8(at, o.side === 'buy' ? 0 : 1);
          view.setUint8(at + 1, o.class ?? 0);
          view.setUint8(at + 2, o.insider ? 1 : 0);
          view.setBigUint64(at + 8, u64(o.price, 'a price'), true);
          view.setBigUint64(at + 16, u64(o.quantity, 'a quantity'), true);
        });
        const code = x.preview_v2(u64(grid.min, 'the grid minimum'), u64(grid.tick, 'the tick'), grid.ticks, reference === null ? 0 : 1, reference === null ? 0n : u64(reference, 'the reference'), u64(minMatched, 'the minimum matched'), maxImbalanceBps ?? 0xffffffff, rulesPtr, inPtr, n, outPtr);
        if (code !== 0) throw new ClearingInputError(ERRORS[code] ?? `error ${code}`);
        const out = new DataView(x.memory.buffer);
        const u128 = (at: number) => out.getBigUint64(outPtr + at, true) | (out.getBigUint64(outPtr + at + 8, true) << 64n);
        const fills = Array.from({ length: n }, (_, i) => out.getBigUint64(outPtr + OUT_HEADER + i * 8, true));
        const reason = REASONS[out.getUint32(outPtr + 4, true)];
        if (out.getUint32(outPtr, true) === 0 && (reason === undefined || reason === 'NoCross')) return { printed: false, reason: 'NoCross', fills };
        const rationed = out.getUint32(outPtr + 64, true);
        const summary: CrossSummary = {
          price: out.getBigUint64(outPtr + 8, true),
          matched: u128(16),
          demand: u128(32),
          supply: u128(48),
          rationed: rationed === 1 ? 'buy' : rationed === 2 ? 'sell' : null,
          marginalOrders: out.getUint32(outPtr + 68, true),
          marginalQuantity: u128(72),
          marginalRemaining: u128(88),
        };
        const insiderUpperBound = u128(104);
        if (out.getUint32(outPtr, true) === 0) return { printed: false, reason: reason as Exclude<NoPrintReasonV2, 'NoCross'>, wouldClearAt: summary.price, cleared: summary, insiderUpperBound, fills };
        return { printed: true, ...summary, insiderUpperBound, lotteryTickets: out.getUint32(outPtr + 120, true), lotteryRho: out.getUint32(outPtr + 124, true), fills };
      } finally {
        x.dealloc(rulesPtr, RULES_SIZE);
        x.dealloc(inPtr, inBytes);
        x.dealloc(outPtr, outBytes);
      }
    },
    buyerPays: (f, p, s) => amount(x.buyer_pays(u64(f, 'filled'), u64(p, 'price'), u64(s, 'the price scale'))),
    sellerReceives: (f, p, s) => amount(x.seller_receives(u64(f, 'filled'), u64(p, 'price'), u64(s, 'the price scale'))),
  };
}
