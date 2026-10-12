import type { Metadata } from 'next';
import { API_URL } from '@/lib/api';
import { RPC_URL } from '@/lib/config';

export const metadata: Metadata = { title: 'Status' };
export const dynamic = 'force-dynamic';

/** A healthy indexer polls every few seconds; a public RPC that is rate limiting can stretch a poll, so allow two minutes. */
const STALE_AFTER_SECONDS = 120;

type Check = { name: string; ok: boolean; detail: string };

async function timed<T>(f: () => Promise<T>): Promise<[T | null, number, string | null]> {
  const t = Date.now();
  try {
    return [await f(), Date.now() - t, null];
  } catch (e) {
    return [null, Date.now() - t, e instanceof Error ? e.message : String(e)];
  }
}

export default async function Status() {
  const [health, apiMs, apiErr] = await timed(async () => {
    const r = await fetch(`${API_URL}/v1/health`, { cache: 'no-store' });
    return (await r.json()) as { ok: boolean; indexedSlot: string | null; recentDriftAlerts: number; indexer?: { caughtUpToSlot: string; secondsSinceLastCaughtUp: number } | null };
  });
  const [slot, rpcMs, rpcErr] = await timed(async () => {
    const r = await fetch(RPC_URL, { method: 'POST', cache: 'no-store', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getSlot', params: [{ commitment: 'finalized' }] }) });
    return ((await r.json()) as { result: number }).result;
  });
  const checks: Check[] = [
    { name: 'API', ok: Boolean(health), detail: health ? `Responding in ${apiMs} ms.` : `Unreachable: ${apiErr}` },
    { name: 'Network RPC', ok: slot !== null, detail: slot !== null ? `Finalized slot ${slot}, ${rpcMs} ms.` : `Unreachable: ${rpcErr}` },
    {
      name: 'Indexed data',
      // The indexer writes a heartbeat after every poll that finished; a stale or missing one means it is behind, stuck or stopped.
      ok: Boolean(health?.indexer) && (health?.indexer?.secondsSinceLastCaughtUp ?? Infinity) <= STALE_AFTER_SECONDS,
      detail: !health
        ? 'Unknown while the API is unreachable.'
        : !health.indexer
          ? 'The indexer has not reported yet: it is starting, still catching up on history, or not running.'
          : health.indexer.secondsSinceLastCaughtUp <= STALE_AFTER_SECONDS
            ? `The indexer caught up to finalized slot ${health.indexer.caughtUpToSlot} ${health.indexer.secondsSinceLastCaughtUp} s ago.`
            : `The indexer last caught up ${Math.round(health.indexer.secondsSinceLastCaughtUp / 60)} min ago (to slot ${health.indexer.caughtUpToSlot}); figures on this site may be behind the chain.`,
    },
    {
      name: 'Reconciliation',
      ok: health?.recentDriftAlerts === 0,
      detail: health ? `${health.recentDriftAlerts} drift alerts in the last hour (indexed state compared with the chain).` : 'Unknown while the API is unreachable.',
    },
  ];
  const all = checks.every((c) => c.ok);
  return (
    <div className="mx-auto max-w-[800px] px-4 py-12 sm:px-6">
      <h1 className="text-[34px] font-semibold tracking-tight">Status</h1>
      <p role="status" className={`mt-3 inline-flex items-center gap-2 rounded-full border px-3 py-1 text-sm ${all ? 'border-positive text-positive' : 'border-accent text-accent-text'}`}>
        <span className={`size-2 rounded-full ${all ? 'bg-positive' : 'bg-accent'}`} aria-hidden="true" />
        {all ? 'All systems normal' : 'Degraded: see below'}
      </p>
      <p className="mt-2 text-xs text-muted">Checked live when this page loaded ({new Date().toISOString().replace('T', ' ').slice(0, 19)} UTC). Reload to check again.</p>
      <ul className="mt-8 divide-y divide-border border-y border-border">
        {checks.map((c) => (
          <li key={c.name} className="flex items-start justify-between gap-4 py-4">
            <div>
              <p className="font-medium">{c.name}</p>
              <p className="mt-0.5 text-sm text-muted">{c.detail}</p>
            </div>
            <span className={`font-mono text-xs ${c.ok ? 'text-positive' : 'text-accent-text'}`}>{c.ok ? 'OK' : 'ISSUE'}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
