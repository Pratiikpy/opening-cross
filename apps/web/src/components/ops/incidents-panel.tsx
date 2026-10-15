'use client';

import { useState } from 'react';
import { type Incident, INCIDENT_STATES, type IncidentState, SEVERITIES, type Severity, allows, incidentProblem, resolutionProblem, when } from './ops-client';
import { Badge, Field, INPUT, Json, LoadState, Notice, type PanelProps, PRIMARY, SECONDARY, useAction, useLoad } from './ui';

const SEVERITY_TONE: Record<Severity, 'bad' | 'warn' | 'neutral'> = { critical: 'bad', warning: 'warn', info: 'neutral' };
const STATE_TONE: Record<IncidentState, 'bad' | 'warn' | 'good'> = { open: 'bad', acknowledged: 'warn', resolved: 'good' };

export function IncidentsPanel({ client, me, onSignedOut }: PanelProps) {
  const [state, setState] = useState<IncidentState | ''>('');
  const [list, reload] = useLoad(() => client.incidents(state || undefined), [client, state]);
  return (
    <div className="space-y-8">
      <p className="max-w-3xl text-sm text-muted">
        The monitor opens an incident when it pauses the protocol, when a pause fails, and when a critical finding persists. Anyone with the reviewer role can also open one by hand. An incident is acknowledged by a reviewer and resolved, with a written resolution, by an admin.
      </p>
      {allows(me.role, 'reviewer') ? <OpenIncident client={client} onSignedOut={onSignedOut} onOpened={reload} /> : <Notice tone="info">Your role is viewer: you can read incidents but not open or change them.</Notice>}
      <section aria-labelledby="inc-h" className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <h2 id="inc-h" className="text-lg font-semibold">Incidents</h2>
          <div className="flex items-end gap-2">
            <div>
              <label htmlFor="incident-state" className="block text-xs text-muted">State</label>
              <select id="incident-state" data-testid="incident-state" value={state} onChange={(e) => setState(e.target.value as IncidentState | '')} className="rounded-lg border border-border-strong bg-bg px-3 py-2 text-sm">
                <option value="">All</option>
                {INCIDENT_STATES.map((s) => <option key={s} value={s}>{s[0]!.toUpperCase() + s.slice(1)}</option>)}
              </select>
            </div>
            <button type="button" className={SECONDARY} onClick={reload}>Refresh</button>
          </div>
        </div>
        <LoadState loaded={list} empty={(d) => (d.length === 0 ? 'No incidents match.' : null)}>
          {(rows) => (
            <ul className="space-y-3" data-testid="incident-list">
              {rows.map((i) => <IncidentCard key={i.id} i={i} client={client} me={me} onSignedOut={onSignedOut} onChanged={reload} />)}
            </ul>
          )}
        </LoadState>
      </section>
    </div>
  );
}

function OpenIncident({ client, onSignedOut, onOpened }: { client: PanelProps['client']; onSignedOut: () => void; onOpened: () => void }) {
  const [title, setTitle] = useState('');
  const [severity, setSeverity] = useState<Severity>('warning');
  const [note, setNote] = useState('');
  const [shown, setShown] = useState(false);
  const a = useAction(onSignedOut);
  const problem = incidentProblem({ title, note });
  return (
    <section aria-labelledby="inc-open-h" className="space-y-3 rounded-xl border border-border p-4">
      <h2 id="inc-open-h" className="text-lg font-semibold">Open an incident</h2>
      <form
        className="grid gap-4 sm:grid-cols-3"
        onSubmit={async (e) => {
          e.preventDefault();
          setShown(true);
          if (problem) return;
          const r = await a.run(() => client.openIncident({ title: title.trim(), severity, ...(note.trim() ? { note: note.trim() } : {}) }), () => 'Incident opened.');
          if (r) {
            setTitle('');
            setNote('');
            setShown(false);
            onOpened();
          }
        }}
      >
        <div className="sm:col-span-2">
          <Field id="inc-title" label="What is wrong?">
            <input id="inc-title" data-testid="inc-title" value={title} onChange={(e) => setTitle(e.target.value)} className={INPUT} />
          </Field>
        </div>
        <Field id="inc-severity" label="Severity">
          <select id="inc-severity" data-testid="inc-severity" value={severity} onChange={(e) => setSeverity(e.target.value as Severity)} className={INPUT}>
            {SEVERITIES.map((s) => <option key={s} value={s}>{s[0]!.toUpperCase() + s.slice(1)}</option>)}
          </select>
        </Field>
        <div className="sm:col-span-3">
          <Field id="inc-note" label="Details (optional)">
            <textarea id="inc-note" data-testid="inc-note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} className={INPUT} />
          </Field>
        </div>
        <div className="space-y-2 sm:col-span-3">
          {shown && problem ? <Notice tone="error">{problem}</Notice> : null}
          {a.error ? <Notice tone="error" testId="inc-error">{a.error}</Notice> : null}
          {a.done ? <Notice tone="ok" testId="inc-done">{a.done}</Notice> : null}
          <button type="submit" data-testid="inc-submit" disabled={a.busy} className={PRIMARY}>{a.busy ? 'Opening…' : 'Open incident'}</button>
        </div>
      </form>
    </section>
  );
}

function IncidentCard({ i, client, me, onSignedOut, onChanged }: { i: Incident; client: PanelProps['client']; me: PanelProps['me']; onSignedOut: () => void; onChanged: () => void }) {
  const [resolution, setResolution] = useState('');
  const [asking, setAsking] = useState(false);
  const [shown, setShown] = useState(false);
  const a = useAction(onSignedOut);
  const problem = resolutionProblem(resolution);
  const detail = i.detail && typeof i.detail === 'object' && Object.keys(i.detail as object).length > 0 ? i.detail : null;
  return (
    <li className="rounded-xl border border-border p-4" data-testid={`incident-${i.id}`}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Badge tone={SEVERITY_TONE[i.severity]}>{i.severity}</Badge>
        <Badge tone={STATE_TONE[i.state]}>{i.state}</Badge>
        <Badge>{i.source}</Badge>
        <h3 className="text-sm font-semibold">{i.title}</h3>
      </div>
      <p className="mt-1 text-xs text-muted">
        Opened {when(i.opened_at)}
        {i.acknowledged_by ? `. Acknowledged by ${i.acknowledged_by}, ${when(i.acknowledged_at)}` : ''}
        {i.resolved_by ? `. Resolved by ${i.resolved_by}, ${when(i.resolved_at)}` : ''}.
      </p>
      {i.resolution ? <p className="mt-2 text-sm"><span className="text-muted">Resolution: </span>{i.resolution}</p> : null}
      {detail ? <Json value={detail} label="Show what the monitor sent" /> : null}

      <div className="mt-3 flex flex-wrap items-start gap-2">
        {i.state === 'open' && allows(me.role, 'reviewer') ? (
          <button
            type="button"
            className={SECONDARY}
            data-testid={`ack-${i.id}`}
            disabled={a.busy}
            onClick={async () => {
              if (await a.run(() => client.ackIncident(i.id), () => 'Acknowledged.')) onChanged();
            }}
          >
            Acknowledge
          </button>
        ) : null}
        {i.state !== 'resolved' && allows(me.role, 'admin') ? (
          asking ? null : <button type="button" className={SECONDARY} data-testid={`resolve-open-${i.id}`} onClick={() => setAsking(true)}>Resolve…</button>
        ) : null}
        {i.state !== 'resolved' && !allows(me.role, 'admin') ? <span className="py-2 text-xs text-muted">Only an admin resolves an incident.</span> : null}
      </div>
      {asking && i.state !== 'resolved' ? (
        <form
          className="mt-3 space-y-2"
          onSubmit={async (e) => {
            e.preventDefault();
            setShown(true);
            if (problem) return;
            const r = await a.run(() => client.resolveIncident(i.id, resolution.trim()), () => 'Resolved.');
            if (r) {
              setAsking(false);
              setShown(false);
              onChanged();
            }
          }}
        >
          <Field id={`res-${i.id}`} label="Resolution" hint="What was done, at least 10 characters.">
            <textarea id={`res-${i.id}`} data-testid={`resolution-${i.id}`} rows={2} value={resolution} onChange={(e) => setResolution(e.target.value)} className={INPUT} />
          </Field>
          {shown && problem ? <Notice tone="error">{problem}</Notice> : null}
          <div className="flex gap-2">
            <button type="submit" className={PRIMARY} data-testid={`resolve-${i.id}`} disabled={a.busy}>Record resolution</button>
            <button type="button" className={SECONDARY} onClick={() => setAsking(false)}>Cancel</button>
          </div>
        </form>
      ) : null}
      {a.error ? <div className="mt-2"><Notice tone="error" testId={`incident-error-${i.id}`}>{a.error}</Notice></div> : null}
    </li>
  );
}
