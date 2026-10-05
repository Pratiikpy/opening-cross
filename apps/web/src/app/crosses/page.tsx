import Link from 'next/link';
import type { Metadata } from 'next';
import { StateBadge } from '@/components/state-badge';
import { type CrossSummary, get } from '@/lib/api';
import { shortAddress } from '@/lib/units';

export const metadata: Metadata = { title: 'Crosses' };
export const revalidate = 10;

export default async function Crosses() {
  const res = await get<{ crosses: CrossSummary[] }>('/v1/crosses?limit=100', 10);
  const now = BigInt(Math.floor(Date.now() / 1000));
  return (
    <div className="mx-auto max-w-[1200px] px-4 py-14 sm:px-6">
      <h1 className="text-[34px] font-semibold tracking-tight sm:text-[44px]">Crosses</h1>
      <p className="mt-2 max-w-xl text-muted">Every cross the indexer has seen, newest first. Open one to place an order, follow the book or check its result.</p>
      {!res.ok ? (
        <p role="status" className="mt-10 text-sm text-muted">
          The list is unavailable right now: {res.error}
        </p>
      ) : res.data.crosses.length === 0 ? (
        <p className="mt-10 text-sm text-muted">No crosses yet.</p>
      ) : (
        <ul className="mt-10 divide-y divide-border border-y border-border">
          {res.data.crosses.map((c) => {
            const open = c.state === 'Live' && BigInt(c.open_ts) <= now && now < BigInt(c.close_ts);
            return (
              <li key={c.address}>
                <Link href={`/crosses/${c.address}`} className="grid gap-2 py-4 transition-colors hover:bg-surface sm:grid-cols-[1fr_auto_auto] sm:items-center sm:px-3">
                  <span>
                    <span className="block font-mono text-sm">{shortAddress(c.address)}</span>
                    <span className="block text-xs text-muted">
                      base {shortAddress(c.base_mint)} · quote {shortAddress(c.quote_mint)} · {c.orders_committed} orders
                    </span>
                  </span>
                  <span className="text-sm text-muted">closes {new Date(Number(c.close_ts) * 1000).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' })} UTC</span>
                  <StateBadge state={c.state} open={open} />
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
