'use client';

import { useCallback, useEffect, useState } from 'react';
import { type ChainCheck, type LogEntry, OpsApiError, type SignedHead, allows, linkedWithinPage, olderThan, shorten, when } from './ops-client';
import { Badge, Json, Notice, type PanelProps, PRIMARY, SECONDARY, useAction } from './ui';

const PAGE = 50;

export function LogPanel({ client, me, onSignedOut }: PanelProps) {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [more, setMore] = useState(false);

  const load = useCallback(
    async (before?: number) => {
      setLoading(true);
      setError(null);
      try {
        const page = await client.log({ ...(before !== undefined ? { before } : {}), limit: PAGE });
        setEntries((prev) => (before === undefined ? page : [...prev, ...page]));
        setMore(page.length === PAGE && olderThan(page) !== null);
      } catch (e) {
        if (e instanceof OpsApiError && e.signedOut) onSignedOut();
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    },
    [client, onSignedOut],
  );
  useEffect(() => {
    void load();
  }, [load]);

  const links = linkedWithinPage(entries);
  return (
    <div className="space-y-8">
      <p className="max-w-3xl text-sm text-muted">
        Every action in the console is one entry in this log, written in the same transaction as the change it records. Each entry carries the hash of the one before it, so an edited or removed entry breaks every hash after it. Verifying recomputes the whole chain on the server. The signed head is a copy of the chain&apos;s end that should be kept somewhere the operator cannot quietly change.
      </p>
      {allows(me.role, 'admin') ? <AdminTools client={client} onSignedOut={onSignedOut} /> : <Notice tone="info">Verifying the chain and signing its head are admin actions.</Notice>}

      <section aria-labelledby="log-h" className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <h2 id="log-h" className="text-lg font-semibold">Entries, newest first</h2>
          <button type="button" className={SECONDARY} onClick={() => void load()} disabled={loading}>Refresh</button>
        </div>
        {error ? <Notice tone="error">{error}</Notice> : null}
        {!error && !loading && entries.length === 0 ? <p className="rounded-lg border border-dashed border-border-strong px-4 py-6 text-center text-sm text-muted">The log is empty.</p> : null}
        {entries.length > 0 ? (
          <div className="overflow-x-auto rounded-xl border border-border">
            <table className="w-full min-w-[720px] text-left text-sm" data-testid="log-table">
              <caption className="sr-only">Audit log entries, newest first</caption>
              <thead className="bg-surface text-xs uppercase tracking-wider text-muted">
                <tr>
                  <th scope="col" className="px-3 py-2">#</th>
                  <th scope="col" className="px-3 py-2">When</th>
                  <th scope="col" className="px-3 py-2">Who</th>
                  <th scope="col" className="px-3 py-2">Action</th>
                  <th scope="col" className="px-3 py-2">Subject</th>
                  <th scope="col" className="px-3 py-2">Hash</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {entries.map((e, i) => (
                  <tr key={e.seq} data-testid={`log-${e.seq}`} className="align-top">
                    <td className="px-3 py-2 font-mono text-[13px]">{e.seq}</td>
                    <td className="whitespace-nowrap px-3 py-2">{when(e.at)}</td>
                    <td className="px-3 py-2">{e.actor}</td>
                    <td className="px-3 py-2">
                      <span className="font-mono text-[13px]">{e.action}</span>
                      {hasDetail(e.detail) ? <Json value={e.detail} label="detail" /> : null}
                    </td>
                    <td className="px-3 py-2 font-mono text-[13px]" title={e.subject}>{shorten(e.subject, 8, 6)}</td>
                    <td className="px-3 py-2 font-mono text-[13px]" title={`hash ${e.hash}\nprevious ${e.prevHash}`}>
                      {shorten(e.hash, 8, 4)} {links[i] ? null : <Badge tone="bad">does not follow</Badge>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        {more ? <button type="button" data-testid="log-older" className={SECONDARY} onClick={() => void load(olderThan(entries) ?? undefined)} disabled={loading}>{loading ? 'Loading…' : 'Older entries'}</button> : null}
        {loading && entries.length === 0 ? <p role="status" className="text-sm text-muted">Loading…</p> : null}
      </section>
    </div>
  );
}

const hasDetail = (d: unknown): boolean => d !== null && typeof d === 'object' && Object.keys(d as object).length > 0;

function AdminTools({ client, onSignedOut }: { client: PanelProps['client']; onSignedOut: () => void }) {
  const [check, setCheck] = useState<ChainCheck | null>(null);
  const [head, setHead] = useState<SignedHead | null>(null);
  const verify = useAction(onSignedOut);
  const sign = useAction(onSignedOut);
  const saveHead = () => {
    if (!head?.document) return;
    const blob = new Blob([JSON.stringify(head.document, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'ops-log-head.json';
    a.click();
    URL.revokeObjectURL(a.href);
  };
  return (
    <section aria-labelledby="chain-h" className="space-y-4 rounded-xl border border-border p-4">
      <h2 id="chain-h" className="text-lg font-semibold">Check the chain</h2>
      <div className="flex flex-wrap gap-2">
        <button type="button" data-testid="log-verify" className={PRIMARY} disabled={verify.busy} onClick={async () => { setCheck(null); const r = await verify.run(() => client.verifyLog(), () => 'Chain checked.'); if (r) setCheck(r.value); }}>
          {verify.busy ? 'Recomputing…' : 'Verify the chain'}
        </button>
        <button type="button" data-testid="log-head" className={SECONDARY} disabled={sign.busy} onClick={async () => { setHead(null); const r = await sign.run(() => client.logHead(), () => 'Head read.'); if (r) setHead(r.value); }}>
          {sign.busy ? 'Reading…' : 'Get the signed head'}
        </button>
      </div>
      {verify.error ? <Notice tone="error" testId="verify-error">{verify.error}</Notice> : null}
      {check ? <ChainResult check={check} /> : null}
      {sign.error ? <Notice tone="error" testId="head-error">{sign.error}</Notice> : null}
      {head ? (
        <div className="space-y-2" data-testid="head-result">
          {head.signed ? <Notice tone="ok">The head is signed. Copy it somewhere the operator cannot quietly change.</Notice> : <Notice tone={head.check.ok ? 'info' : 'error'}>{head.check.ok ? (head.note ?? 'The head is not signed.') : 'The chain is broken, so it is not signed.'}</Notice>}
          <ChainResult check={head.check} />
          {head.document ? (
            <>
              <Json value={head.document} label="Show the signed document" />
              <button type="button" className={SECONDARY} onClick={saveHead} data-testid="head-save">Download the signed head</button>
            </>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function ChainResult({ check }: { check: ChainCheck }) {
  return check.ok ? (
    <Notice tone="ok" testId="chain-ok">The chain is intact: {check.length} entries, ending at {shorten(check.head, 12, 8)}.</Notice>
  ) : (
    <Notice tone="error" testId="chain-broken">The chain is broken at entry {check.brokenAt?.seq}: {check.brokenAt?.why}.</Notice>
  );
}
