import type { Metadata } from 'next';
import Link from 'next/link';
import { CalendarView } from '@/components/calendar/calendar-view';
import { MarketSessions } from '@/components/calendar/market-sessions';
import { ReminderBanner } from '@/components/calendar/reminders';
import { type CrossSummary, get } from '@/lib/api';
import type { MarketsResponse } from '@/lib/calendar-markets';

export const metadata: Metadata = {
  title: 'Calendar',
  description: 'Market sessions published on chain, and every opening cross laid out by its real window, with an .ics file and an in-browser reminder for each upcoming one.',
};
export const revalidate = 10;

export default async function Calendar() {
  const [res, markets] = await Promise.all([get<{ crosses: CrossSummary[] }>('/v1/crosses?limit=200', 10), get<MarketsResponse>('/v1/calendar', 10)]);
  const serverNow = Math.floor(Date.now() / 1000);
  return (
    <div className="mx-auto max-w-[900px] px-4 py-14 sm:px-6">
      <h1 className="text-[34px] font-semibold tracking-tight sm:text-[44px]">Calendar</h1>
      <p className="mt-2 max-w-xl text-muted">
        Market sessions as the on-chain calendars publish them, and each cross by the window it takes orders in. Add one to your own calendar app and it is a normal event: nothing is sent to us and no account is needed. For filters and search, use the{' '}
        <Link href="/crosses" className="underline underline-offset-4 hover:text-ink">crosses list</Link>; for a countdown to what is next, the{' '}
        <Link href="/live" className="underline underline-offset-4 hover:text-ink">live board</Link>.
      </p>
      <ReminderBanner serverNow={serverNow} />

      <section className="mt-10" aria-labelledby="market-sessions">
        <h2 id="market-sessions" className="text-xl font-semibold">
          Market sessions {markets.ok ? <span className="font-mono text-sm font-normal text-muted">{markets.data.calendars.length}</span> : null}
        </h2>
        {!markets.ok ? (
          <p role="status" className="mt-3 text-sm text-muted">
            Market calendars are unavailable right now: {markets.error}
          </p>
        ) : markets.data.calendars.length === 0 ? (
          <p className="mt-3 text-sm text-muted" data-testid="market-empty">
            No market calendar is indexed on {markets.data.network} yet, so no session is scheduled.
          </p>
        ) : (
          <MarketSessions markets={markets.data.calendars} network={markets.data.network} serverNow={serverNow} />
        )}
      </section>

      <h2 className="mt-14 text-xl font-semibold">Cross windows</h2>
      {!res.ok ? (
        <p role="status" className="mt-10 text-sm text-muted">
          The calendar is unavailable right now: {res.error}
        </p>
      ) : (
        <CalendarView crosses={res.data.crosses} nowSec={serverNow} />
      )}
    </div>
  );
}
