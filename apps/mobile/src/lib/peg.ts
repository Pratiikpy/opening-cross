// An order pegged to the open (Z3): the top of the grid for a buy, the bottom for a sell, so the order fills at whatever price the cross prints. The
// same helper as apps/web/src/lib/peg.ts (the phone app is a separate project); test/schedule.test.ts holds the cases for both.
export type PegGrid = { minPrice: string; tick: string; ticks: number };

export function pegPrice(grid: PegGrid, side: 'buy' | 'sell'): bigint {
  const min = BigInt(grid.minPrice);
  return side === 'buy' ? min + BigInt(grid.ticks - 1) * BigInt(grid.tick) : min;
}

export const PEG_NOTE = {
  buy: 'Pegged to the open: your limit is the top of the grid, so the order fills at whatever price the cross prints. You are held for the top price now and pay only the clearing price; the rest comes back when you claim.',
  sell: 'Pegged to the open: your limit is the bottom of the grid, so the order sells at whatever price the cross prints, whatever it is.',
} as const;
