import type { Metadata } from 'next';
import Link from 'next/link';
import { StateBadge } from '@/components/state-badge';
import { get } from '@/lib/api';
import { type ReplayListResponse, type ReplayListRow, isReplayListResponse, listTimings } from '@/lib/replay';
import { shortAddress } from '@/lib/units';

export const metadata: Metadata = {
  title: 'Launch replay',
  description: 'Every recent cross with its outcome and timings. Open one to replay its on-chain events in order.',
};

const RANGES = [7, 30, 90] as const;

const OUTCOME: Record<ReplayListRow['outcome'], string> = { printed: 'Printed one price', 'no print': 'No print, all refunded', live: 'Live' };

function Row({ r, nowSec }: { r: ReplayListRow; nowSec: number }) {
  const t = listTimings(r);
  const when = new Date(Number(r.window.openTs) * 1000).toISOString().replace('T', ' ').slice(0, 16);
  const phase = r.state === 'Live' ? (nowSec < Number(r.window.openTs) ? 'upcoming' : nowSec < Number(r.window.closeTs) ? 'open' : nowSec < Number(r.window.revealEndTs) ? 'reveal' : 'awaiting-settlement') : undefined;
  return (
    <li>
      <Link href={`/crosses/${r.address}#replay`} className="grid gap-2 py-4 transition-colors hover:bg-surface sm:grid-cols-[1fr_auto] sm:items-center sm:px-3" data-testid="replay-row">
        <span className="min-w-0">
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-sm">{shortAddress(r.address)}</span>
            <StateBadge state={r.state === 'Finalized' && r.outcome === 'no print' ? 'NoPrint' : r.state} phase={phase} />
          </span>
          <span className="mt-1 block text-sm">{OUTCOME[r.outcome]}</span>
          <span className="mt-1 block text-xs text-muted">
            {r.kind ?? 'cross'} · {r.disclosure} bids · opened {when} UTC · {r.orders.placed} {r.orders.placed === 1 ? 'order' : 'orders'} from {r.orders.wallets} {r.orders.wallets === 1 ? 'wallet' : 'wallets'}
            {r.orders.cancelled > 0 ? ` · ${r.orders.cancelled} cancelled` : ''}
          </span>
        </span>
        <dl className="grid grid-cols-[auto_auto] gap-x-3 gap-y-0.5 text-xs text-muted sm:text-right">
          <dt>First order</dt>
          <dd className="font-mono">{t.firstOrderAfterOpen ? `${t.firstOrderAfterOpen} after open` : 'none'}</dd>
          <dt>Cleared</dt>
          <dd className="font-mono">{t.clearedAfterClose ? `${t.clearedAfterClose} after close` : r.state === 'Live' ? 'not yet' : 'not recorded'}</dd>
          <dt>Finalized</dt>
          <dd className="font-mono">{t.finalizedAfterCleared ? `${t.finalizedAfterCleared} after clearing` : r.state === 'Finalized' ? 'not recorded' : 'not yet'}</dd>
          <dt>Events</dt>
          <dd className="font-mono">{r.events}</dd>
        </dl>
      </Link>
    </li>
  );
}

export default async function ReplayIndex({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const raw = (await searchParams).days;
  const asked = Number(Array.isArray(raw) ? raw[0] : raw);
  const days = (RANGES as readonly number[]).includes(asked) ? asked : 30;
  const nowSec = Math.floor(Date.now() / 1000);
  const res = await get<ReplayListResponse>(`/v1/replay?days=${days}&limit=200`, 15);
  const ok = res.ok && isReplayListResponse(res.data);
  return (
    <div className="mx-auto max-w-[1200px] px-4 py-14 sm:px-6">
      <h1 className="text-[34px] font-semibold tracking-tight sm:text-[44px]">Launch replay</h1>
      <p className="mt-2 max-w-xl text-muted">
        Every cross that opened in the last {days} days, with how it ended and how long each step took. Open one to replay its on-chain events in order, or see all of them on the{' '}
        <Link href="/crosses" className="underline underline-offset-4 hover:text-ink">crosses page</Link>.
      </p>
      <nav aria-label="Time range" className="mt-6 flex flex-wrap gap-2">
        {RANGES.map((d) => (
          <Link
            key={d}
            href={`/replay?days=${d}`}
            aria-current={d === days ? 'page' : undefined}
            className={`inline-flex min-h-10 items-center rounded-full border px-4 text-sm ${d === days ? 'border-ink bg-ink text-bg' : 'border-border-strong text-ink hover:bg-surface'}`}
          >
            Last {d} days
          </Link>
        ))}
      </nav>
      {!res.ok ? (
        <p role="status" className="mt-10 text-sm text-muted">
          The replay list is unavailable right now: {res.error}
        </p>
      ) : !ok ? (
        <p role="status" className="mt-10 text-sm text-muted">The API answered with a shape this page does not recognise.</p>
      ) : res.data.crosses.length === 0 ? (
        <p className="mt-10 text-sm text-muted">No cross opened in the last {days} days.</p>
      ) : (
        <>
          <p role="status" className="mt-6 text-sm text-muted">
            {res.data.count} {res.data.count === 1 ? 'cross' : 'crosses'} on {res.data.network}, newest first. Times are block times in UTC.
          </p>
          <ul className="mt-2 divide-y divide-border border-y border-border">
            {res.data.crosses.map((r) => (
              <Row key={r.address} r={r} nowSec={nowSec} />
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
