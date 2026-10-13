'use client';

import Link from 'next/link';
import { useCallback, useSyncExternalStore } from 'react';
import { REMINDER_KEY, type Reminder, countdown, dueReminders, hasReminder, parseReminders, shortKey, toggleReminder, writeReminders } from '@/lib/calendar-markets';
import { useClock } from './use-clock';

// Reminders live in this browser's localStorage and nowhere else: nothing is sent to us and nothing can reach the visitor
// when no Opening Bell page is open. A page open on /calendar or /live shows them as they come due.

const listeners = new Set<() => void>();

function subscribe(cb: () => void) {
  listeners.add(cb);
  const onStorage = (e: StorageEvent) => {
    if (e.key === REMINDER_KEY || e.key === null) cb();
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(cb);
    window.removeEventListener('storage', onStorage);
  };
}
function snapshot(): string {
  try {
    return window.localStorage.getItem(REMINDER_KEY) ?? '';
  } catch {
    return '';
  }
}

/** The stored reminders (empty on the server and before mount), a toggle, and whether this browser lets us save them. */
export function useReminders() {
  const raw = useSyncExternalStore(subscribe, snapshot, () => '');
  const list = parseReminders(raw);
  const toggle = useCallback((r: Reminder): boolean => {
    let store: Storage | null = null;
    try {
      store = window.localStorage;
    } catch {
      return false;
    }
    const next = toggleReminder(parseReminders(snapshot()), r);
    const saved = writeReminders(store, next, Math.floor(Date.now() / 1000));
    if (saved) for (const l of listeners) l();
    return saved;
  }, []);
  return { list, toggle };
}

/** The button on a session: puts it on, or takes it off, this browser's reminder list. */
export function ReminderToggle({ calendar, startTs, endTs, toggle, list, onRefused, context }: { calendar: string; startTs: number; endTs: number; toggle: (r: Reminder) => boolean; list: readonly Reminder[]; onRefused: () => void; context: string }) {
  const on = hasReminder(list, calendar, startTs);
  return (
    <button
      type="button"
      aria-pressed={on}
      aria-label={`Notify me: ${context}`}
      onClick={() => {
        if (!toggle({ calendar, startTs, endTs })) onRefused();
      }}
      className={`min-h-10 rounded-full border px-4 text-sm ${on ? 'border-accent bg-surface text-ink' : 'border-border-strong hover:bg-surface'}`}
    >
      {on ? <span aria-hidden="true">✓ </span> : null}Notify me
    </button>
  );
}

/** Reminders that have come due: from ten minutes before a session opens until it ends. Renders nothing when none has. */
export function ReminderBanner({ serverNow }: { serverNow: number }) {
  const now = useClock(serverNow);
  const { list, toggle } = useReminders();
  const due = dueReminders(list, now);
  if (due.length === 0) return null;
  return (
    <section aria-label="Your reminders" className="mt-6 space-y-2" data-testid="reminder-banner">
      {due.map((r) => {
        const open = now >= r.startTs;
        return (
          <div key={`${r.calendar}:${r.startTs}`} role="status" className="flex flex-wrap items-center justify-between gap-3 rounded-card border border-accent bg-surface px-4 py-3 text-sm">
            <p>
              <span className="font-medium">Market {shortKey(r.calendar)}</span>{' '}
              {open ? <>is open now, for another <span className="font-mono tabular-nums">{countdown(r.endTs - now)}</span>.</> : <>opens in <span className="font-mono tabular-nums">{countdown(r.startTs - now)}</span>.</>}{' '}
              <Link href="/live" className="underline underline-offset-4 hover:text-ink">Open the live board</Link>
            </p>
            <button type="button" onClick={() => toggle(r)} className="min-h-10 rounded-full border border-border-strong px-4 hover:bg-bg">
              Dismiss
            </button>
          </div>
        );
      })}
    </section>
  );
}

export const REMINDER_NOTE = 'Reminders are saved in this browser only. They appear on the Calendar and Live pages while one of them is open. We send no email and no push notification.';
