'use client';

import { useEffect, useState } from 'react';
import { API_URL } from '@/lib/api';
import type { BookResponse, CrossDetail } from '@/lib/types';
import type { Market } from '@/lib/units';
import type { OrderRecord } from './order-record';
import { type Phase, type SettleTimes, formatUtc, stagesOf, workedExample } from './timeline';

/** The moments the cross cleared and finalized, read from the event log once it has settled. */
function useSettleTimes(address: string, state: CrossDetail['state']): SettleTimes | undefined {
  const [t, setT] = useState<SettleTimes | undefined>(undefined);
  useEffect(() => {
    if (state === 'Live') return;
    let live = true;
    void fetch(`${API_URL}/v1/replay/${address}`, { cache: 'no-store' })
      .then((r) => (r.ok ? (r.json() as Promise<{ events: { kind: string; time: string | null }[] }>) : null))
      .then((j) => {
        if (!live || !j) return;
        const at = (kind: string) => {
          const e = j.events.find((x) => x.kind === kind && x.time);
          return e?.time ? BigInt(Math.floor(Date.parse(e.time) / 1000)) : null;
        };
        setT({ clearedAt: at('cleared'), finalizedAt: at('finalized') });
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [address, state]);
  return t;
}

/** The four stages of a cross with the real times from its window, the stage it is in, and a worked example of its price. */
export function TimelineView({ cross, book, orders, phase, market: m, coarse = false }: { cross: CrossDetail; book: BookResponse | null; orders: OrderRecord[] | null; phase: Phase; market: Market; coarse?: boolean }) {
  const times = useSettleTimes(cross.address, cross.state);
  const stages = stagesOf(cross, phase, times);
  const example = workedExample(cross, book, m, orders);
  return (
    <section aria-labelledby="timeline">
      <h2 id="timeline" className="font-mono text-xs uppercase tracking-widest text-muted">
        How this cross runs
      </h2>
      <ol className="mt-4 grid gap-0 sm:grid-cols-4 sm:gap-4" data-testid="timeline">
        {stages.map((s, i) => (
          <li key={s.key} aria-current={s.status === 'current' ? 'step' : undefined} className="relative flex gap-3 pb-6 sm:block sm:pb-0" data-stage={s.key} data-status={s.status}>
            {/* The rail: a dot per stage joined by a line, vertical on a phone and horizontal on a wide screen. */}
            <div className="flex flex-col items-center sm:mb-3 sm:flex-row" aria-hidden="true">
              <span
                className={`flex size-6 shrink-0 items-center justify-center rounded-full border-2 text-[11px] font-semibold ${
                  s.status === 'done' ? 'border-ink bg-ink text-bg' : s.status === 'current' ? 'border-accent-fill bg-accent-fill text-on-accent' : 'border-border-strong text-muted'
                }`}
              >
                {s.status === 'done' ? '✓' : i + 1}
              </span>
              {i < stages.length - 1 ? <span className={`mt-1 min-h-8 w-px flex-1 sm:ml-2 sm:mt-0 sm:h-px sm:min-h-0 sm:w-auto ${s.status === 'done' ? 'bg-ink' : 'bg-border-strong'}`} /> : null}
            </div>
            <div>
              <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                {s.label}
                {s.tag ? <span className="rounded-full bg-accent-fill px-2 py-0.5 text-[11px] font-medium text-on-accent">{s.tag}</span> : null}
              </p>
              <p className="mt-1 font-mono text-xs text-muted">{s.ts !== null ? <time dateTime={new Date(Number(s.ts) * 1000).toISOString()}>{formatUtc(s.ts)}</time> : s.status === 'upcoming' ? 'Not yet' : 'Time not published'}</p>
              <p className="mt-2 text-xs leading-relaxed text-muted">{s.note}</p>
            </div>
          </li>
        ))}
      </ol>
      <div className="mt-6 rounded-lg bg-surface p-4" data-testid="worked-example">
        <p className="font-mono text-xs uppercase tracking-widest text-muted">
          {example.kind === 'projection' ? (coarse ? 'Worked example, held back' : 'Worked example, if the call closed now') : example.kind === 'result' ? 'Worked example from this result' : 'What happened'}
        </p>
        <p className="mt-2 text-sm leading-relaxed">
          {coarse && example.kind === 'projection' ? 'The ending period is open, so the worked example with the exact price is held back until the call closes. The price above is shown to the nearest band.' : example.text}
        </p>
      </div>
    </section>
  );
}
