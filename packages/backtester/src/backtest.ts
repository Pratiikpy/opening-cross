// Runs a strategy over history in the order the crosses closed and summarises what happened.
//
// What the numbers mean, and what they do not. Every cross is re-cleared with the strategy's orders added to the book the
// program settled. The replay is only as good as its check against the chain, so each cross is first replayed AS IT WAS and
// compared with the program's record; the summary reports how many matched. A strategy's orders change the clearing price, and
// the summary reports that change; it does not model how other participants would have reacted to the strategy being there,
// and it does not claim a profit: there is no future price in a closed history, only the prices the crosses printed.
import { replayCross } from './engine.js';
import type { CrossReplay, HistoricalCross, Strategy } from './types.js';

export type SideTotals = { orders: number; filled: bigint; quote: bigint; avgPrice: bigint | null };

export type Summary = {
  strategy: string;
  crosses: number;
  /** Replayed as they were: did the replay reproduce the program's record? */
  baseline: { match: number; mismatch: number; external: number };
  participated: number;
  buys: SideTotals;
  sells: SideTotals;
  /** Crosses where the strategy's orders were all unfilled. */
  unfilled: number;
  /** Change of clearing price caused by the strategy's own orders, in grid ticks, over crosses that printed with and without it. */
  impactTicks: { crosses: number; mean: number | null; max: number | null };
  /** The strategy's orders made a cross print that would not have, or stopped one printing. */
  caused: { printed: number; noPrint: number };
};

export type BacktestResult = { strategy: Strategy; replays: CrossReplay[]; summary: Summary };

export function backtest(crosses: readonly HistoricalCross[], strategy: Strategy): BacktestResult {
  const ordered = [...crosses].sort((a, b) => (a.closeTs < b.closeTs ? -1 : a.closeTs > b.closeTs ? 1 : a.address < b.address ? -1 : 1));
  const lastPrint = new Map<string, bigint>();
  const replays: CrossReplay[] = [];
  for (const c of ordered) {
    const key = `${c.baseMint}|${c.quoteMint}|${c.grid.priceScale}`;
    replays.push(replayCross(c, strategy, lastPrint.get(key) ?? null));
    // What the history printed, not the counterfactual: the reference for the next cross is a price that existed.
    if (c.recorded?.printed) lastPrint.set(key, c.recorded.price);
  }
  return { strategy, replays, summary: summarise(strategy.name, replays) };
}

function summarise(name: string, replays: readonly CrossReplay[]): Summary {
  const side = (s: 'buy' | 'sell'): SideTotals => {
    let orders = 0;
    let filled = 0n;
    let quote = 0n;
    for (const r of replays) {
      for (const o of r.orders) {
        if (o.order.side !== s) continue;
        orders++;
        filled += o.filled;
        quote += o.quote;
      }
    }
    return { orders, filled, quote, avgPrice: filled === 0n ? null : (quote * 1_000_000n) / filled };
  };
  const impacts = replays.filter((r) => r.impactTicks !== null).map((r) => r.impactTicks!);
  return {
    strategy: name,
    crosses: replays.length,
    baseline: {
      match: replays.filter((r) => r.baselineCheck === 'match').length,
      mismatch: replays.filter((r) => r.baselineCheck === 'mismatch').length,
      external: replays.filter((r) => r.baselineCheck === 'external').length,
    },
    participated: replays.filter((r) => r.participated).length,
    buys: side('buy'),
    sells: side('sell'),
    unfilled: replays.filter((r) => r.participated && r.orders.every((o) => o.filled === 0n)).length,
    impactTicks: { crosses: impacts.length, mean: impacts.length ? impacts.reduce((a, b) => a + b, 0) / impacts.length : null, max: impacts.length ? impacts.reduce((a, b) => (Math.abs(b) > Math.abs(a) ? b : a), 0) : null },
    caused: {
      printed: replays.filter((r) => r.participated && !r.baseline.printed && r.withStrategy?.printed).length,
      noPrint: replays.filter((r) => r.participated && r.baseline.printed && r.withStrategy && !r.withStrategy.printed).length,
    },
  };
}

const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x), 2);
export const toJson = (r: BacktestResult): string => json({ strategy: { name: r.strategy.name, description: r.strategy.description }, summary: r.summary, replays: r.replays });

/** A short report a person can read. `avgPrice` is quote atoms per whole base token for 6-decimal tokens. */
export function formatReport(r: BacktestResult, skipped: number): string {
  const s = r.summary;
  const lines = [
    `Strategy: ${r.strategy.name}`,
    r.strategy.description,
    '',
    `Crosses replayed: ${s.crosses}${skipped ? ` (${skipped} more could not be replayed)` : ''}`,
    `Replay as it was vs the chain: ${s.baseline.match} match, ${s.baseline.mismatch} differ, ${s.baseline.external} rest on state outside the book (oracle, halt, expired settlement)`,
    `The strategy took part in ${s.participated}; ${s.unfilled} of those left it with no fill`,
    `Bought: ${s.buys.filled} base atoms for ${s.buys.quote} quote atoms in ${s.buys.orders} orders${s.buys.avgPrice !== null ? `, average ${s.buys.avgPrice} per million base atoms` : ''}`,
    `Sold: ${s.sells.filled} base atoms for ${s.sells.quote} quote atoms (net of fees) in ${s.sells.orders} orders${s.sells.avgPrice !== null ? `, average ${s.sells.avgPrice} per million base atoms` : ''}`,
    `Its own effect on the clearing price: ${s.impactTicks.crosses} crosses, mean ${s.impactTicks.mean === null ? 'n/a' : s.impactTicks.mean.toFixed(2)} ticks, largest ${s.impactTicks.max ?? 'n/a'}`,
    `It made ${s.caused.printed} cross(es) print that would not have, and stopped ${s.caused.noPrint} from printing`,
    '',
    'Not modelled: how other participants would have reacted to these orders. No profit is claimed: a closed history has prices that printed, not prices that came next.',
  ];
  return lines.join('\n');
}
