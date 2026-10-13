import Link from 'next/link';
import { get } from '@/lib/api';
import type { ExternalFlowMetrics, FairnessMetrics } from '@/lib/types';
import { shortAddress } from '@/lib/units';
import { interval, ofCount, plural, share } from './format';
import { MetricCard } from './metric-card';

/** Fairness of allocation and external flow (GET /v1/metrics/fairness and /v1/metrics/external-flow). */
export async function FairnessSection() {
  const [fair, flow] = await Promise.all([get<FairnessMetrics>('/v1/metrics/fairness'), get<ExternalFlowMetrics>('/v1/metrics/external-flow')]);
  return (
    <section id="fairness" className="mt-12 scroll-mt-20" aria-labelledby="fairness-title">
      <h2 id="fairness-title" className="text-2xl font-semibold tracking-tight">
        Fairness and who is trading
      </h2>
      <p className="mt-2 text-muted">How concentrated the fills are, and how much of the traffic is not ours.</p>
      {!fair.ok ? (
        <p role="status" className="mt-6 rounded-[var(--radius-card)] border border-border p-5 text-sm text-muted" data-testid="fairness-error">
          The fairness report cannot be loaded right now: {fair.error}
        </p>
      ) : fair.data.crosses === 0 ? (
        <p role="status" className="mt-6 rounded-[var(--radius-card)] border border-border p-5 text-sm text-muted" data-testid="fairness-empty">
          No cross has finalized with a printed price on {fair.data.network} yet, so there are no fills to measure. Nothing on this page is example data.
        </p>
      ) : (
        <FairnessBody f={fair.data} />
      )}
      {flow.ok ? (
        <div className="mt-10" data-testid="external-flow">
          <h3 className="text-lg font-medium">Wallets we do not operate</h3>
          <dl className="mt-4 grid grid-cols-1 gap-8 sm:grid-cols-2 lg:grid-cols-3">
            <MetricCard
              id="e-wallets"
              label="wallets not known to be ours"
              value={ofCount(flow.data.wallets.external, flow.data.wallets.total)}
              sample={`${plural(flow.data.crosses.withOrders, 'cross', 'crosses')} with orders, any state`}
              tone={flow.data.ownWalletsConfigured === 0 ? 'caution' : 'plain'}
              method={flow.data.verdict}
            />
            <MetricCard
              id="e-filled"
              label="wallets with a fill that are not known to be ours"
              value={ofCount(flow.data.filledWallets.external, flow.data.filledWallets.total)}
              sample={`${ofCount(flow.data.orders.filledByExternal, flow.data.orders.filled)} filled orders`}
              method="An outside wallet that only placed orders and was never filled is not counted here."
            />
            <MetricCard
              id="e-crosses"
              label="crosses with at least one outside wallet"
              value={ofCount(flow.data.crosses.withAnExternalWallet, flow.data.crosses.withOrders)}
              sample={`${flow.data.crosses.onlyOwnWallets} had only our wallets`}
              method="Counted over every cross with orders, in any state."
            />
          </dl>
          <p className="mt-4 text-sm text-muted" data-testid="external-method">
            <span className="font-medium text-ink">Method.</span> {flow.data.method}
          </p>
        </div>
      ) : (
        <p role="status" className="mt-8 rounded-[var(--radius-card)] border border-border p-5 text-sm text-muted" data-testid="external-error">
          The outside-wallet scorecard cannot be loaded right now: {flow.error}
        </p>
      )}
    </section>
  );
}

function FairnessBody({ f }: { f: FairnessMetrics }) {
  const sample = plural(f.crosses, 'cross', 'crosses');
  const t = f.topBuyerAboveThreshold;
  const m = f.medianBuySide;
  const pct = Math.round(f.threshold * 100);
  return (
    <>
      <dl className="mt-6 grid grid-cols-1 gap-8 sm:grid-cols-2 lg:grid-cols-3" data-testid="fairness-figures">
        <MetricCard id="f-top1" label={`crosses where the largest buyer took over ${pct}% of the fill`} value={ofCount(t.k, t.n)} sample={`${sample} with a filled buyer`} method={interval(t.wilsonLo, t.wilsonHi) ?? ''} />
        <MetricCard
          id="f-share"
          label="share of the buy-side fill taken by the largest wallet, median"
          value={share(m.top1)}
          sample={`${plural(m.crossesOver1, 'cross', 'crosses')} with more than one filled buyer`}
          method="Crosses with a single filled buyer are left out: that buyer trivially takes all of it."
        />
        <MetricCard
          id="f-share5"
          label="share taken by the largest 5 wallets, median"
          value={share(m.top5)}
          sample={`${plural(m.crossesOver5, 'cross', 'crosses')} with more than 5 filled buyers`}
          method={m.crossesOver5 === 0 ? 'No cross has had more than 5 filled buyers yet, so this is not measurable.' : ''}
        />
        <MetricCard
          id="f-share10"
          label="share taken by the largest 10 wallets, median"
          value={share(m.top10)}
          sample={`${plural(m.crossesOver10, 'cross', 'crosses')} with more than 10 filled buyers`}
          method={m.crossesOver10 === 0 ? 'No cross has had more than 10 filled buyers yet, so this is not measurable.' : ''}
        />
        <MetricCard
          id="f-wallets"
          label="distinct bidding wallets across these crosses"
          value={f.wallets.distinctAcrossCrosses.toLocaleString('en-US')}
          sample={`median ${f.wallets.medianBiddersPerCross ?? 'no data'} per cross · most in one cross ${f.wallets.maxBiddersInACross ?? 'no data'}`}
          method="Wallets, not people, unless a cross is gated; see the method."
        />
        <MetricCard id="f-self" label="crosses where one wallet filled on both sides" value={ofCount(f.crossesWithSelfCross, f.crosses)} sample={sample} method="A wallet trading against itself." />
      </dl>
      <p className="mt-6 text-sm text-muted" data-testid="fairness-method">
        <span className="font-medium text-ink">Method.</span> {f.method}
      </p>
      <details className="mt-6 rounded-[var(--radius-card)] border border-border p-4" data-testid="fairness-per-cross">
        <summary className="cursor-pointer text-sm font-medium">Per-cross figures ({sample})</summary>
        <div className="mt-4 overflow-x-auto" tabIndex={0} role="region" aria-label="Per-cross fairness figures">
          <table className="w-full min-w-[560px] text-left text-sm">
            <thead className="text-xs text-muted">
              <tr>
                <th className="py-2 pr-4 font-normal">Cross</th>
                <th className="py-2 pr-4 font-normal">Bidders</th>
                <th className="py-2 pr-4 font-normal">Largest 1</th>
                <th className="py-2 pr-4 font-normal">Largest 5</th>
                <th className="py-2 pr-4 font-normal">Largest 10</th>
                <th className="py-2 font-normal">Identity</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border font-mono text-xs">
              {f.perCross.map((c) => (
                <tr key={c.address}>
                  <td className="py-2 pr-4">
                    <Link href={`/crosses/${c.address}`} className="underline decoration-accent underline-offset-4 hover:text-muted">
                      {shortAddress(c.address)}
                    </Link>
                  </td>
                  <td className="py-2 pr-4">{c.bidders}</td>
                  <td className="py-2 pr-4">{share(c.buy.top1)}</td>
                  <td className="py-2 pr-4">{c.buy.wallets > 5 ? share(c.buy.top5) : 'n/a'}</td>
                  <td className="py-2 pr-4">{c.buy.wallets > 10 ? share(c.buy.top10) : 'n/a'}</td>
                  <td className="py-2">{c.identity.gated ? `${c.identity.count} gate-passing wallets` : `${c.identity.count} wallets, not people`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-xs text-muted">n/a: the side had that many wallets or fewer, so the share would trivially be 100%.</p>
      </details>
    </>
  );
}
