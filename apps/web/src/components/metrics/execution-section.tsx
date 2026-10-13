import { get } from '@/lib/api';
import type { ExecutionMetrics } from '@/lib/types';
import { atoms, bps, ofCount, plural, seconds, share } from './format';
import { MetricCard } from './metric-card';

/** Execution quality over every finalized cross that printed (GET /v1/metrics/execution). */
export async function ExecutionSection() {
  const res = await get<ExecutionMetrics>('/v1/metrics/execution');
  return (
    <section id="execution" className="mt-12 scroll-mt-20" aria-labelledby="execution-title">
      <h2 id="execution-title" className="text-2xl font-semibold tracking-tight">
        Execution quality
      </h2>
      <p className="mt-2 text-muted">What bidders actually got, measured on crosses that finalized with a printed price.</p>
      {!res.ok ? (
        <p role="status" className="mt-6 rounded-[var(--radius-card)] border border-border p-5 text-sm text-muted" data-testid="execution-error">
          Execution quality cannot be loaded right now: {res.error}
        </p>
      ) : res.data.crosses === 0 ? (
        <p role="status" className="mt-6 rounded-[var(--radius-card)] border border-border p-5 text-sm text-muted" data-testid="execution-empty">
          No cross has finalized with a printed price on {res.data.network} yet, so there is nothing to measure. Nothing on this page is example data.
        </p>
      ) : (
        <Body m={res.data} />
      )}
    </section>
  );
}

function Body({ m }: { m: ExecutionMetrics }) {
  const sample = plural(m.crosses, 'cross', 'crosses');
  const pi = m.priceImprovement;
  const b = m.bids;
  return (
    <>
      <dl className="mt-6 grid grid-cols-1 gap-8 sm:grid-cols-2 lg:grid-cols-3" data-testid="execution-figures">
        <MetricCard
          id="x-fill"
          label="bids filled"
          value={ofCount(b.filled, b.placed)}
          sample={sample}
          method={`${b.fullyFilled} filled in full, ${b.partiallyFilled} partly, ${b.notFilledPricedOut} priced below the clearing price, ${b.cancelled} cancelled, ${b.unrevealed} sealed and never revealed.`}
        />
        <MetricCard
          id="x-improvement"
          label="price improvement of a filled bid, median"
          value={pi.filledBids ? bps(pi.bps.median) : 'no data'}
          sample={`${plural(pi.filledBids, 'filled bid')} · ${sample}`}
          method={`10th percentile ${bps(pi.bps.p10)}. In quote units: median ${atoms(pi.quoteAtoms.median, pi.quoteAtoms.quoteDecimals)}, 10th percentile ${atoms(pi.quoteAtoms.p10, pi.quoteAtoms.quoteDecimals)} per filled bid. ${ofCount(pi.atClearingPrice, pi.filledBids)} bid exactly at the clearing price, so had nothing to improve.`}
        />
        <MetricCard
          id="x-refund"
          label="of bid escrow returned to bidders, median per cross"
          value={share(m.refundShare.median)}
          sample={`${plural(m.refundShare.crosses, 'cross', 'crosses')} with bids`}
          method={m.refundShare.min === null ? '' : `Lowest ${share(m.refundShare.min)}, highest ${share(m.refundShare.max)}. Bidders post their limit price up front; the difference to what they paid comes back.`}
        />
        <MetricCard
          id="x-finalized"
          label="from the close to a finalized cross, median"
          value={seconds(m.closeToFinalizedSeconds.median)}
          sample={`${plural(m.closeToFinalizedSeconds.n, 'cross', 'crosses')} with a block time`}
          method={`90th percentile ${seconds(m.closeToFinalizedSeconds.p90)}, longest ${seconds(m.closeToFinalizedSeconds.max)}. A sealed cross includes its reveal window.`}
        />
        <MetricCard
          id="x-cleared"
          label="from the close to a printed price, median"
          value={seconds(m.closeToClearedSeconds.median)}
          sample={`${plural(m.closeToClearedSeconds.n, 'cross', 'crosses')} with a block time`}
          method={`90th percentile ${seconds(m.closeToClearedSeconds.p90)}, longest ${seconds(m.closeToClearedSeconds.max)}.`}
        />
        <MetricCard id="x-noprint" label="finalized crosses with no print, not in this sample" value={String(m.finalizedWithoutPrint)} sample="refunded in full" method="A cross that cannot print refunds every bidder." />
      </dl>
      <p className="mt-6 text-sm text-muted" data-testid="execution-method">
        <span className="font-medium text-ink">Method.</span> {m.method}
      </p>
      {pi.inconsistent + b.unaccounted > 0 ? (
        <p role="status" className="mt-3 text-sm text-ink">
          {pi.inconsistent} filled {pi.inconsistent === 1 ? 'bid' : 'bids'} and {b.unaccounted} {b.unaccounted === 1 ? 'bid' : 'bids'} in an unexpected state were left out because the index disagrees with the rules of the program.
        </p>
      ) : null}
    </>
  );
}
