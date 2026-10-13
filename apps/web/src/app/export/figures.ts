// The public figures (O1, O2) as rows: each with its value, unit, sample size, method and the endpoint it came from. Pure, so the
// rules are tested: a figure with no data is written as an empty value, never as zero, and a ratio is
// never exported without the count it is a ratio of.
import type { ExecutionMetrics, ExternalFlowMetrics, FairnessMetrics } from '../../lib/types';

export type Stats = { network: string; crosses_printed: number; crosses_total: number; buyers_filled: number; quote_to_sellers: string; quote_refunded_to_buyers: string; crosses_no_print: number };

export type FigureRow = {
  metric: string;
  value: string;
  unit: string;
  sampleSize: string;
  sampleUnit: string;
  method: string;
  source: string;
};

export const FIGURE_COLUMNS = ['metric', 'value', 'unit', 'sample_size', 'sample_unit', 'method', 'source', 'network', 'generated_at'] as const;

const num = (x: number | string | null | undefined): string => (x === null || x === undefined ? '' : String(x));

export type FigureInputs = { stats: Stats | null; execution: ExecutionMetrics | null; fairness: FairnessMetrics | null; flow: ExternalFlowMetrics | null };

/** Rows for every figure whose source answered. A source that did not answer contributes no rows and is named in `missing`. */
export function figureRows(i: FigureInputs): { rows: FigureRow[]; missing: string[] } {
  const rows: FigureRow[] = [];
  const missing: string[] = [];
  const add = (r: FigureRow) => rows.push(r);

  if (i.stats) {
    const s = i.stats;
    const src = '/v1/stats';
    const method = 'Counted from indexed cross events.';
    add({ metric: 'crosses_total', value: num(s.crosses_total), unit: 'crosses', sampleSize: num(s.crosses_total), sampleUnit: 'crosses', method, source: src });
    add({ metric: 'crosses_printed', value: num(s.crosses_printed), unit: 'crosses', sampleSize: num(s.crosses_total), sampleUnit: 'crosses', method: 'Crosses cleared or finalized with a clearing price.', source: src });
    add({ metric: 'crosses_no_print', value: num(s.crosses_no_print), unit: 'crosses', sampleSize: num(s.crosses_total), sampleUnit: 'crosses', method: 'Crosses that ended with no clearing price; every order was refunded.', source: src });
    add({ metric: 'wallets_with_a_filled_buy', value: num(s.buyers_filled), unit: 'wallets', sampleSize: num(s.crosses_printed), sampleUnit: 'printed crosses', method: 'Distinct owner addresses with a buy order that filled. Wallets, not people.', source: src });
    add({ metric: 'quote_paid_to_sellers_atoms', value: s.quote_to_sellers, unit: 'quote atoms, summed over quote mints', sampleSize: num(s.crosses_printed), sampleUnit: 'printed crosses', method: 'Sum of quote_out over claimed sell orders. Different quote mints are added as raw atoms, so it is a count of atoms, not a value.', source: src });
  } else missing.push('/v1/stats');

  if (i.execution) {
    const e = i.execution;
    const src = '/v1/metrics/execution';
    add({ metric: 'bids_filled', value: num(e.bids.filled), unit: 'bids', sampleSize: num(e.bids.placed), sampleUnit: 'bids placed', method: 'Bids that received any fill, over every bid placed in a finalized cross that printed; cancelled and unrevealed bids count as placed. The full method is in the `method` field of the source endpoint, included in the JSON export.', source: src });
    add({ metric: 'bid_fill_rate', value: num(e.bids.fillRate), unit: 'ratio 0..1', sampleSize: num(e.bids.placed), sampleUnit: 'bids placed', method: 'Filled bids divided by placed bids; cancelled and unrevealed bids count as placed.', source: src });
    add({ metric: 'price_improvement_median_bps', value: num(e.priceImprovement.bps.median), unit: 'basis points of the limit', sampleSize: num(e.priceImprovement.filledBids), sampleUnit: 'filled bids', method: 'Limit price minus the clearing price paid, as basis points of the limit.', source: src });
    add({ metric: 'price_improvement_p10_bps', value: num(e.priceImprovement.bps.p10), unit: 'basis points of the limit', sampleSize: num(e.priceImprovement.filledBids), sampleUnit: 'filled bids', method: '10th percentile of the same distribution.', source: src });
    add({ metric: 'refund_share_median', value: num(e.refundShare.median), unit: 'ratio 0..1', sampleSize: num(e.refundShare.crosses), sampleUnit: 'crosses', method: 'Share of bid escrow returned to bidders, median over crosses.', source: src });
    add({ metric: 'close_to_cleared_median_s', value: num(e.closeToClearedSeconds.median), unit: 'seconds', sampleSize: num(e.closeToClearedSeconds.n), sampleUnit: 'crosses', method: 'Seconds from the call closing to the clearing transaction.', source: src });
    add({ metric: 'close_to_cleared_p90_s', value: num(e.closeToClearedSeconds.p90), unit: 'seconds', sampleSize: num(e.closeToClearedSeconds.n), sampleUnit: 'crosses', method: '90th percentile of the same distribution.', source: src });
    add({ metric: 'close_to_finalized_median_s', value: num(e.closeToFinalizedSeconds.median), unit: 'seconds', sampleSize: num(e.closeToFinalizedSeconds.n), sampleUnit: 'crosses', method: 'Seconds from the call closing to the finalize transaction.', source: src });
    add({ metric: 'close_to_finalized_p90_s', value: num(e.closeToFinalizedSeconds.p90), unit: 'seconds', sampleSize: num(e.closeToFinalizedSeconds.n), sampleUnit: 'crosses', method: '90th percentile of the same distribution.', source: src });
  } else missing.push('/v1/metrics/execution');

  if (i.fairness) {
    const f = i.fairness;
    const src = '/v1/metrics/fairness';
    const t = f.topBuyerAboveThreshold;
    add({ metric: `crosses_where_top_buyer_took_over_${Math.round(f.threshold * 100)}pct`, value: num(t.k), unit: 'crosses', sampleSize: num(t.n), sampleUnit: 'printed crosses', method: 'By wallet address; one actor with many wallets would look more spread out.', source: src });
    add({ metric: 'top_buyer_over_threshold_proportion', value: num(t.proportion), unit: 'ratio 0..1', sampleSize: num(t.n), sampleUnit: 'printed crosses', method: 'The same count as a proportion.', source: src });
    add({ metric: 'top_buyer_over_threshold_wilson95_low', value: num(t.wilsonLo), unit: 'ratio 0..1', sampleSize: num(t.n), sampleUnit: 'printed crosses', method: 'Lower end of the Wilson 95% interval over crosses.', source: src });
    add({ metric: 'top_buyer_over_threshold_wilson95_high', value: num(t.wilsonHi), unit: 'ratio 0..1', sampleSize: num(t.n), sampleUnit: 'printed crosses', method: 'Upper end of the Wilson 95% interval over crosses.', source: src });
    add({ metric: 'median_top1_buyer_share', value: num(f.medianBuySide.top1), unit: 'ratio 0..1', sampleSize: num(f.crosses), sampleUnit: 'printed crosses', method: 'Median over crosses of the largest buyer\'s share of the buy-side fill.', source: src });
    add({ metric: 'median_top5_buyer_share', value: num(f.medianBuySide.top5), unit: 'ratio 0..1', sampleSize: num(f.crosses), sampleUnit: 'printed crosses', method: 'Median over crosses of the five largest buyers\' share of the buy-side fill.', source: src });
    add({ metric: 'median_bidders_per_cross', value: num(f.wallets.medianBiddersPerCross), unit: 'wallets', sampleSize: num(f.crosses), sampleUnit: 'printed crosses', method: 'Distinct bidding wallets in a cross, median over crosses.', source: src });
    add({ metric: 'crosses_with_a_self_cross', value: num(f.crossesWithSelfCross), unit: 'crosses', sampleSize: num(f.crosses), sampleUnit: 'printed crosses', method: 'Crosses in which one wallet was on both sides.', source: src });
  } else missing.push('/v1/metrics/fairness');

  if (i.flow) {
    const x = i.flow;
    const src = '/v1/metrics/external-flow';
    add({ metric: 'wallets_total', value: num(x.wallets.total), unit: 'wallets', sampleSize: num(x.crosses.withOrders), sampleUnit: 'crosses with orders', method: 'Distinct wallets with an order, over every cross with orders.', source: src });
    add({ metric: 'wallets_external', value: num(x.wallets.external), unit: 'wallets', sampleSize: num(x.wallets.total), sampleUnit: 'wallets', method: `Wallets not operated by us. Verdict: ${x.verdict}.`, source: src });
    add({ metric: 'orders_by_external_wallets', value: num(x.orders.byExternal), unit: 'orders', sampleSize: num(x.orders.total), sampleUnit: 'orders', method: 'Orders placed by wallets not operated by us.', source: src });
  } else missing.push('/v1/metrics/external-flow');

  return { rows, missing };
}

/** RFC 4180: a field with a comma, quote, CR or LF is quoted and its quotes doubled. A leading = + - @ is prefixed so a spreadsheet never runs a cell as a formula. */
export function csvField(v: string): string {
  const safe = /^[=+@]/.test(v) || (/^-/.test(v) && !/^-?\d+(\.\d+)?$/.test(v)) ? `'${v}` : v;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function toCsv(columns: readonly string[], rows: readonly (readonly string[])[]): string {
  return [columns, ...rows].map((r) => r.map(csvField).join(',')).join('\r\n') + '\r\n';
}

export function figuresCsv(rows: readonly FigureRow[], network: string, generatedAt: string): string {
  return toCsv(
    FIGURE_COLUMNS,
    rows.map((r) => [r.metric, r.value === '' ? '' : r.value, r.unit, r.sampleSize, r.sampleUnit, r.method, r.source, network, generatedAt]),
  );
}
