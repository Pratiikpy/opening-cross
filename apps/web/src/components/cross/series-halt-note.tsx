'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { type HaltRead, HALT_REASON } from '@/lib/halts';
import type { RulesRead } from '@/lib/holder-rules';
import { type SeriesRead, countText, scheduleText } from '@/lib/series';
import { loadHalt, loadSeries, loadSeriesList } from '@/lib/series-load';
import type { CrossDetail } from '@/lib/types';
import { shortAddress } from '@/lib/units';

/**
 * Two facts about a cross that change what a person expects of it, shown above the tabs so they are not missed:
 * it is one of a recurring series (a series is the creator of the crosses it spawns), and it honours a halt, which is up now.
 * The list of series is asked first so that a cross made by a person never provokes a 404 for a series that does not exist.
 */
export function SeriesHaltNote({ cross, rules }: { cross: CrossDetail; rules: RulesRead | null | undefined }) {
  const [series, setSeries] = useState<SeriesRead | null>(null);
  const [halt, setHalt] = useState<HaltRead | null>(null);
  useEffect(() => {
    let live = true;
    void loadSeriesList().then(async (l) => {
      if (!live || !l.ok || !l.data.series.some((s) => s.address === cross.creator)) return;
      const one = await loadSeries(cross.creator);
      if (live && one.ok) setSeries(one.data);
    });
    return () => {
      live = false;
    };
  }, [cross.creator]);
  const honours = rules?.rules?.guards.haltSource ? true : false;
  useEffect(() => {
    if (!honours || !cross.baseMint) {
      setHalt(null);
      return;
    }
    let live = true;
    void loadHalt(cross.baseMint).then((h) => live && setHalt(h.ok ? h.data : null));
    return () => {
      live = false;
    };
  }, [honours, cross.baseMint, cross.state]);

  const s = halt?.state;
  const stopped = s !== undefined && (s.halted || s.corporateAction);
  if (!series && !stopped) return null;
  const mine = series?.crosses.find((c) => c.cross_address === cross.address);
  return (
    <div className="mt-4 space-y-3" data-testid="series-halt-note">
      {stopped && cross.baseMint ? (
        <p role="status" className="rounded-[var(--radius-card)] border border-accent px-4 py-3 text-sm" data-testid="halt-banner">
          <span className="font-medium">{s!.halted ? `Trading in this token is halted: ${HALT_REASON[s!.reason]?.title.toLowerCase() ?? s!.reason}.` : 'A corporate action is flagged on this token.'}</span>{' '}
          {cross.state === 'Live' ? 'This cross honours the halt: while it lasts it will not print, and every order is refunded in full.' : cross.state === 'NoPrint' ? 'This cross did not print.' : 'This cross printed before the halt.'}{' '}
          <Link href={`/halts/${cross.baseMint}`} className="underline underline-offset-4">
            What lifts it
          </Link>
        </p>
      ) : null}
      {series ? (
        <p className="rounded-[var(--radius-card)] border border-border px-4 py-3 text-sm text-muted" data-testid="series-note">
          {mine ? `Cross ${String(mine.idx)} of the recurring series ` : 'A cross of the recurring series '}
          <Link href={`/series/${series.series}`} className="font-mono underline underline-offset-4">
            {shortAddress(series.series)}
          </Link>
          . {scheduleText(series)}; {countText(series)}. {series.active ? 'The series is running.' : 'The series is paused, so it spawns no further cross.'}
        </p>
      ) : null}
    </div>
  );
}
