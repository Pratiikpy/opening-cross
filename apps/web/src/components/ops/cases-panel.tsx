'use client';

import { useState } from 'react';
import { CASE_KINDS, type CaseKind, type CaseStatus, allows, caseProblem, noteProblem, resolutionProblem, shorten, when } from './ops-client';
import { Badge, Field, INPUT, LoadState, Notice, type PanelProps, PRIMARY, SECONDARY, useAction, useLoad } from './ui';

export function CasesPanel({ client, me, onSignedOut }: PanelProps) {
  const [status, setStatus] = useState<CaseStatus | ''>('');
  const [selected, setSelected] = useState<string | null>(null);
  const [list, reload] = useLoad(() => client.cases(status || undefined), [client, status]);
  return (
    <div className="space-y-8">
      <p className="max-w-3xl text-sm text-muted">
        A compliance case follows one wallet, cross or mint: sanctions screening, fraud review or support. Notes are added by name and never edited or removed. The audit log records that a note was added, not what it said, because a case can hold personal data. Only an admin closes a case.
      </p>
      {allows(me.role, 'reviewer') ? <OpenCase client={client} onSignedOut={onSignedOut} onOpened={(id) => { setSelected(id); reload(); }} /> : <Notice tone="info">Your role is viewer: you can read cases but not open or change them.</Notice>}
      <section aria-labelledby="cases-h" className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <h2 id="cases-h" className="text-lg font-semibold">Cases</h2>
          <div className="flex items-end gap-2">
            <div>
              <label htmlFor="case-status" className="block text-xs text-muted">Status</label>
              <select id="case-status" data-testid="case-status" value={status} onChange={(e) => setStatus(e.target.value as CaseStatus | '')} className="rounded-lg border border-border-strong bg-bg px-3 py-2 text-sm">
                <option value="">All</option>
                <option value="open">Open</option>
                <option value="closed">Closed</option>
              </select>
            </div>
            <button type="button" className={SECONDARY} onClick={reload}>Refresh</button>
          </div>
        </div>
        <LoadState loaded={list} empty={(d) => (d.length === 0 ? 'No cases match.' : null)}>
          {(rows) => (
            <ul className="divide-y divide-border rounded-xl border border-border" data-testid="case-list">
              {rows.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    aria-expanded={c.id === selected}
                    data-testid={`case-${c.id}`}
                    onClick={() => setSelected(c.id === selected ? null : c.id)}
                    className={`flex w-full flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 text-left text-sm hover:bg-surface ${c.id === selected ? 'bg-surface' : ''}`}
                  >
                    <Badge tone={c.status === 'open' ? 'warn' : 'good'}>{c.status}</Badge>
                    <Badge>{c.kind}</Badge>
                    <span className="font-mono text-[13px]" title={c.subject}>{shorten(c.subject, 8, 6)}</span>
                    <span className="min-w-0 flex-1 truncate text-muted">{c.summary}</span>
                    <span className="text-xs text-muted">{when(c.opened_at)}</span>
                  </button>
                  {c.id === selected ? <CaseDetail id={c.id} client={client} me={me} onSignedOut={onSignedOut} onChanged={reload} /> : null}
                </li>
              ))}
            </ul>
          )}
        </LoadState>
      </section>
    </div>
  );
}

function OpenCase({ client, onSignedOut, onOpened }: { client: PanelProps['client']; onSignedOut: () => void; onOpened: (id: string) => void }) {
  const [kind, setKind] = useState<CaseKind>('sanctions');
  const [subject, setSubject] = useState('');
  const [summary, setSummary] = useState('');
  const [shown, setShown] = useState(false);
  const a = useAction(onSignedOut);
  const problem = caseProblem({ subject, summary });
  return (
    <section aria-labelledby="case-open-h" className="space-y-3 rounded-xl border border-border p-4">
      <h2 id="case-open-h" className="text-lg font-semibold">Open a case</h2>
      <form
        className="grid gap-4 sm:grid-cols-3"
        onSubmit={async (e) => {
          e.preventDefault();
          setShown(true);
          if (problem) return;
          const r = await a.run(() => client.openCase({ kind, subject: subject.trim(), summary: summary.trim() }), () => 'Case opened.');
          if (r) {
            setSubject('');
            setSummary('');
            setShown(false);
            onOpened(r.value.id);
          }
        }}
      >
        <Field id="case-kind" label="Kind">
          <select id="case-kind" data-testid="case-kind" value={kind} onChange={(e) => setKind(e.target.value as CaseKind)} className={INPUT}>
            {CASE_KINDS.map((k) => <option key={k} value={k}>{k[0]!.toUpperCase() + k.slice(1)}</option>)}
          </select>
        </Field>
        <div className="sm:col-span-2">
          <Field id="case-subject" label="Subject" hint="A wallet, cross or mint address.">
            <input id="case-subject" data-testid="case-subject" value={subject} onChange={(e) => setSubject(e.target.value)} spellCheck={false} autoComplete="off" className={`${INPUT} font-mono`} />
          </Field>
        </div>
        <div className="sm:col-span-3">
          <Field id="case-summary" label="Summary" hint="What needs review. Do not paste personal data here; use a note.">
            <textarea id="case-summary" data-testid="case-summary" rows={2} value={summary} onChange={(e) => setSummary(e.target.value)} className={INPUT} />
          </Field>
        </div>
        <div className="space-y-2 sm:col-span-3">
          {shown && problem ? <Notice tone="error">{problem}</Notice> : null}
          {a.error ? <Notice tone="error" testId="case-error">{a.error}</Notice> : null}
          {a.done ? <Notice tone="ok" testId="case-done">{a.done}</Notice> : null}
          <button type="submit" data-testid="case-submit" disabled={a.busy} className={PRIMARY}>{a.busy ? 'Opening…' : 'Open case'}</button>
        </div>
      </form>
    </section>
  );
}

function CaseDetail({ id, client, me, onSignedOut, onChanged }: { id: string; client: PanelProps['client']; me: PanelProps['me']; onSignedOut: () => void; onChanged: () => void }) {
  const [item, reload] = useLoad(() => client.caseDetail(id), [client, id]);
  const [text, setText] = useState('');
  const [resolution, setResolution] = useState('');
  const [closing, setClosing] = useState(false);
  const [shown, setShown] = useState(false);
  const note = useAction(onSignedOut);
  const close = useAction(onSignedOut);
  const noteErr = noteProblem(text);
  const closeErr = resolutionProblem(resolution);
  return (
    <div className="space-y-4 border-t border-border bg-surface px-4 py-4" data-testid="case-detail">
      <LoadState loaded={item}>
        {(c) => (
          <>
            <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
              <div><dt className="text-xs uppercase tracking-wider text-muted">Subject</dt><dd className="mt-0.5 break-all font-mono text-[13px]">{c.subject}</dd></div>
              <div><dt className="text-xs uppercase tracking-wider text-muted">Opened by</dt><dd className="mt-0.5">{c.opened_by}, {when(c.opened_at)}</dd></div>
              <div className="sm:col-span-2"><dt className="text-xs uppercase tracking-wider text-muted">Summary</dt><dd className="mt-0.5">{c.summary}</dd></div>
              {c.status === 'closed' ? <div className="sm:col-span-2"><dt className="text-xs uppercase tracking-wider text-muted">Closed by {c.closed_by}, {when(c.closed_at)}</dt><dd className="mt-0.5">{c.resolution}</dd></div> : null}
            </dl>

            <div>
              <h3 className="mb-2 text-sm font-semibold">Notes ({c.notes.length})</h3>
              {c.notes.length === 0 ? <p className="text-sm text-muted">No notes yet.</p> : (
                <ol className="space-y-2" data-testid="case-notes">
                  {c.notes.map((n) => (
                    <li key={n.id} className="rounded-lg border border-border bg-bg px-3 py-2 text-sm">
                      <p className="whitespace-pre-wrap">{n.text}</p>
                      <p className="mt-1 text-xs text-muted">{n.author}, {when(n.at)}</p>
                    </li>
                  ))}
                </ol>
              )}
            </div>

            {c.status === 'open' && allows(me.role, 'reviewer') ? (
              <form
                className="space-y-2 rounded-lg border border-border bg-bg p-3"
                onSubmit={async (e) => {
                  e.preventDefault();
                  setShown(true);
                  if (noteErr) return;
                  if (await note.run(() => client.addNote(id, text.trim()), () => 'Note added.')) {
                    setText('');
                    setShown(false);
                    reload();
                  }
                }}
              >
                <Field id={`note-${id}`} label="Add a note" hint="It is shown under your name and cannot be edited or removed.">
                  <textarea id={`note-${id}`} data-testid="note-text" rows={3} value={text} onChange={(e) => setText(e.target.value)} className={INPUT} />
                </Field>
                {shown && noteErr ? <Notice tone="error">{noteErr}</Notice> : null}
                {note.error ? <Notice tone="error" testId="note-error">{note.error}</Notice> : null}
                {note.done ? <Notice tone="ok" testId="note-done">{note.done}</Notice> : null}
                <button type="submit" data-testid="note-submit" disabled={note.busy} className={PRIMARY}>{note.busy ? 'Adding…' : 'Add note'}</button>
              </form>
            ) : c.status === 'closed' ? <Notice tone="info">This case is closed. To continue, open a new case.</Notice> : null}

            {c.status === 'open' ? (
              allows(me.role, 'admin') ? (
                closing ? (
                  <form
                    className="space-y-2 rounded-lg border border-border bg-bg p-3"
                    onSubmit={async (e) => {
                      e.preventDefault();
                      setShown(true);
                      if (closeErr) return;
                      if (await close.run(() => client.closeCase(id, resolution.trim()), () => 'Case closed.')) {
                        setClosing(false);
                        setShown(false);
                        reload();
                        onChanged();
                      }
                    }}
                  >
                    <Field id={`close-${id}`} label="Resolution" hint="How the case ended, at least 10 characters.">
                      <textarea id={`close-${id}`} data-testid="close-resolution" rows={2} value={resolution} onChange={(e) => setResolution(e.target.value)} className={INPUT} />
                    </Field>
                    {shown && closeErr ? <Notice tone="error">{closeErr}</Notice> : null}
                    {close.error ? <Notice tone="error" testId="close-error">{close.error}</Notice> : null}
                    <div className="flex gap-2">
                      <button type="submit" data-testid="close-submit" disabled={close.busy} className={PRIMARY}>Close case</button>
                      <button type="button" className={SECONDARY} onClick={() => setClosing(false)}>Cancel</button>
                    </div>
                  </form>
                ) : <button type="button" data-testid="close-open" className={SECONDARY} onClick={() => setClosing(true)}>Close this case…</button>
              ) : <p className="text-xs text-muted">Only an admin closes a case.</p>
            ) : null}
          </>
        )}
      </LoadState>
    </div>
  );
}
