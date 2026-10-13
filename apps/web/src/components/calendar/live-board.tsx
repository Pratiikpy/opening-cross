'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { API_URL } from '@/lib/api';
import { dayLabel } from '@/lib/calendar';
import { type LiveEvent, type MarketCalendar, type MarketsResponse, countdown, explorerAddress, liveEvents, shortKey, statusAt } from '@/lib/calendar-markets';
import { MarketBadge, SessionTimes } from './market-sessions';
import { REMINDER_NOTE, ReminderBanner } from './reminders';
import { useClock, useZone } from './use-clock';

const REFRESH_MS = 15_000;

type Props = { initial: MarketsResponse | null; error: string | null; serverNow: number };

function clockTime(unix: number, zone: string) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(unix * 1000));
}

export function LiveBoard({ initial, error, serverNow }: Props) {
  const now = useClock(serverNow);
  const zone = useZone();
  const [data, setData] = useState<MarketsResponse | null>(initial);
  const [fetchedAt, setFetchedAt] = useState<number | null>(initial ? Number(initial.asOf) : null);
  const [stale, setStale] = useState<string | null>(error);
  const inflight = useRef(false);

  const refresh = useCallback(async () => {
    if (inflight.current) return;
    inflight.current = true;
    try {
      const res = await fetch(`${API_URL}/v1/calendar`, { cache: 'no-store' });
      const body = (await res.json()) as MarketsResponse & { error?: string };
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      setData(body);
      setFetchedAt(Math.floor(Date.now() / 1000));
      setStale(null);
    } catch (e) {
      setStale(e instanceof Error && e.message ? e.message : 'The Opening Cross API could not be reached.');
    } finally {
      inflight.current = false;
    }
  }, []);

  useEffect(() => {
    const t = setInterval(refresh, REFRESH_MS);
    // A tab that was in the background has missed ticks: look again when it comes back.
    const onVisible = () => document.visibilityState === 'visible' && refresh();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refresh]);

  const markets = data?.calendars ?? [];
  const byAddress = new Map(markets.map((m) => [m.address, m]));
  const events = liveEvents(markets, now);
  const running = events.filter((e) => e.kind === 'session-running');
  const upcoming = events.filter((e) => e.kind !== 'session-running');
  const next = upcoming.find((e) => !(e.kind === 'cross-clears' && e.due)) ?? null;
  const network = data?.network ?? 'devnet';

  return (
    <div className="mt-8">
      <ReminderBanner serverNow={serverNow} />

      {stale ? (
        <p role="status" className="mt-4 text-sm text-ink" data-testid="live-stale">
          {data ? `The last refresh failed (${stale}). Showing what the API said at ${clockTime(fetchedAt ?? now, zone)}${zone === 'UTC' ? ' UTC' : ''}.` : `The live board is unavailable right now: ${stale}`}
        </p>
      ) : null}

      {data && events.length === 0 ? (
        <section className="mt-8 rounded-card border border-border bg-surface p-6" data-testid="live-empty" aria-labelledby="live-empty-title">
          <h2 id="live-empty-title" className="text-xl font-semibold">No market has a session scheduled</h2>
          <p className="mt-2 max-w-xl text-sm text-muted">
            {markets.length === 0
              ? 'No market calendar is indexed on this network yet, so there is nothing to count down to.'
              : `${markets.length} market calendar${markets.length === 1 ? ' is' : 's are'} indexed, and none lists a session that has not ended or a cross still waiting to clear.`}{' '}
            Calendars publish their sessions on chain, and a change to a calendar waits out a seven-day timelock before it can apply, so a new session shows here as soon as it is on a calendar.
          </p>
          <p className="mt-4 flex flex-wrap gap-3 text-sm">
            <Link href="/calendar" className="underline underline-offset-4 hover:text-ink">Calendar</Link>
            <Link href="/crosses" className="underline underline-offset-4 hover:text-ink">Every cross</Link>
          </p>
        </section>
      ) : null}

      {running.length > 0 ? (
        <section className="mt-8" aria-labelledby="live-now">
          <h2 id="live-now" className="text-xl font-semibold">Open now</h2>
          <ul className="mt-4 grid gap-4 sm:grid-cols-2" data-testid="live-running">
            {running.map((e) => {
              const m = byAddress.get(e.calendar)!;
              return (
                <li key={e.key} className="rounded-card border border-accent p-5">
                  <MarketBadge state="open" halted={m.halted} />
                  <p className="mt-3 text-sm text-muted">Market calendar {shortKey(m.address)} is trading. The session ends in</p>
                  <p className="mt-1 font-mono text-[34px] font-semibold leading-none tabular-nums" data-testid="live-running-countdown">{countdown(e.at - now)}</p>
                  <p className="mt-3"><SessionTimes s={statusAt(m, now).current!} zone={zone} /></p>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      {next ? (
        <section className="mt-8" aria-labelledby="live-next">
          <h2 id="live-next" className="text-xl font-semibold">Next</h2>
          <div className="mt-4 rounded-card border border-border-strong p-5 sm:p-6" data-testid="live-next">
            <p className="text-sm text-muted">{describe(next, byAddress, 'lead')}</p>
            <p className="mt-2 font-mono text-[44px] font-semibold leading-none tracking-tight tabular-nums sm:text-[56px]" data-testid="live-next-countdown">{countdown(next.at - now)}</p>
            <p className="mt-3 text-sm">{when(next, zone)}</p>
            {zone !== 'UTC' ? <p className="text-xs text-muted">{when(next, 'UTC')}</p> : null}
          </div>
        </section>
      ) : null}

      {upcoming.length > 0 ? (
        <section className="mt-10" aria-labelledby="live-upcoming">
          <h2 id="live-upcoming" className="text-xl font-semibold">
            Coming up <span className="font-mono text-sm font-normal text-muted">{upcoming.length}</span>
          </h2>
          <ul className="mt-4 divide-y divide-border border-y border-border" data-testid="live-upcoming">
            {upcoming.map((e) => (
              <li key={e.key} className="grid gap-1 py-3 sm:grid-cols-[1fr_auto] sm:items-center sm:gap-4 sm:px-3" data-testid="live-event">
                <div className="min-w-0">
                  <p className="text-sm">{describe(e, byAddress, 'row')}</p>
                  <p className="text-xs text-muted">
                    {when(e, zone)}
                    {e.kind === 'cross-clears' ? (
                      <>
                        {' · '}
                        <Link href={`/crosses/${e.cross}`} className="underline underline-offset-4 hover:text-ink">View cross</Link>
                      </>
                    ) : null}
                  </p>
                </div>
                <p className="font-mono text-sm tabular-nums sm:text-right">
                  {e.kind === 'cross-clears' && e.due ? <span className="text-ink">Clearing due</span> : <>in {countdown(e.at - now)}</>}
                </p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {data ? (
        <p className="mt-8 text-xs text-muted">
          {markets.length > 0 ? (
            <>
              {markets.length} market calendar{markets.length === 1 ? '' : 's'} on {network}, each read from the chain by the API when this page last refreshed ({clockTime(fetchedAt ?? now, zone)}
              {zone === 'UTC' ? ' UTC' : ''}).{' '}
            </>
          ) : null}
          It refreshes every {REFRESH_MS / 1000} seconds; the countdowns use your device clock.{' '}
          {markets.length > 0 ? (
            <>
              Calendars:{' '}
              {markets.map((m, i) => (
                <span key={m.address}>
                  {i > 0 ? ', ' : ''}
                  <a href={explorerAddress(m.address, network)} target="_blank" rel="noreferrer" className="font-mono underline underline-offset-2 hover:text-ink">{shortKey(m.address)}</a>
                </span>
              ))}
              .{' '}
            </>
          ) : null}
          {REMINDER_NOTE}
        </p>
      ) : null}
    </div>
  );
}

function when(e: LiveEvent, zone: string): string {
  if (e.kind === 'cross-clears') return `${dayLabel(e.at, zone)}, ${clockTime(e.at, zone)}${zone === 'UTC' ? ' UTC' : ''}`;
  return `${dayLabel(e.at, zone)}, ${clockTime(e.at, zone)} to ${clockTime(e.endTs, zone)}${zone === 'UTC' ? ' UTC' : ''}`;
}

function describe(e: LiveEvent, markets: Map<string, MarketCalendar>, mode: 'lead' | 'row'): string {
  const m = `market calendar ${shortKey(e.calendar)}`;
  const halted = markets.get(e.calendar)?.halted ? ' (new orders are paused protocol-wide)' : '';
  switch (e.kind) {
    case 'session-open':
      return mode === 'lead' ? `A session opens on ${m}${halted}` : `Session opens on ${m}${halted}`;
    case 'session-running':
      return `Session on ${m} ends`;
    case 'cross-clears':
      return mode === 'lead'
        ? `Cross ${shortKey(e.cross)}, scheduled on ${m}, clears at its session start`
        : `Cross ${shortKey(e.cross)} clears${e.sessionStartTs ? ' at the session start' : ''}${e.due ? ': its time has passed and it has not been cleared yet' : ''} (${m})`;
  }
}
