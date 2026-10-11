import type { Metadata } from 'next';
import { get } from '@/lib/api';
import { EXCLUSION_LABEL, type PremiumGroup, type PremiumObservation, type PremiumSummary, SESSION_LABEL, SESSION_ORDER, percentOf, usdOf } from '@/lib/premium';

export const metadata: Metadata = {
  title: 'Premium monitor',
  description: 'How far the price you can actually trade a Solana stock token at sits from an independent reference, by order size and market session.',
};
export const dynamic = 'force-dynamic';

function when(s: number | null) {
  return s === null ? '—' : new Date(s * 1000).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

function SessionTable({ session, groups }: { session: PremiumGroup['session']; groups: PremiumGroup[] }) {
  return (
    <section aria-labelledby={`s-${session}`} className="py-6" data-testid={`session-${session}`}>
      <h3 id={`s-${session}`} className="text-lg font-medium">
        {SESSION_LABEL[session]}
      </h3>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-left text-xs sm:text-sm">
          <caption className="sr-only">Premium by order size and side, {SESSION_LABEL[session]}</caption>
          <thead className="text-xs text-muted">
            <tr>
              <th scope="col" className="py-2 pr-4 font-normal">Order</th>
              <th scope="col" className="py-2 pr-3 font-normal sm:pr-4">Quotes</th>
              <th scope="col" className="py-2 pr-4 font-normal">Median</th>
              <th scope="col" className="py-2 pr-4 font-normal">Middle 80%</th>
              <th scope="col" className="py-2 font-normal">Not priced</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border font-mono">
            {groups.map((g) => (
              <tr key={`${g.sizeUsd}-${g.leg}`}>
                <th scope="row" className="py-2 pr-4 font-normal">
                  {g.leg === 'buy' ? 'Buy' : 'Sell'} ${g.sizeUsd.toLocaleString('en-US')}
                </th>
                <td className="py-2 pr-4">{g.summary.n}</td>
                <td className="py-2 pr-4">{percentOf(g.summary.medianBpsX100)}</td>
                <td className="py-2 pr-4">{g.summary.n ? `${percentOf(g.summary.p10BpsX100)} to ${percentOf(g.summary.p90BpsX100)}` : '—'}</td>
                <td className="py-2 text-muted">
                  {Object.keys(g.excluded).length ? Object.entries(g.excluded).map(([k, n]) => `${n} ${EXCLUSION_LABEL[k] ?? k}`).join(', ') : 'none'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export default async function Premium() {
  const [summary, latest] = await Promise.all([get<PremiumSummary>('/v1/premium/summary?days=7', 0), get<{ observations: PremiumObservation[] }>('/v1/premium/latest', 0)]);
  const sessions = summary.ok ? SESSION_ORDER.filter((s) => summary.data.groups.some((g) => g.session === s)) : [];
  const tokens = new Map<string, PremiumObservation[]>();
  if (latest.ok) for (const o of latest.data.observations) tokens.set(o.symbol, [...(tokens.get(o.symbol) ?? []), o]);
  return (
    <div className="mx-auto max-w-[900px] px-4 py-12 sm:px-6">
      <h1 className="text-[34px] font-semibold tracking-tight">Premium monitor</h1>
      <p className="mt-3 text-muted">
        A stock token trades above or below the share it represents, and the gap depends on how much you trade and whether the share's own market is open. This page quotes a real swap on Jupiter at three sizes, converts it to a price per share, and sets it against an independent reference. Positive means you pay (or receive) more than the reference.
      </p>
      {!summary.ok ? (
        <p role="status" className="mt-8 rounded-[var(--radius-card)] border border-border p-5 text-sm text-muted">
          The premium record cannot be loaded right now: {summary.error}
        </p>
      ) : summary.data.coverage.rounds === 0 ? (
        <p role="status" className="mt-8 rounded-[var(--radius-card)] border border-border p-5 text-sm text-muted" data-testid="no-premium">
          Nothing has been measured in the last {summary.data.days} days. Nothing on this page is example data.
        </p>
      ) : (
        <>
          <dl className="mt-8 grid grid-cols-2 gap-4 border-y border-border py-5 text-sm sm:grid-cols-4" data-testid="premium-coverage">
            <div><dt className="text-xs text-muted">Measurement rounds</dt><dd className="mt-1 font-mono">{summary.data.coverage.rounds}</dd></div>
            <div><dt className="text-xs text-muted">Tokens</dt><dd className="mt-1 font-mono">{summary.data.coverage.tickers}</dd></div>
            <div><dt className="text-xs text-muted">First</dt><dd className="mt-1 font-mono">{when(summary.data.coverage.first)}</dd></div>
            <div><dt className="text-xs text-muted">Latest</dt><dd className="mt-1 font-mono">{when(summary.data.coverage.last)}</dd></div>
          </dl>
          <h2 className="mt-8 text-xl font-medium">Last {summary.data.days} days, by market session</h2>
          <div className="divide-y divide-border">
            {sessions.map((s) => (
              <SessionTable key={s} session={s} groups={summary.data.groups.filter((g) => g.session === s)} />
            ))}
          </div>
          {tokens.size > 0 ? (
            <section aria-labelledby="latest" className="mt-8">
              <h2 id="latest" className="text-xl font-medium">Latest round, by token</h2>
              <div className="mt-3 overflow-x-auto">
                <table className="w-full text-left text-xs sm:text-sm">
                  <caption className="sr-only">Newest premium for each token at $1,000</caption>
                  <thead className="text-xs text-muted">
                    <tr>
                      <th scope="col" className="py-2 pr-4 font-normal">Token</th>
                      <th scope="col" className="py-2 pr-4 font-normal">Reference</th>
                      <th scope="col" className="py-2 pr-4 font-normal">Buy $1,000</th>
                      <th scope="col" className="py-2 pr-4 font-normal">Sell $1,000</th>
                      <th scope="col" className="hidden py-2 font-normal sm:table-cell">Share multiplier</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border font-mono">
                    {[...tokens.entries()].map(([symbol, list]) => {
                      const buy = list.find((o) => o.sizeUsd === 1000 && o.leg === 'buy');
                      const sell = list.find((o) => o.sizeUsd === 1000 && o.leg === 'sell');
                      const show = (o?: PremiumObservation) => (o ? (o.status === 'ok' ? percentOf(o.premiumBpsX100) : (EXCLUSION_LABEL[o.status] ?? o.status)) : '—');
                      return (
                        <tr key={symbol}>
                          <th scope="row" className="py-2 pr-4 font-normal">{symbol}</th>
                          <td className="py-2 pr-4">{usdOf(buy?.referenceE6 ?? null)}</td>
                          <td className="py-2 pr-4">{show(buy)}</td>
                          <td className="py-2 pr-4">{show(sell)}</td>
                          <td className="hidden py-2 sm:table-cell">{buy?.multiplier ?? '—'}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          ) : null}
        </>
      )}
      <section className="mt-10 rounded-[var(--radius-card)] border border-border p-6 text-sm" aria-labelledby="method">
        <h2 id="method" className="font-medium">How it is measured</h2>
        <ul className="mt-2 list-disc space-y-1.5 pl-5 text-muted">
          <li>The price is a real Jupiter quote at the size shown, so it includes spread and price impact. It is a quote, not a fill.</li>
          <li>A share token's displayed balance is its raw balance times a multiplier the issuer can change; every price here is per share, using the multiplier read from the token on chain.</li>
          <li>The reference is Hyperliquid's HIP-3 oracle price for the same stock, a free 24/7 perpetual-market price. When the stock's own market is closed this compares the token with a perpetual, not with the cash market, which is why sessions are never mixed.</li>
          <li>The session comes from the issuer's own trading clock. Quotes that could not be priced (no route, issuer halted, no reference) are counted in the last column, not dropped.</li>
          <li>Only tokens confirmed as the issuer's own by the identity check are measured.</li>
        </ul>
      </section>
    </div>
  );
}
