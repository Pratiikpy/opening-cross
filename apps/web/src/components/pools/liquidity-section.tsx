'use client';

import Link from 'next/link';
import { Failed, Loading, Plain } from '@/components/w4/ui';
import { useRead } from '@/lib/use-read';
import { PoolTable } from './pools-index';
import type { PoolsSummaryResponse } from './types';

/**
 * The pools behind the dashboard's liquidity card, one row each. Like the rest of the dashboard it computes nothing: it shows the answer of
 * GET /v1/pools/summary and names it. A deployment without the route says so.
 */
export function PoolsInDetail() {
  const read = useRead<PoolsSummaryResponse>('/v1/pools/summary');
  return (
    <section aria-labelledby="pools-detail-h" className="mt-6 space-y-3" data-testid="dashboard-pools">
      <h2 id="pools-detail-h" className="text-lg font-semibold tracking-tight">
        Pools in detail
      </h2>
      <p className="max-w-2xl text-sm text-muted">
        The pools of the latest cleared crosses, read from chain. Source: <code className="font-mono">/v1/pools/summary</code>. <Link href="/pools" className="underline underline-offset-4">Open the pool finder</Link>.
      </p>
      {read.phase === 'loading' ? <Loading what="the pools of the latest crosses" /> : null}
      {read.phase === 'error' ? <Failed testId="pools-detail-error">{read.status === 404 ? 'This deployment does not serve the pool routes.' : `The pools could not be read: ${read.error}`}</Failed> : null}
      {read.phase === 'ok' && read.data.pools.length === 0 ? <Plain testId="pools-detail-none">None of the {read.data.pairsScanned} latest cleared crosses has a pool at the addresses Opening Cross opens them at.</Plain> : null}
      {read.phase === 'ok' && read.data.pools.length > 0 ? <PoolTable pools={read.data.pools} testId="dashboard-pool-table" /> : null}
    </section>
  );
}
