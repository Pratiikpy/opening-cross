import type { Metadata } from 'next';
import Link from 'next/link';
import { CalendarView } from '@/components/calendar/calendar-view';
import { type CrossSummary, get } from '@/lib/api';

export const metadata: Metadata = { title: 'Calendar', description: 'Every opening cross laid out by its real window: open now, opening soon and closed, with an .ics file for each upcoming one.' };
export const revalidate = 10;

export default async function Calendar() {
  const res = await get<{ crosses: CrossSummary[] }>('/v1/crosses?limit=200', 10);
  return (
    <div className="mx-auto max-w-[900px] px-4 py-14 sm:px-6">
      <h1 className="text-[34px] font-semibold tracking-tight sm:text-[44px]">Calendar</h1>
      <p className="mt-2 max-w-xl text-muted">
        Each cross by the window it takes orders in. Add one to your own calendar app and it is a normal event: nothing is sent to us and no account is needed. For filters and search, use the{' '}
        <Link href="/crosses" className="underline underline-offset-4 hover:text-ink">crosses list</Link>.
      </p>
      {!res.ok ? (
        <p role="status" className="mt-10 text-sm text-muted">
          The calendar is unavailable right now: {res.error}
        </p>
      ) : (
        <CalendarView crosses={res.data.crosses} nowSec={Math.floor(Date.now() / 1000)} />
      )}
    </div>
  );
}
