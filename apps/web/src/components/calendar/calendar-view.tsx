'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { StateBadge } from '@/components/state-badge';
import type { CrossSummary } from '@/lib/api';
import { buildCalendar, formatWindow } from '@/lib/calendar';
import { livePhase, outcomeOf } from '@/lib/cross-list';
import { crossIcs } from '@/lib/ics';
import { shortAddress } from '@/lib/units';

function download(c: CrossSummary) {
  const text = crossIcs({ address: c.address, openTs: Number(c.open_ts), closeTs: Number(c.close_ts), url: `${window.location.origin}/crosses/${c.address}` });
  const url = URL.createObjectURL(new Blob([text], { type: 'text/calendar;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `opening-cross-${c.address.slice(0, 8)}.ics`;
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function CalendarView({ crosses, nowSec }: { crosses: CrossSummary[]; nowSec: number }) {
  const [now, setNow] = useState(nowSec);
  // The server cannot know the viewer's zone: it renders UTC, and the browser switches to its own zone once mounted.
  const [zone, setZone] = useState('UTC');
  useEffect(() => {
    setZone(Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
    setNow(Math.floor(Date.now() / 1000));
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 15_000);
    return () => clearInterval(t);
  }, []);
  const sections = useMemo(() => buildCalendar(crosses, now, zone), [crosses, now, zone]);
  const local = zone !== 'UTC';

  return (
    <div className="mt-8">
      <p className="text-sm text-muted">
        Times are shown in <span className="font-medium text-ink">{local ? zone.replace(/_/g, ' ') : 'UTC'}</span>
        {local ? ', your time zone, with UTC beside each window.' : '.'} Days start at midnight in that zone.
      </p>
      <div className="mt-8 space-y-12">
        {sections.map((s) => (
          <section key={s.id} aria-labelledby={`cal-${s.id}`}>
            <h2 id={`cal-${s.id}`} className="flex items-baseline gap-3 text-xl font-semibold">
              {s.title}
              <span className="font-mono text-sm font-normal text-muted">{s.count}</span>
            </h2>
            {s.groups.length === 0 ? (
              <p className="mt-3 text-sm text-muted">{s.empty}</p>
            ) : (
              <div className="mt-4 space-y-6">
                {s.groups.map((g) => (
                  <div key={g.key}>
                    <h3 className="text-sm font-medium text-muted">{g.label}</h3>
                    <ul className="mt-2 divide-y divide-border border-y border-border">
                      {g.items.map((c) => {
                        const o = Number(c.open_ts);
                        const cl = Number(c.close_ts);
                        const outcome = outcomeOf(c);
                        const addable = s.id !== 'closed';
                        return (
                          <li key={c.address} className="grid gap-3 py-3 sm:grid-cols-[1fr_auto] sm:items-center sm:px-3">
                            <Link href={`/crosses/${c.address}`} className="min-w-0 rounded-md hover:underline hover:underline-offset-4">
                              <span className="block font-mono text-sm">{shortAddress(c.address)}</span>
                              <span className="block text-sm">{formatWindow(o, cl, zone)}</span>
                              {local ? <span className="block text-xs text-muted">{formatWindow(o, cl, 'UTC')}</span> : null}
                            </Link>
                            <div className="flex flex-wrap items-center gap-2">
                              <StateBadge state={outcome === 'noprint' ? 'NoPrint' : c.state} phase={livePhase(c, BigInt(now))} />
                              {addable ? (
                                <button
                                  type="button"
                                  onClick={() => download(c)}
                                  aria-label={`Add cross ${shortAddress(c.address)} to calendar (downloads an .ics file)`}
                                  className="min-h-10 rounded-full border border-border-strong px-4 text-sm hover:bg-surface"
                                >
                                  Add to calendar
                                </button>
                              ) : null}
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                ))}
              </div>
            )}
          </section>
        ))}
      </div>
    </div>
  );
}
