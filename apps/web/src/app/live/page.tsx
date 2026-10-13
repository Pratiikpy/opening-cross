import type { Metadata } from 'next';
import Link from 'next/link';
import { LiveBoard } from '@/components/calendar/live-board';
import { get } from '@/lib/api';
import type { MarketsResponse } from '@/lib/calendar-markets';

export const metadata: Metadata = {
  title: 'Live',
  description: 'The sessions and crosses driven by on-chain market calendars: what is open now, what opens next, and a countdown to each.',
};
export const revalidate = 5;

export default async function Live() {
  const res = await get<MarketsResponse>('/v1/calendar', 5);
  return (
    <div className="mx-auto max-w-[900px] px-4 py-14 sm:px-6">
      <h1 className="text-[34px] font-semibold tracking-tight sm:text-[44px]">Live</h1>
      <p className="mt-2 max-w-xl text-muted">
        Opening Bell events that follow a market calendar: a session opening, a session ending, and a cross clearing at the moment a session starts. Every time comes from a calendar account on chain. For the full schedule and reminders, see the{' '}
        <Link href="/calendar" className="underline underline-offset-4 hover:text-ink">calendar</Link>.
      </p>
      <LiveBoard initial={res.ok ? res.data : null} error={res.ok ? null : res.error} serverNow={Math.floor(Date.now() / 1000)} />
    </div>
  );
}
