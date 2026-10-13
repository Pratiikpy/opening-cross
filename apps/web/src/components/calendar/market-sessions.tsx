'use client';

import { useState } from 'react';
import { dayLabel, formatWindow } from '@/lib/calendar';
import { type MarketCalendar, type MarketSession, countdown, explorerAddress, sessionIcs, shortKey, statusAt } from '@/lib/calendar-markets';
import { FollowButton } from '@/components/alerts/follow-button';
import { REMINDER_NOTE, ReminderToggle, useReminders } from './reminders';
import { useClock, useZone } from './use-clock';

function downloadSession(calendar: string, s: MarketSession) {
  const text = sessionIcs({ calendar, startTs: Number(s.startTs), endTs: Number(s.endTs), url: `${window.location.origin}/calendar` });
  const url = URL.createObjectURL(new Blob([text], { type: 'text/calendar;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `opening-cross-session-${calendar.slice(0, 8)}-${s.startTs}.ics`;
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** Open / closed, and halted while the protocol pause is on. The text carries the state; the dot is only a mark. */
export function MarketBadge({ state, halted }: { state: 'open' | 'closed'; halted: boolean }) {
  const open = state === 'open';
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs ${open ? 'border-accent text-accent-text' : 'border-border text-muted'}`}>
        {open ? <span className="size-1.5 rounded-full bg-accent" aria-hidden="true" /> : null}
        {open ? 'Session open' : 'Closed'}
      </span>
      {halted ? <span className="inline-flex rounded-full border border-ink px-2.5 py-1 text-xs text-ink">Halted: new orders paused</span> : null}
    </span>
  );
}

export function SessionTimes({ s, zone }: { s: MarketSession; zone: string }) {
  const local = zone !== 'UTC';
  return (
    <>
      <span className="block text-sm">
        {dayLabel(Number(s.startTs), zone)}, {formatWindow(Number(s.startTs), Number(s.endTs), zone)}
      </span>
      {local ? <span className="block text-xs text-muted">{formatWindow(Number(s.startTs), Number(s.endTs), 'UTC')}</span> : null}
    </>
  );
}

export function MarketSessions({ markets, network, serverNow }: { markets: MarketCalendar[]; network: string; serverNow: number }) {
  const now = useClock(serverNow);
  const zone = useZone();
  const { list, toggle } = useReminders();
  const [refused, setRefused] = useState(false);

  return (
    <div>
      <ul className="mt-4 divide-y divide-border border-y border-border" data-testid="market-list">
        {markets.map((m) => {
          const st = statusAt(m, now);
          const target = st.current ?? st.next;
          return (
            <li key={m.address} className="grid gap-3 py-4 sm:px-3" data-testid="market-row">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <a href={explorerAddress(m.address, network)} target="_blank" rel="noreferrer" className="font-mono text-sm underline decoration-border-strong underline-offset-4 hover:text-ink" aria-label={`Calendar ${m.address} on Solana Explorer`}>
                  Market calendar {shortKey(m.address)}
                </a>
                <MarketBadge state={st.state} halted={m.halted} />
              </div>
              {target ? (
                <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-center">
                  <div>
                    <p className="text-xs uppercase tracking-wider text-muted">{st.current ? 'Running session' : 'Next session'}</p>
                    <SessionTimes s={target} zone={zone} />
                    <p className="mt-1 text-sm">
                      {st.current ? 'Ends in ' : 'Opens in '}
                      <span className="font-mono tabular-nums" data-testid="market-countdown">{countdown(Number(st.current ? st.current.endTs : target.startTs) - now)}</span>
                    </p>
                  </div>
                  {st.next ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={() => downloadSession(m.address, st.next!)}
                        aria-label={`${st.current ? 'Add next open to calendar' : 'Add to calendar'}: calendar ${shortKey(m.address)}, session opening ${dayLabel(Number(st.next.startTs), zone)}. Downloads an .ics file.`}
                        className="min-h-10 rounded-full border border-border-strong px-4 text-sm hover:bg-surface"
                      >
                        {st.current ? 'Add next open to calendar' : 'Add to calendar'}
                      </button>
                      <ReminderToggle calendar={m.address} startTs={Number(st.next.startTs)} endTs={Number(st.next.endTs)} list={list} toggle={toggle} onRefused={() => setRefused(true)} context={`calendar ${shortKey(m.address)}, session opening ${dayLabel(Number(st.next.startTs), zone)}`} />
                      <FollowButton kind="markets" address={m.address} label={`market ${shortKey(m.address)}`} />
                    </div>
                  ) : null}
                </div>
              ) : (
                <p className="text-sm text-muted" data-testid="market-no-session">This calendar lists no session that has not ended. Nothing is scheduled on it.</p>
              )}
              <p className="text-xs text-muted">
                {m.upcomingSessions} session{m.upcomingSessions === 1 ? '' : 's'} ahead of {m.sessionCount} listed
                {m.crosses.length ? `, ${m.crosses.length} cross${m.crosses.length === 1 ? '' : 'es'} scheduled on it` : ''}
                {m.pendingUpdate ? `. A change to this schedule is waiting out its timelock and cannot apply for another ${countdown(Number(m.pendingUpdate.eta) - now)}.` : '.'}
              </p>
            </li>
          );
        })}
      </ul>
      <p className="mt-3 text-xs text-muted">{REMINDER_NOTE}</p>
      {refused ? (
        <p role="alert" className="mt-2 text-sm text-ink">
          This browser would not save the reminder (private mode or blocked site data). The .ics download still works.
        </p>
      ) : null}
    </div>
  );
}
