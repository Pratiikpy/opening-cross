'use client';

import { useEffect, useState } from 'react';
import { Pill } from '@/components/issuer/treasury-ui';
import { API_URL } from '@/lib/api';
import { type Dashboard, type Section, SECTIONS, authorityText, programRows, rowsOf, staleText } from '@/lib/dashboard';
import { shortAddress } from '@/lib/units';

/** Every section of GET /v1/dashboard, with the route each figure came from beside it. Re-read every thirty seconds. */
export function DashboardView() {
  const [d, setD] = useState<Dashboard | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    const load = async () => {
      try {
        const res = await fetch(`${API_URL}/v1/dashboard`, { cache: 'no-store' });
        const body = (await res.json().catch(() => ({}))) as Dashboard & { error?: string };
        if (!live) return;
        if (!res.ok) {
          setError(res.status === 404 ? 'The dashboard is not enabled on this deployment of the API.' : (body.error ?? `The API answered HTTP ${res.status}.`));
          setD(null);
        } else {
          setD(body);
          setError(null);
        }
      } catch {
        if (live) {
          setError('The Opening Cross API could not be reached.');
          setD(null);
        }
      }
    };
    void load();
    const t = setInterval(() => void load(), 30_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, []);
  if (d === undefined) {
    return (
      <p role="status" className="mt-8 text-sm text-muted">
        Reading the dashboard…
      </p>
    );
  }
  if (d === null) {
    return (
      <p role="alert" className="mt-8 text-sm text-accent-text" data-testid="dashboard-error">
        {error}
      </p>
    );
  }
  const listed = new Set(SECTIONS.map((s) => s.id));
  const extra = Object.keys(d.sections).filter((k) => !listed.has(k));
  return (
    <div data-testid="dashboard" className="mt-8 space-y-6">
      <p className="text-sm text-muted">
        {d.note} Network: <span className="font-mono">{d.network}</span>. Read {new Date(d.generatedAt).toISOString().replace('T', ' ').slice(0, 19)} UTC. Amounts are in each token’s smallest unit unless a line says otherwise.
      </p>
      {[...SECTIONS.map((s) => s.id), ...extra].map((id) => {
        const meta = SECTIONS.find((s) => s.id === id) ?? { id, title: id, about: '' };
        const s = d.sections[id];
        return s ? <Card key={id} id={id} title={meta.title} about={meta.about} s={s} /> : null;
      })}
    </div>
  );
}

function Card({ id, title, about, s }: { id: string; title: string; about: string; s: Section }) {
  const stale = staleText(s);
  return (
    <section aria-labelledby={`${id}-h`} className="rounded-[var(--radius-card)] border border-border p-5" data-testid={`section-${id}`} data-state={s.ok ? (s.stale ? 'stale' : 'ok') : 'failed'}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id={`${id}-h`} className="text-lg font-semibold tracking-tight">
          {title}
        </h2>
        {s.ok ? <Pill tone={s.stale ? 'warn' : 'ok'}>{s.stale ? 'Stale' : 'Read'}</Pill> : <Pill tone="block">Unavailable</Pill>}
      </div>
      {about ? <p className="mt-1 text-sm text-muted">{about}</p> : null}
      <p className="mt-1 text-xs text-muted">
        Source: <span className="font-mono">{s.source}</span>
      </p>
      {stale ? (
        <p role="status" className="mt-2 text-sm" data-testid={`stale-${id}`}>
          {stale}
        </p>
      ) : null}
      {!s.ok ? (
        <p role="alert" className="mt-3 text-sm text-accent-text" data-testid={`failed-${id}`}>
          This section could not be read: {s.error}. Nothing is shown in its place.
        </p>
      ) : id === 'programs' ? (
        <Programs data={s.data} />
      ) : (
        <Leaves data={s.data} id={id} />
      )}
    </section>
  );
}

function Leaves({ data, id }: { data: unknown; id: string }) {
  const { rows, notes, truncated } = rowsOf(data);
  return (
    <div className="mt-3">
      {rows.length === 0 ? (
        <p className="text-sm text-muted">The route answered with nothing to show.</p>
      ) : (
        <dl className="grid gap-x-8 gap-y-2 text-sm sm:grid-cols-2" data-testid={`rows-${id}`}>
          {rows.map(([k, v], i) => (
            <div key={`${k}-${i}`} className="min-w-0">
              <dt className="text-muted">{k}</dt>
              <dd className="font-mono [overflow-wrap:anywhere]">{v}</dd>
            </div>
          ))}
        </dl>
      )}
      {truncated > 0 ? <p className="mt-2 text-xs text-muted">{truncated} more figure{truncated === 1 ? '' : 's'} are in the route itself.</p> : null}
      {notes.map((n) => (
        <p key={n} className="mt-2 text-xs text-muted">
          {n}
        </p>
      ))}
    </div>
  );
}

function Programs({ data }: { data: unknown }) {
  const rows = programRows(data);
  if (rows.length === 0) return <p className="mt-3 text-sm text-muted">The route answered with no programs.</p>;
  return (
    <div className="mt-3 overflow-x-auto" role="region" aria-label="The five programs" tabIndex={0}>
      <table className="w-full min-w-[560px] text-left text-sm" data-testid="programs-table">
        <caption className="sr-only">The five programs, when each was last deployed and who can replace it</caption>
        <thead>
          <tr className="border-b border-border text-muted">
            <th scope="col" className="py-2 pr-4 font-medium">Program</th>
            <th scope="col" className="py-2 pr-4 font-medium">Last deployed (slot)</th>
            <th scope="col" className="py-2 font-medium">Who can replace it</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => (
            <tr key={p.name} className="border-b border-border align-top">
              <th scope="row" className="py-2 pr-4 font-normal">
                <span className="font-medium">{p.name}</span>
                <span className="block font-mono text-xs text-muted">{shortAddress(p.address)}</span>
              </th>
              <td className="py-2 pr-4 font-mono">{p.lastDeployedSlot ?? 'not read'}</td>
              <td className="py-2 font-mono [overflow-wrap:anywhere]">{authorityText(p)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
