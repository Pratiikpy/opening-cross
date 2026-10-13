/**
 * The Opening Cross clearing rule in the browser or Node: the same `clearing-core` the program runs on chain, compiled to
 * WebAssembly (crates/clearing-wasm). Nothing here re-implements the rule; this file lays orders out in memory, calls the
 * module and reads the answer back. Use it to preview where a book would clear before an order is placed.
 *
 *   const rule = await loadClearing(await readFile('clearing.wasm'));   // or fetch(...).then(r => r.arrayBuffer())
 *   const result = rule.preview({ grid: { min: 100n, tick: 10n, ticks: 20 }, orders });
 */

export type Side = 'buy' | 'sell';
export interface Order {
  side: Side;
  price: bigint;
  quantity: bigint;
}
export interface Grid {
  min: bigint;
  tick: bigint;
  ticks: number;
}
export interface PreviewInput {
  grid: Grid;
  orders: readonly Order[];
  reference?: bigint | null;
  minMatched?: bigint;
  maxImbalanceBps?: number | null;
}
export type NoPrintReason = 'NoCross' | 'BelowMinimumVolume' | 'ImbalanceTooHigh';
export type Preview =
  | { printed: false; reason: NoPrintReason; fills: bigint[] }
  | { printed: true; price: bigint; matched: bigint; demand: bigint; supply: bigint; rationed: Side | null; marginalOrders: number; marginalQuantity: bigint; marginalRemaining: bigint; fills: bigint[] };

export class ClearingInputError extends Error {}

const ERRORS: Record<number, string> = {
  1: 'the grid is not valid',
  2: 'an order is not on the grid',
  3: 'an order is empty or malformed',
  4: 'the reference price is not on the grid',
};
const REASONS: Record<number, NoPrintReason> = { 1: 'NoCross', 2: 'BelowMinimumVolume', 3: 'ImbalanceTooHigh' };
const ORDER_SIZE = 24;
const OUT_HEADER = 128;
const U64 = (1n << 64n) - 1n;

interface Exports {
  memory: WebAssembly.Memory;
  alloc(len: number): number;
  dealloc(ptr: number, len: number): void;
  preview(min: bigint, tick: bigint, ticks: number, hasRef: number, ref: bigint, minMatched: bigint, maxImbalance: number, orders: number, n: number, out: number): number;
  buyer_pays(filled: bigint, price: bigint, scale: bigint): bigint;
  seller_receives(filled: bigint, price: bigint, scale: bigint): bigint;
}

export interface Clearing {
  preview(input: PreviewInput): Preview;
  /** Quote atoms a buyer pays for `filled` base atoms, rounded up. */
  buyerPays(filled: bigint, price: bigint, priceScale: bigint): bigint;
  /** Quote atoms a seller receives for `filled` base atoms, rounded down. */
  sellerReceives(filled: bigint, price: bigint, priceScale: bigint): bigint;
}

function u64(v: bigint, what: string): bigint {
  if (v < 0n || v > U64) throw new ClearingInputError(`${what} does not fit in 64 bits`);
  return v;
}

export async function loadClearing(wasm: BufferSource): Promise<Clearing> {
  const { instance } = await WebAssembly.instantiate(wasm, {});
  const x = instance.exports as unknown as Exports;
  const amount = (r: bigint): bigint => {
    if (BigInt.asUintN(64, r) === U64) throw new ClearingInputError('the amount does not fit in 64 bits');
    return BigInt.asUintN(64, r);
  };
  return {
    preview({ grid, orders, reference = null, minMatched = 0n, maxImbalanceBps = null }) {
      if (!Number.isInteger(grid.ticks) || grid.ticks < 0 || grid.ticks > 0xffff) throw new ClearingInputError(ERRORS[1]!);
      const n = orders.length;
      const inBytes = Math.max(n * ORDER_SIZE, 1);
      const outBytes = OUT_HEADER + 8 * n;
      const inPtr = x.alloc(inBytes);
      const outPtr = x.alloc(outBytes);
      try {
        const view = new DataView(x.memory.buffer);
        orders.forEach((o, i) => {
          const at = inPtr + i * ORDER_SIZE;
          view.setUint8(at, o.side === 'buy' ? 0 : 1);
          view.setBigUint64(at + 8, u64(o.price, 'a price'), true);
          view.setBigUint64(at + 16, u64(o.quantity, 'a quantity'), true);
        });
        const code = x.preview(u64(grid.min, 'the grid minimum'), u64(grid.tick, 'the tick'), grid.ticks, reference === null ? 0 : 1, reference === null ? 0n : u64(reference, 'the reference'), u64(minMatched, 'the minimum matched'), maxImbalanceBps ?? 0xffffffff, inPtr, n, outPtr);
        if (code !== 0) throw new ClearingInputError(ERRORS[code] ?? `error ${code}`);
        const out = new DataView(x.memory.buffer);
        const u128 = (at: number) => out.getBigUint64(outPtr + at, true) | (out.getBigUint64(outPtr + at + 8, true) << 64n);
        const fills = Array.from({ length: n }, (_, i) => out.getBigUint64(outPtr + OUT_HEADER + i * 8, true));
        if (out.getUint32(outPtr, true) === 0) return { printed: false, reason: REASONS[out.getUint32(outPtr + 4, true)] ?? 'NoCross', fills };
        const rationed = out.getUint32(outPtr + 64, true);
        return {
          printed: true,
          price: out.getBigUint64(outPtr + 8, true),
          matched: u128(16),
          demand: u128(32),
          supply: u128(48),
          rationed: rationed === 1 ? 'buy' : rationed === 2 ? 'sell' : null,
          marginalOrders: out.getUint32(outPtr + 68, true),
          marginalQuantity: u128(72),
          marginalRemaining: u128(88),
          fills,
        };
      } finally {
        x.dealloc(inPtr, inBytes);
        x.dealloc(outPtr, outBytes);
      }
    },
    buyerPays: (f, p, s) => amount(x.buyer_pays(u64(f, 'filled'), u64(p, 'price'), u64(s, 'the price scale'))),
    sellerReceives: (f, p, s) => amount(x.seller_receives(u64(f, 'filled'), u64(p, 'price'), u64(s, 'the price scale'))),
  };
}
