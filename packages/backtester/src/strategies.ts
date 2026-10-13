// Strategies to replay. They are small on purpose: each one is a function from the book a cross had to the orders to add.
// The market-maker strategy is the production bot's own (services/marketmaker), so a backtest of it tests the code that runs.
import type { Grid as LiquidityGrid } from '@opening-cross/liquidity';
import { buildQuote } from '@opening-cross/marketmaker';
import type { Order, Strategy, StrategyContext } from './types.js';

const snapUp = (p: bigint, c: StrategyContext['cross']): bigint => {
  const g = c.grid;
  const top = g.min + BigInt(g.ticks - 1) * g.tick;
  if (p <= g.min) return g.min;
  if (p >= top) return top;
  return g.min + ((p - g.min + g.tick - 1n) / g.tick) * g.tick;
};

/** Buy `quantity` base atoms in every open-book cross at a limit `slackBps` above the last printed price of the pair. */
export function passiveBuy(p: { quantity: bigint; slackBps: number }): Strategy {
  return {
    name: 'passive-buy',
    description: `Buy ${p.quantity} base atoms in each cross at a limit ${p.slackBps} bps above the pair's last printed price; sit out a pair with no earlier print.`,
    orders: (ctx) => (ctx.reference === null ? [] : [{ side: 'buy', price: snapUp((ctx.reference * BigInt(10_000 + p.slackBps)) / 10_000n, ctx.cross), quantity: p.quantity }]),
  };
}

/** The production market-maker bot's ladder around the last printed price, from a per-cross budget. */
export function marketMaker(p: { halfSpreadBps: number; levels: number; stepBps: number; quoteBudget: bigint; baseBudget: bigint }): Strategy {
  return {
    name: 'market-maker',
    description: `The market-maker bot's ladder (${p.levels} levels, ${p.halfSpreadBps} bps from the last printed price, ${p.stepBps} bps apart) with budgets of ${p.quoteBudget} quote and ${p.baseBudget} base atoms per cross.`,
    orders(ctx) {
      if (ctx.reference === null) return [];
      const g = ctx.cross.grid;
      const grid: LiquidityGrid = { minPrice: g.min, tick: g.tick, ticks: g.ticks, priceScale: g.priceScale };
      const plan = buildQuote(
        ctx.reference,
        { halfSpreadBps: p.halfSpreadBps, levels: p.levels, stepBps: p.stepBps, quoteBudget: p.quoteBudget, baseBudget: p.baseBudget, minSecondsLeft: 0 },
        grid,
        { quote: p.quoteBudget, base: p.baseBudget },
        ctx.cross.supplyMode === 'escrow',
      );
      if (plan.kind === 'skip') return [];
      const orders: Order[] = [];
      for (const s of plan.ladder.buy) orders.push({ side: 'buy', price: s.price, quantity: s.quantity });
      for (const s of plan.ladder.sell) orders.push({ side: 'sell', price: s.price, quantity: s.quantity });
      return orders;
    },
  };
}

/** A late, large buy at the top of the grid: pays the clearing price like everyone else, which is what this measures. */
export function lastSecondBid(p: { quantity: bigint }): Strategy {
  return {
    name: 'last-second-bid',
    description: `Buy ${p.quantity} base atoms at the highest price on the grid, as the last order in. In a uniform-price call the price paid is the clearing price, not the limit.`,
    orders: (ctx) => [{ side: 'buy', price: ctx.cross.grid.min + BigInt(ctx.cross.grid.ticks - 1) * ctx.cross.grid.tick, quantity: p.quantity }],
  };
}

export const STRATEGIES: Record<string, (params: Record<string, string>) => Strategy> = {
  'passive-buy': (q) => passiveBuy({ quantity: BigInt(q.quantity ?? '10000000'), slackBps: Number(q.slackBps ?? '200') }),
  'market-maker': (q) =>
    marketMaker({ halfSpreadBps: Number(q.halfSpreadBps ?? '200'), levels: Number(q.levels ?? '3'), stepBps: Number(q.stepBps ?? '100'), quoteBudget: BigInt(q.quoteBudget ?? '400000000'), baseBudget: BigInt(q.baseBudget ?? '200000000') }),
  'last-second-bid': (q) => lastSecondBid({ quantity: BigInt(q.quantity ?? '100000000') }),
};
