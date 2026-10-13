import type { Metadata } from 'next';
import Link from 'next/link';
import { CrossesBrowser } from '@/components/crosses-list/crosses-browser';
import { type CrossSummary, get } from '@/lib/api';
import { parseFilters } from '@/lib/cross-list';

export const metadata: Metadata = { title: 'Crosses', description: 'Every Opening Cross the indexer has seen, filterable by state, bid disclosure and supply mode.' };

export default async function Crosses({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const initial = parseFilters(await searchParams);
  const res = await get<{ crosses: CrossSummary[] }>('/v1/crosses?limit=200', 10);
  return (
    <div className="mx-auto max-w-[1200px] px-4 py-14 sm:px-6">
      <h1 className="text-[34px] font-semibold tracking-tight sm:text-[44px]">Crosses</h1>
      <p className="mt-2 max-w-xl text-muted">
        Every cross the indexer has seen, newest first. Open one to place an order, follow the book or check its result, or{' '}
        <Link href="/calendar" className="underline underline-offset-4 hover:text-ink">see them on the calendar</Link>.
      </p>
      {!res.ok ? (
        <p role="status" className="mt-10 text-sm text-muted">
          The list is unavailable right now: {res.error}
        </p>
      ) : res.data.crosses.length === 0 ? (
        <p className="mt-10 text-sm text-muted">No crosses yet.</p>
      ) : (
        <CrossesBrowser crosses={res.data.crosses} initial={initial} nowSec={Math.floor(Date.now() / 1000)} />
      )}
    </div>
  );
}
