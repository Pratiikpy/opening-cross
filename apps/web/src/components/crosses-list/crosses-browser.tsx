'use client';

import Link from 'next/link';
import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { StateBadge } from '@/components/state-badge';
import type { CrossSummary } from '@/lib/api';
import {
  DISCLOSURE_LABEL,
  type Filters,
  NO_FILTERS,
  OUTCOMES,
  OUTCOME_LABEL,
  type Outcome,
  SORT_LABEL,
  SUPPLY_LABEL,
  type SortKey,
  applyFilters,
  isFiltered,
  livePhase,
  needsDetail,
  outcomeOf,
  parseFilters,
  serializeFilters,
} from '@/lib/cross-list';
import { shortAddress } from '@/lib/units';
import { useTraits } from './use-traits';

const fmtClose = (ts: string) => `${new Date(Number(ts) * 1000).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' })} UTC`;

const field = 'h-10 rounded-lg border border-border-strong bg-bg px-3 text-sm text-ink';

export function CrossesBrowser({ crosses, initial, nowSec }: { crosses: CrossSummary[]; initial: Filters; nowSec: number }) {
  const [f, setF] = useState<Filters>(initial);
  const [now, setNow] = useState(BigInt(nowSec));
  const ids = { q: useId(), disclosure: useId(), supply: useId(), sort: useId() };

  useEffect(() => {
    const t = setInterval(() => setNow(BigInt(Math.floor(Date.now() / 1000))), 15_000);
    return () => clearInterval(t);
  }, []);

  // Keep the address bar equal to the filter state so a filtered view can be copied and shared.
  const update = useCallback((patch: Partial<Filters>) => {
    setF((prev) => {
      const next = { ...prev, ...patch };
      const qs = serializeFilters(next);
      window.history.replaceState(window.history.state, '', qs ? `?${qs}` : window.location.pathname);
      return next;
    });
  }, []);
  useEffect(() => {
    const onPop = () => setF(parseFilters(new URLSearchParams(window.location.search)));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const detail = needsDetail(f);
  const addresses = useMemo(() => crosses.map((c) => c.address), [crosses]);
  const { traits, version, pending, failed } = useTraits(addresses, detail);
  // `traits` is a shared cache that fills in place, so the results are recomputed when its version moves.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const shown = useMemo(() => applyFilters(crosses, f, traits), [crosses, f, traits, version]);

  const counts = useMemo(() => {
    const c: Record<Outcome, number> = { live: 0, cleared: 0, noprint: 0, finalized: 0 };
    for (const x of crosses) c[outcomeOf(x)]++;
    return c;
  }, [crosses]);

  const summary = `${shown.length} of ${crosses.length} ${crosses.length === 1 ? 'cross' : 'crosses'}${isFiltered(f) ? (detail && pending > 0 ? ' match so far' : ' match') : ''}`;

  return (
    <div className="mt-8">
      <form role="search" aria-label="Filter crosses" onSubmit={(e) => e.preventDefault()} className="space-y-4">
        <div>
          <label htmlFor={ids.q} className="mb-1.5 block text-sm font-medium">Search by address or mint</label>
          <input
            id={ids.q}
            type="search"
            value={f.q}
            onChange={(e) => update({ q: e.target.value })}
            placeholder="Paste a cross address, base mint or quote mint"
            autoComplete="off"
            spellCheck={false}
            maxLength={64}
            className={`${field} w-full font-mono`}
          />
        </div>

        <fieldset>
          <legend className="mb-1.5 text-sm font-medium">State</legend>
          <div className="flex flex-wrap gap-2">
            {([null, ...OUTCOMES] as (Outcome | null)[]).map((o) => {
              const active = f.state === o;
              return (
                <label
                  key={o ?? 'all'}
                  className={`inline-flex min-h-10 cursor-pointer items-center gap-2 rounded-full border px-3.5 text-sm transition-colors has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-[var(--focus)] ${active ? 'border-ink bg-ink text-bg' : 'border-border-strong text-ink hover:bg-surface'}`}
                >
                  <input type="radio" name="state" className="sr-only" checked={active} onChange={() => update({ state: o })} />
                  {o ? OUTCOME_LABEL[o] : 'All'}
                  <span className={`font-mono text-xs ${active ? 'text-bg' : 'text-muted'}`}>{o ? counts[o] : crosses.length}</span>
                </label>
              );
            })}
          </div>
        </fieldset>

        <div className="grid gap-4 sm:grid-cols-3">
          <div>
            <label htmlFor={ids.disclosure} className="mb-1.5 block text-sm font-medium">Bid disclosure</label>
            <select id={ids.disclosure} value={f.disclosure ?? ''} onChange={(e) => update({ disclosure: (e.target.value || null) as Filters['disclosure'] })} className={`${field} w-full`}>
              <option value="">Any</option>
              {Object.entries(DISCLOSURE_LABEL).map(([v, l]) => (
                <option key={v} value={v}>{l}</option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor={ids.supply} className="mb-1.5 block text-sm font-medium">Supply mode</label>
            <select id={ids.supply} value={f.supply ?? ''} onChange={(e) => update({ supply: (e.target.value || null) as Filters['supply'] })} className={`${field} w-full`}>
              <option value="">Any</option>
              {Object.entries(SUPPLY_LABEL).map(([v, l]) => (
                <option key={v} value={v}>{l}</option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor={ids.sort} className="mb-1.5 block text-sm font-medium">Sort by</label>
            <select id={ids.sort} value={f.sort} onChange={(e) => update({ sort: e.target.value as SortKey })} className={`${field} w-full`}>
              {Object.entries(SORT_LABEL).map(([v, l]) => (
                <option key={v} value={v}>{l}</option>
              ))}
            </select>
          </div>
        </div>
      </form>

      <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
        <p role="status" aria-live="polite" className="text-sm text-muted">
          {summary}
          {detail && pending > 0 ? `. Reading bid disclosure and supply mode from chain: ${pending} still to check.` : ''}
          {detail && failed > 0 ? `. ${failed} could not be read and are left out.` : ''}
        </p>
        {isFiltered(f) ? (
          <button type="button" onClick={() => update(NO_FILTERS)} className="min-h-10 rounded-full border border-border-strong px-4 text-sm hover:bg-surface">
            Clear filters
          </button>
        ) : null}
      </div>

      {shown.length === 0 ? (
        <div className="mt-4 rounded-[var(--radius-card)] border border-dashed border-border-strong px-6 py-12 text-center">
          <p className="font-medium">{pending > 0 ? 'Checking crosses…' : 'No crosses match these filters'}</p>
          <p className="mt-1 text-sm text-muted">
            {pending > 0 ? 'Results appear as each cross is read from chain.' : 'Try a shorter search, another state, or clear the filters to see all crosses.'}
          </p>
        </div>
      ) : (
        <ul className="mt-4 divide-y divide-border border-y border-border">
          {shown.map((c) => {
            const t = traits.get(c.address);
            const outcome = outcomeOf(c);
            return (
              <li key={c.address}>
                <Link href={`/crosses/${c.address}`} className="grid gap-2 py-4 transition-colors hover:bg-surface sm:grid-cols-[1fr_auto_auto] sm:items-center sm:px-3">
                  <span className="min-w-0">
                    <span className="block font-mono text-sm">{shortAddress(c.address)}</span>
                    <span className="block text-xs text-muted">
                      base {shortAddress(c.base_mint)} · quote {shortAddress(c.quote_mint)} · {c.orders_committed} {c.orders_committed === 1 ? 'order' : 'orders'}
                      {t ? ` · ${DISCLOSURE_LABEL[t.disclosure].toLowerCase()} · ${SUPPLY_LABEL[t.supplyMode].toLowerCase()}` : ''}
                    </span>
                  </span>
                  <span className="text-sm text-muted">closes {fmtClose(c.close_ts)}</span>
                  <StateBadge state={outcome === 'noprint' ? 'NoPrint' : c.state} phase={livePhase(c, now)} />
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
