'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useClock } from '@/components/calendar/use-clock';
import { Pill } from '@/components/issuer/treasury-ui';
import { type SeriesRead, countText, isCalendar, nextCloseTs, scheduleText, seriesStatus, utcAt } from '@/lib/series';
import { loadSeries, loadSeriesList, loadSessionStarts } from '@/lib/series-load';
import { formatDuration, shortAddress } from '@/lib/units';

const TONE = { running: 'ok', waiting: 'info', paused: 'warn', done: 'info' } as const;
const TEXT = { running: 'A cross is running', waiting: 'Waiting for the next slot', paused: 'Paused', done: 'Finished' } as const;

/** Every recurring series on the network, with its schedule and when its next cross closes. */
export function SeriesIndex() {
  const now = useClock(Math.floor(Date.now() / 1000));
  const [rows, setRows] = useState<{ read: SeriesRead; sessions: number[] | null }[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void loadSeriesList().then(async (l) => {
      if (!live) return;
      if (!l.ok) {
        setError(l.error);
        return;
      }
      const all = await Promise.all(l.data.series.map(async (s) => loadSeries(s.address)));
      const reads = all.filter((r): r is Extract<typeof r, { ok: true }> => r.ok).map((r) => r.data);
      const withSessions = await Promise.all(
        reads.map(async (read) => {
          if (!isCalendar(read)) return { read, sessions: null };
          const s = await loadSessionStarts(read.schedule.calendar);
          return { read, sessions: s.ok ? s.data : null };
        }),
      );
      if (live) setRows(withSessions);
    });
    return () => {
      live = false;
    };
  }, []);

  if (error) {
    return (
      <p role="alert" className="mt-8 text-sm text-accent-text" data-testid="series-index-error">
        {error}
      </p>
    );
  }
  if (!rows) {
    return (
      <p role="status" className="mt-8 text-sm text-muted">
        Reading the series from the chain…
      </p>
    );
  }
  if (rows.length === 0) {
    return (
      <p className="mt-8 text-sm text-muted" data-testid="series-empty">
        No recurring series exists on this network yet. An issuer creates one from <Link href="/issuer/series" className="underline underline-offset-4">the issuer console</Link>.
      </p>
    );
  }
  return (
    <ul className="mt-8 grid gap-4" data-testid="series-list">
      {rows.map(({ read, sessions }) => {
        const status = seriesStatus(read, null);
        const next = status === 'paused' || status === 'done' ? null : nextCloseTs(read, now, sessions);
        return (
          <li key={read.series}>
            <Link href={`/series/${read.series}`} className="block rounded-[var(--radius-card)] border border-border p-5 transition-colors hover:bg-surface" data-testid={`series-${read.series}`}>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <span className="font-mono text-sm">{shortAddress(read.series)}</span>
                <Pill tone={TONE[status]}>{TEXT[status]}</Pill>
              </div>
              <p className="mt-2 text-sm">{scheduleText(read)}</p>
              <p className="mt-1 text-sm text-muted">
                {countText(read)}. {next !== null ? `Next close ${utcAt(next)}, in ${formatDuration(BigInt(Math.max(0, next - now)))}.` : status === 'paused' ? 'Spawning is paused.' : status === 'done' ? 'It ran its last cross.' : 'The next close is not known yet.'}
              </p>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
