import type { Metadata } from 'next';
import Link from 'next/link';
import { loadFigures } from './load-figures';
import { OrdersExport } from './orders-export';

export const metadata: Metadata = {
  title: 'Export',
  description: 'Download the public figures with their sample sizes and methods, or your own wallet\'s orders and fills as a CSV.',
};
export const dynamic = 'force-dynamic';

const dl = 'inline-flex min-h-10 items-center justify-center rounded-full border border-border-strong px-4 text-sm text-ink transition-colors hover:bg-surface';

export default async function Export() {
  const f = await loadFigures();
  return (
    <div className="mx-auto max-w-[1000px] px-4 py-12 sm:px-6">
      <h1 className="text-[34px] font-semibold tracking-tight">Export</h1>
      <p className="mt-2 max-w-xl text-muted">The public figures as files, and your own orders as a CSV. Every figure carries the size of the sample behind it and how it was computed.</p>

      <section className="mt-10" aria-labelledby="figures-h">
        <h2 id="figures-h" className="text-lg font-semibold">Public figures</h2>
        <p className="mt-1 text-sm text-muted">
          Network: <span className="font-mono text-ink">{f.network}</span>. These come from test traffic on devnet: there is no audit and there are no mainnet users. The same figures are on the{' '}
          <Link href="/#measured" className="underline underline-offset-4">home page</Link>.
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <a className={dl} href="/export/figures.csv" download>
            Download CSV
          </a>
          <a className={dl} href="/export/figures.json" download>
            Download JSON
          </a>
        </div>
        {f.missing.length > 0 ? (
          <p role="status" className="mt-4 text-sm text-muted">
            Not available right now, so not in the files: {f.missing.join(', ')}.
          </p>
        ) : null}
        {f.rows.length === 0 ? (
          <p role="status" className="mt-6 text-sm text-muted">The Opening Cross API could not be reached, so there are no figures to show or download.</p>
        ) : (
          <div role="region" aria-label="Table of public figures" tabIndex={0} className="mt-6 overflow-x-auto">
            <table className="w-full min-w-[720px] text-left text-sm" data-testid="figures-table">
              <caption className="sr-only">Public figures with unit, sample size and method</caption>
              <thead className="font-mono text-xs uppercase tracking-wider text-muted">
                <tr>
                  <th scope="col" className="py-2 pr-4 font-normal">Figure</th>
                  <th scope="col" className="py-2 pr-4 text-right font-normal">Value</th>
                  <th scope="col" className="py-2 pr-4 font-normal">Unit</th>
                  <th scope="col" className="py-2 pr-4 text-right font-normal">Sample</th>
                  <th scope="col" className="py-2 font-normal">Method</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border align-top">
                {f.rows.map((r) => (
                  <tr key={r.metric}>
                    <th scope="row" className="py-2 pr-4 font-mono text-xs font-normal">{r.metric}</th>
                    <td className="py-2 pr-4 text-right font-mono">{r.value === '' ? <span className="text-muted">no data</span> : r.value}</td>
                    <td className="py-2 pr-4 text-muted">{r.unit}</td>
                    <td className="py-2 pr-4 text-right font-mono">{r.sampleSize} <span className="font-sans text-xs text-muted">{r.sampleUnit}</span></td>
                    <td className="py-2 text-muted">{r.method}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="mt-12" aria-labelledby="orders-h">
        <h2 id="orders-h" className="text-lg font-semibold">Your orders and fills</h2>
        <p className="mt-1 mb-4 max-w-xl text-sm text-muted">
          One row per order of the connected wallet, with the times and transactions of its events, what it was filled, paid, refunded or received, in tokens and in raw atoms. Built in your browser from the public API.
        </p>
        <OrdersExport />
      </section>
    </div>
  );
}
