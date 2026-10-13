import Link from 'next/link';
import { get } from '@/lib/api';
import type { ExecutionMetrics, ExternalFlowMetrics, FairnessMetrics } from '@/lib/types';
import { bps, interval, ofCount, plural } from './format';
import { MetricCard, MetricUnavailable } from './metric-card';

/** The compact home-page view of the measured figures. Every number comes from /v1/metrics/*; each card names its sample and how it is computed. */
export async function MeasuredSoFar() {
  const [exec, fair, flow] = await Promise.all([
    get<ExecutionMetrics>('/v1/metrics/execution'),
    get<FairnessMetrics>('/v1/metrics/fairness'),
    get<ExternalFlowMetrics>('/v1/metrics/external-flow'),
  ]);
  const network = exec.ok ? exec.data.network : fair.ok ? fair.data.network : flow.ok ? flow.data.network : null;
  return (
    <>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="measured" className="text-sm text-muted">
          Measured so far
        </h2>
        <p className="font-mono text-xs text-muted">
          {network ? (
            <>
              Computed from indexed crosses · network: <span className="text-ink">{network}</span> · test traffic, no audit, no mainnet users
            </>
          ) : (
            'Computed from indexed crosses'
          )}
        </p>
      </div>
      <dl className="mt-6 grid grid-cols-1 gap-8 sm:grid-cols-2 lg:grid-cols-4">
        {exec.ok ? (
          <MetricCard
            id="fill-rate"
            label="bids filled"
            value={ofCount(exec.data.bids.filled, exec.data.bids.placed)}
            sample={`${plural(exec.data.crosses, 'cross', 'crosses')} that printed`}
            method="Cancelled and unrevealed bids count as placed."
          />
        ) : (
          <MetricUnavailable id="fill-rate" label="bids filled" error={exec.error} />
        )}
        {exec.ok ? (
          <MetricCard
            id="improvement"
            label="median price improvement of a filled bid, against its own limit"
            value={exec.data.priceImprovement.filledBids ? bps(exec.data.priceImprovement.bps.median) : 'no data'}
            sample={`${plural(exec.data.priceImprovement.filledBids, 'filled bid')} · 10th percentile ${bps(exec.data.priceImprovement.bps.p10)}`}
            method="Limit price minus the one clearing price paid, as basis points of the limit."
          />
        ) : (
          <MetricUnavailable id="improvement" label="price improvement against the limit" error={exec.error} />
        )}
        {fair.ok ? (
          <MetricCard
            id="concentration"
            label={`crosses where the largest buyer took over ${Math.round(fair.data.threshold * 100)}% of the fill`}
            value={ofCount(fair.data.topBuyerAboveThreshold.k, fair.data.topBuyerAboveThreshold.n)}
            sample={`${plural(fair.data.crosses, 'cross', 'crosses')} that printed${interval(fair.data.topBuyerAboveThreshold.wilsonLo, fair.data.topBuyerAboveThreshold.wilsonHi) ? ` · ${interval(fair.data.topBuyerAboveThreshold.wilsonLo, fair.data.topBuyerAboveThreshold.wilsonHi)}` : ''}`}
            method="By wallet address; one actor with many wallets would look more spread out."
          />
        ) : (
          <MetricUnavailable id="concentration" label="concentration of fills" error={fair.error} />
        )}
        {flow.ok ? (
          <MetricCard
            id="external"
            label="wallets not known to be ours"
            value={ofCount(flow.data.wallets.external, flow.data.wallets.total)}
            sample={`${plural(flow.data.crosses.withOrders, 'cross', 'crosses')} with orders`}
            tone={flow.data.ownWalletsConfigured === 0 ? 'caution' : 'plain'}
            method={
              flow.data.ownWalletsConfigured === 0
                ? 'Upper bound: only each cross’s creator, integrator and fee recipient are excluded, so test wallets we run are still counted here.'
                : `Upper bound: excludes ${plural(flow.data.ownWalletsConfigured, 'listed wallet')} and each cross’s creator, integrator and fee recipient; throwaway test wallets we create are not on the list.`
            }
          />
        ) : (
          <MetricUnavailable id="external" label="outside wallets" error={flow.error} />
        )}
      </dl>
      <p className="mt-6 text-sm text-muted">
        <Link href="/accuracy#execution" className="underline decoration-accent underline-offset-4 hover:text-ink">
          Full method, refunds, timing and per-cross fairness
        </Link>
        {' · '}
        <Link href="/export" className="underline decoration-accent underline-offset-4 hover:text-ink">
          Download these figures (CSV, JSON)
        </Link>
      </p>
    </>
  );
}
