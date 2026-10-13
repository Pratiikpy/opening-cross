import { shortAddress } from '@/lib/units';
import { type Disclosure, type UpdateView, explorerTx, quote, utc } from '@/lib/treasury';
import { DisclosureBadge, NetworkTag } from './badges';

export function DisclosureStatus({ d, periodText }: { d: Disclosure; periodText: string }) {
  return (
    <div className="rounded-[var(--radius-card)] border border-border bg-surface p-5">
      <div className="flex flex-wrap items-center gap-3">
        <DisclosureBadge state={d.state} />
        <p className="text-sm text-muted">{d.updateCount === 0 ? 'No update posted yet.' : `${d.updateCount} update${d.updateCount === 1 ? '' : 's'} posted.`}</p>
      </div>
      <p className="mt-3 text-sm">{d.note}</p>
      {d.requestedAt !== null && d.overdueAt !== null && d.basisAt !== null ? (
        <dl className="mt-4 grid gap-x-8 gap-y-2 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-muted">Clock runs from</dt>
            <dd>
              {d.basis === 'last-update' ? 'latest update' : 'creation'}, {utc(d.basisAt)}
            </dd>
          </div>
          <div>
            <dt className="text-muted">Next update expected</dt>
            <dd>{utc(d.requestedAt)}</dd>
          </div>
          <div>
            <dt className="text-muted">Overdue from</dt>
            <dd>{utc(d.overdueAt)}</dd>
          </div>
        </dl>
      ) : null}
      <p className="mt-4 text-xs text-muted">
        The reporting clock is this page&apos;s convention: one update per allowance period ({periodText}), overdue after the treasury&apos;s grace period without one. The program does not enforce it. What the program does enforce is the attestation, shown above.
      </p>
    </div>
  );
}

export function UpdatesFeed({ updates, decimals }: { updates: UpdateView[]; decimals: number }) {
  if (updates.length === 0) return <p className="mt-4 text-sm text-muted">The owner has not posted an update.</p>;
  return (
    <ol className="mt-4 space-y-4">
      {updates.map((u) => (
        <li key={u.id} className="rounded-[var(--radius-card)] border border-border p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="font-mono text-xs text-muted">Update {u.sequence}</p>
            <NetworkTag network={u.body.cluster} />
          </div>
          <h4 className="mt-1 text-[17px] font-semibold">{u.body.title}</h4>
          <p className="mt-2 whitespace-pre-line text-sm">{u.body.summary}</p>
          <dl className="mt-4 grid gap-x-8 gap-y-2 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-muted">Covers</dt>
              <dd>
                {utc(u.body.coveredFrom)} to {utc(u.body.coveredTo)}
              </dd>
            </div>
            <div>
              <dt className="text-muted">Anchored on chain</dt>
              <dd>
                <a className="underline underline-offset-4 hover:text-ink" href={explorerTx(u.anchor.signature)} rel="noreferrer">
                  {utc(u.anchor.blockTime)}
                </a>{' '}
                (slot {u.anchor.slot})
              </dd>
            </div>
            <div className="sm:col-span-2">
              <dt className="text-muted">Declared spend against the program&apos;s Spent events</dt>
              {u.spendCheck ? (
                <dd>
                  The owner declared {quote(u.spendCheck.declaredSpentAtoms, decimals)}; the program moved {quote(u.spendCheck.spentOnChainAtoms, decimals)} in that span.{' '}
                  <span className={u.spendCheck.matches ? 'font-medium text-positive' : 'font-medium text-accent-text'}>{u.spendCheck.matches ? 'They match.' : 'They differ.'}</span>
                </dd>
              ) : (
                <dd>No figure declared, so there is nothing to check against the chain.</dd>
              )}
            </div>
          </dl>
          <p className="mt-4 break-all font-mono text-[11px] text-muted">
            id {u.id} · signed by {shortAddress(u.signer)}
            {u.previousId ? ` · follows ${u.previousId.slice(0, 12)}…` : ' · first update'}
          </p>
        </li>
      ))}
    </ol>
  );
}
