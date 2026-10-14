// Z3, an order pegged to the open ("buy or sell at the open"). There is no special order type: in a uniform-price call a buy at the top of the grid
// fills at the clearing price whatever it is, and so does a sell at the bottom; a buyer pays only the clearing price, so the escrow held for the top of
// the grid is returned at the claim except for what was paid. This is `peggedOrder` (packages/cross-core-client/src/stocks.ts) without the slippage
// bound, which the typed limit already is.
export type PegGrid = { minPrice: string; tick: string; ticks: number };

/** The limit that takes whatever the open prints: the top of the grid for a buy, the bottom for a sell. */
export function pegPrice(grid: PegGrid, side: 'buy' | 'sell'): bigint {
  const min = BigInt(grid.minPrice);
  return side === 'buy' ? min + BigInt(grid.ticks - 1) * BigInt(grid.tick) : min;
}

export const isPegged = (grid: PegGrid, side: 'buy' | 'sell', price: bigint | string | null): boolean => typeof price === 'bigint' && price === pegPrice(grid, side);

export const PEG_NOTE = {
  buy: 'Pegged to the open: your limit is the top of the grid, so the order fills at whatever price the cross prints. You are held for the top price now and pay only the clearing price; the rest comes back when you claim.',
  sell: 'Pegged to the open: your limit is the bottom of the grid, so the order sells at whatever price the cross prints, whatever it is.',
} as const;
