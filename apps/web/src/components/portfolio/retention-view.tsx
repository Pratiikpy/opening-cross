'use client';

import { useEffect, useState } from 'react';
import { HOLDER_API_URL } from '@/lib/holder-api';

type Retention = { generatedAt: number; wallets: number; returningShare: number | null; minCohort: number; method: string; cohorts: { weekStart: number; wallets: number; cells: { week: number; retained: number; rate: number | null }[] }[] };

const pct = (v: number | null) => (v === null ? '–' : `${Math.round(v * 100)}%`);
const day = (s: number) => new Date(s * 1000).toISOString().slice(0, 10);

/** Cohort retention of wallets that ordered in crosses: how many came back in a later week. Counts always, rates only for cohorts big enough to mean something. */
export function RetentionView() {
  const [d, setD] = useState<Retention | null | 'error'>(null);
  useEffect(() => {
    let live = true;
    void fetch(`${HOLDER_API_URL}/v1/metrics/retention`, { cache: 'no-store' })
      .then(async (r) => (r.ok ? ((await r.json()) as Retention) : ('error' as const)))
      .catch(() => 'error' as const)
      .then((x) => live && setD(x));
    return () => {
      live = false;
    };
  }, []);
  if (d === null) return <p role="status" className="mt-8 text-sm text-muted">Reading the index…</p>;
  if (d === 'error') return <p role="alert" className="mt-8 text-sm text-accent-text">The retention figures could not be read just now.</p>;
  const cols = Math.max(0, ...d.cohorts.map((c) => c.cells.length));
  return (
    <div className="mt-8">
      <p className="text-sm" data-testid="retention-summary">
        {d.wallets} wallets have ordered in a cross; {d.returningShare === null ? 'none yet' : `${pct(d.returningShare)} of them ordered in more than one`}.
      </p>
      {d.cohorts.length === 0 ? (
        <p className="mt-4 text-sm text-muted">No wallet has ordered yet.</p>
      ) : (
        <div className="mt-4 overflow-x-auto" tabIndex={0} role="region" aria-label="Retention by cohort">
          <table className="w-full min-w-[480px] text-sm" data-testid="retention-table">
            <caption className="sr-only">Wallets retained in later weeks, by the week of their first cross</caption>
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted">
                <th scope="col" className="py-2 pr-4 font-normal">Week of first cross</th>
                <th scope="col" className="py-2 pr-4 text-right font-normal">Wallets</th>
                {Array.from({ length: cols }, (_, i) => (
                  <th key={i} scope="col" className="py-2 pr-4 text-right font-normal">
                    Week +{i + 1}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {d.cohorts.map((c) => (
                <tr key={c.weekStart} className="border-b border-border last:border-0">
                  <th scope="row" className="py-2 pr-4 text-left font-mono font-normal">{day(c.weekStart)}</th>
                  <td className="py-2 pr-4 text-right font-mono">{c.wallets}</td>
                  {Array.from({ length: cols }, (_, i) => {
                    const cell = c.cells[i];
                    return (
                      <td key={i} className="py-2 pr-4 text-right font-mono">
                        {cell ? (cell.rate === null ? `${cell.retained} of ${c.wallets}` : `${pct(cell.rate)} (${cell.retained})`) : ''}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-4 max-w-2xl text-xs text-muted">
        {d.method} A cohort under {d.minCohort} wallets shows counts and no percentage.
      </p>
    </div>
  );
}
