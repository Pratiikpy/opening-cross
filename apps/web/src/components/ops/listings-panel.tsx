'use client';

import { useState } from 'react';
import {
  type Decision,
  type Evidence,
  type Listing,
  LISTING_STATUSES,
  type ListingStatus,
  allows,
  decisionProblem,
  evidenceSummary,
  failedSources,
  listingProblem,
  shorten,
  when,
} from './ops-client';
import { Badge, Field, INPUT, Json, LoadState, Notice, type PanelProps, PRIMARY, SECONDARY, useAction, useLoad } from './ui';

const STATUS_TONE: Record<ListingStatus, 'neutral' | 'good' | 'warn' | 'bad'> = { pending: 'warn', approved: 'good', rejected: 'bad', 'needs-info': 'neutral' };
const STATUS_LABEL: Record<ListingStatus, string> = { pending: 'Pending', approved: 'Approved', rejected: 'Rejected', 'needs-info': 'Needs info' };

export function ListingsPanel({ client, me, onSignedOut }: PanelProps) {
  const [status, setStatus] = useState<ListingStatus | ''>('');
  const [selected, setSelected] = useState<string | null>(null);
  const [list, reload] = useLoad(() => client.listings(status || undefined), [client, status]);
  const canOpen = allows(me.role, 'reviewer');
  return (
    <div className="space-y-8">
      <p className="max-w-3xl text-sm text-muted">
        A listing review collects the evidence on a token or a cross at the moment it is opened. A different reviewer reads that evidence and decides, with a written reason. The person who opens a review cannot decide it.
      </p>
      {canOpen ? <OpenReview client={client} onSignedOut={onSignedOut} onOpened={(id) => { setSelected(id); reload(); }} /> : <Notice tone="info">Your role is viewer: you can read reviews but not open or decide them.</Notice>}

      <section aria-labelledby="queue-h" className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <h2 id="queue-h" className="text-lg font-semibold">Queue</h2>
          <div className="flex items-end gap-2">
            <div>
              <label htmlFor="listing-status" className="block text-xs text-muted">Status</label>
              <select id="listing-status" data-testid="listing-status" value={status} onChange={(e) => setStatus(e.target.value as ListingStatus | '')} className="rounded-lg border border-border-strong bg-bg px-3 py-2 text-sm">
                <option value="">All</option>
                {LISTING_STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
              </select>
            </div>
            <button type="button" className={SECONDARY} onClick={reload}>Refresh</button>
          </div>
        </div>
        <LoadState loaded={list} empty={(d) => (d.length === 0 ? 'No reviews match. Open one above.' : null)}>
          {(rows) => (
            <ul className="divide-y divide-border rounded-xl border border-border" data-testid="listing-queue">
              {rows.map((r) => (
                <li key={r.id}>
                  <button
                    type="button"
                    onClick={() => setSelected(r.id === selected ? null : r.id)}
                    aria-expanded={r.id === selected}
                    data-testid={`listing-${r.id}`}
                    className={`flex w-full flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 text-left text-sm hover:bg-surface ${r.id === selected ? 'bg-surface' : ''}`}
                  >
                    <Badge tone={STATUS_TONE[r.status]}>{STATUS_LABEL[r.status]}</Badge>
                    <span className="font-mono text-[13px]" title={r.mint ?? r.cross_address ?? ''}>{r.mint ? `mint ${shorten(r.mint)}` : `cross ${shorten(r.cross_address)}`}</span>
                    <span className="text-muted">opened by {r.requested_by}</span>
                    <span className="text-muted">{when(r.created_at)}</span>
                    {r.evidence_failed && r.evidence_failed.length > 0 ? <Badge tone="warn">evidence missing: {r.evidence_failed.join(', ')}</Badge> : null}
                  </button>
                  {r.id === selected ? <ListingDetail client={client} me={me} id={r.id} onSignedOut={onSignedOut} onChanged={reload} /> : null}
                </li>
              ))}
            </ul>
          )}
        </LoadState>
      </section>

      <CrossLookup client={client} onSignedOut={onSignedOut} />
    </div>
  );
}

function OpenReview({ client, onSignedOut, onOpened }: { client: PanelProps['client']; onSignedOut: () => void; onOpened: (id: string) => void }) {
  const [mint, setMint] = useState('');
  const [cross, setCross] = useState('');
  const [note, setNote] = useState('');
  const [shown, setShown] = useState(false);
  const a = useAction(onSignedOut);
  const problem = listingProblem({ mint, cross, note });
  return (
    <section aria-labelledby="open-h" className="space-y-3 rounded-xl border border-border p-4">
      <h2 id="open-h" className="text-lg font-semibold">Open a review</h2>
      <form
        className="grid gap-4 sm:grid-cols-2"
        onSubmit={async (e) => {
          e.preventDefault();
          setShown(true);
          if (problem) return;
          const r = await a.run(() => client.openListing({ ...(mint.trim() ? { mint: mint.trim() } : {}), ...(cross.trim() ? { cross: cross.trim() } : {}), note: note.trim() }), (x) => `Review opened. ${failedSources(x.evidence).length ? `Evidence could not be gathered for ${failedSources(x.evidence).join(', ')}.` : 'All evidence sources answered.'}`);
          if (r) {
            setMint('');
            setCross('');
            setNote('');
            setShown(false);
            onOpened(r.value.id);
          }
        }}
      >
        <Field id="open-mint" label="Token mint">
          <input id="open-mint" data-testid="open-mint" value={mint} onChange={(e) => setMint(e.target.value)} spellCheck={false} autoComplete="off" className={`${INPUT} font-mono`} />
        </Field>
        <Field id="open-cross" label="Cross address">
          <input id="open-cross" data-testid="open-cross" value={cross} onChange={(e) => setCross(e.target.value)} spellCheck={false} autoComplete="off" className={`${INPUT} font-mono`} />
        </Field>
        <div className="sm:col-span-2">
          <Field id="open-note" label="Why is this being reviewed?">
            <textarea id="open-note" data-testid="open-note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} className={INPUT} />
          </Field>
        </div>
        <div className="space-y-2 sm:col-span-2">
          {shown && problem ? <Notice tone="error">{problem}</Notice> : null}
          {a.error ? <Notice tone="error" testId="open-error">{a.error}</Notice> : null}
          {a.done ? <Notice tone="ok" testId="open-done">{a.done}</Notice> : null}
          <button type="submit" data-testid="open-submit" disabled={a.busy} className={PRIMARY}>{a.busy ? 'Gathering evidence…' : 'Open review'}</button>
          {a.busy ? <p className="text-xs text-muted">The console asks each evidence source in turn, up to 25 seconds each.</p> : null}
        </div>
      </form>
    </section>
  );
}

function ListingDetail({ client, me, id, onSignedOut, onChanged }: { client: PanelProps['client']; me: PanelProps['me']; id: string; onSignedOut: () => void; onChanged: () => void }) {
  const [item, reload] = useLoad(() => client.listing(id), [client, id]);
  return (
    <div className="space-y-4 border-t border-border bg-surface px-4 py-4" data-testid="listing-detail">
      <LoadState loaded={item}>
        {(l) => (
          <>
            <Facts l={l} />
            <EvidenceTable evidence={l.evidence ?? {}} />
            <DecisionForm client={client} me={me} l={l} onSignedOut={onSignedOut} onDone={() => { reload(); onChanged(); }} />
          </>
        )}
      </LoadState>
    </div>
  );
}

function Facts({ l }: { l: Listing }) {
  return (
    <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
      {l.mint ? <Row k="Mint" v={<code className="break-all font-mono text-[13px]">{l.mint}</code>} /> : null}
      {l.cross_address ? <Row k="Cross" v={<code className="break-all font-mono text-[13px]">{l.cross_address}</code>} /> : null}
      <Row k="Opened by" v={`${l.requested_by}, ${when(l.created_at)}`} />
      <Row k="Reason given" v={l.note} />
      {l.decided_by ? <Row k="Decided by" v={`${l.decided_by}, ${when(l.decided_at)}`} /> : null}
      {l.reason ? <Row k="Decision reason" v={l.reason} /> : null}
    </dl>
  );
}
function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wider text-muted">{k}</dt>
      <dd className="mt-0.5">{v}</dd>
    </div>
  );
}

export function EvidenceTable({ evidence }: { evidence: Evidence }) {
  const rows = Object.entries(evidence);
  if (rows.length === 0) return <Notice tone="info">No evidence was gathered for this review (the console has no evidence source configured).</Notice>;
  return (
    <div>
      <h3 className="mb-2 text-sm font-semibold">Evidence gathered when the review was opened</h3>
      <ul className="divide-y divide-border rounded-lg border border-border bg-bg" data-testid="evidence">
        {rows.map(([k, v]) => (
          <li key={k} className="px-3 py-2 text-sm" data-testid={`evidence-${k}`}>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <Badge tone={v.ok ? 'good' : 'bad'}>{v.ok ? 'gathered' : 'failed'}</Badge>
              <span className="font-medium">{k}</span>
              <span className="text-muted">{evidenceSummary(v)}</span>
            </div>
            {v.ok && v.data !== undefined ? <Json value={v.data} /> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

function DecisionForm({ client, me, l, onSignedOut, onDone }: { client: PanelProps['client']; me: PanelProps['me']; l: Listing; onSignedOut: () => void; onDone: () => void }) {
  const [decision, setDecision] = useState<Decision | ''>('');
  const [reason, setReason] = useState('');
  const [ack, setAck] = useState(false);
  const [shown, setShown] = useState(false);
  const a = useAction(onSignedOut);
  if (l.status === 'approved' || l.status === 'rejected') return <Notice tone="info">This review is {l.status}. To reconsider it, open a new review.</Notice>;
  if (!allows(me.role, 'reviewer')) return <Notice tone="info">Your role is viewer: you can read this review but not decide it.</Notice>;
  if (l.requested_by === me.name) return <Notice tone="info" testId="own-review">You opened this review, so someone else decides it.</Notice>;
  const failed = failedSources(l.evidence);
  const problem = decisionProblem({ decision, reason, failedSources: failed, acknowledged: ack });
  return (
    <form
      className="space-y-3 rounded-lg border border-border bg-bg p-4"
      onSubmit={async (e) => {
        e.preventDefault();
        setShown(true);
        if (problem || !decision) return;
        const r = await a.run(() => client.decideListing(l.id, { decision, reason: reason.trim(), ...(decision === 'approve' && failed.length ? { acknowledgeMissingEvidence: true } : {}) }), (x) => `Recorded: ${x.status}.`);
        if (r) {
          setShown(false);
          onDone();
        }
      }}
    >
      <fieldset className="space-y-2">
        <legend className="text-sm font-semibold">Your decision</legend>
        <div className="flex flex-wrap gap-4 text-sm">
          {(['approve', 'reject', 'needs-info'] as const).map((d) => (
            <label key={d} className="inline-flex items-center gap-2">
              <input type="radio" name={`decision-${l.id}`} value={d} checked={decision === d} onChange={() => setDecision(d)} data-testid={`decision-${d}`} />
              {d === 'approve' ? 'Approve' : d === 'reject' ? 'Reject' : 'Ask for more information'}
            </label>
          ))}
        </div>
      </fieldset>
      <Field id={`reason-${l.id}`} label="Reason" hint="At least 10 characters. It is kept with the decision and in the audit log.">
        <textarea id={`reason-${l.id}`} data-testid="decision-reason" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} className={INPUT} />
      </Field>
      {decision === 'approve' && failed.length > 0 ? (
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} data-testid="decision-ack" className="mt-1" />
          <span>I know evidence could not be gathered for <strong>{failed.join(', ')}</strong>, and I approve anyway. This is recorded under my name.</span>
        </label>
      ) : null}
      {shown && problem ? <Notice tone="error">{problem}</Notice> : null}
      {a.error ? <Notice tone="error" testId="decision-error">{a.error}</Notice> : null}
      {a.done ? <Notice tone="ok" testId="decision-done">{a.done}</Notice> : null}
      <button type="submit" data-testid="decision-submit" disabled={a.busy} className={PRIMARY}>{a.busy ? 'Recording…' : 'Record decision'}</button>
    </form>
  );
}

function CrossLookup({ client, onSignedOut }: { client: PanelProps['client']; onSignedOut: () => void }) {
  const [address, setAddress] = useState('');
  const [pack, setPack] = useState<{ cross: string; evidence: Evidence } | null>(null);
  const a = useAction(onSignedOut);
  return (
    <section aria-labelledby="lookup-h" className="space-y-3">
      <h2 id="lookup-h" className="text-lg font-semibold">Look up a cross</h2>
      <p className="text-sm text-muted">Gathers the evidence on one cross now, without opening a review: its proof, conflicts, organic volume and rating.</p>
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={async (e) => {
          e.preventDefault();
          setPack(null);
          const r = await a.run(() => client.crossReview(address.trim()), () => 'Evidence gathered.');
          if (r) setPack(r.value);
        }}
      >
        <div className="min-w-64 flex-1">
          <Field id="lookup-address" label="Cross address">
            <input id="lookup-address" data-testid="lookup-address" value={address} onChange={(e) => setAddress(e.target.value)} spellCheck={false} autoComplete="off" className={`${INPUT} font-mono`} />
          </Field>
        </div>
        <button type="submit" data-testid="lookup-submit" disabled={a.busy || !address.trim()} className={SECONDARY}>{a.busy ? 'Gathering…' : 'Gather evidence'}</button>
      </form>
      {a.error ? <Notice tone="error" testId="lookup-error">{a.error}</Notice> : null}
      {pack ? <EvidenceTable evidence={pack.evidence} /> : null}
    </section>
  );
}
