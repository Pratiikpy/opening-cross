'use client';

import { LISTING_TYPES } from '@opening-cross/presets/launch';
import type { UiWalletAccount } from '@wallet-standard/ui';
import { isAddress } from '@solana/kit';
import { useCallback, useEffect, useState } from 'react';
import { Chip, Fieldset, Select, Text } from '@/components/issue-wizard/fields';
import { type ApplicationView, type StoredRecord, publishRecord } from '@/lib/issuer-board';
import { apiRead } from '@/lib/issuer-data';
import { AUTOMATIC, LIMITS, REVIEWED } from '@/lib/issuer-review';
import { shortAddress } from '@/lib/units';
import { useWallet } from '@/lib/wallet';
import { WithMessageSigner } from './message-signer';

const STATUS_TEXT: Record<ApplicationView['status'], string> = { submitted: 'Submitted, not decided', accepted: 'Accepted', 'changes-requested': 'Changes requested', declined: 'Declined' };
const STATUS_TONE = { submitted: 'info', accepted: 'ok', 'changes-requested': 'warn', declined: 'block' } as const;

/** The published checklist, then the application. The checklist needs no wallet. */
export function Apply() {
  const { account } = useWallet();
  return (
    <div className="mt-8 space-y-12">
      <section aria-labelledby="auto-h">
        <h2 id="auto-h" className="text-xl font-semibold tracking-tight">
          What the console checks by itself
        </h2>
        <p className="mt-2 max-w-2xl text-sm text-muted">These are the readiness items of the wizard. Each is judged from the chain and from your form, with no person involved, and Create stays off until none fails.</p>
        <ol className="mt-4 divide-y divide-border border-y border-border" data-testid="automatic">
          {AUTOMATIC.map((c) => (
            <li key={c.id} className="py-3 text-sm">
              <p className="font-medium">{c.title}</p>
              <p className="mt-0.5 text-muted">{c.text}</p>
            </li>
          ))}
        </ol>
      </section>
      <section aria-labelledby="rev-h">
        <h2 id="rev-h" className="text-xl font-semibold tracking-tight">
          What a reviewer looks at
        </h2>
        <p className="mt-2 max-w-2xl text-sm text-muted">The criteria proposed for this version. The reviewers decide whether to adopt or change them.</p>
        <ol className="mt-4 divide-y divide-border border-y border-border" data-testid="reviewed">
          {REVIEWED.map((c) => (
            <li key={c.id} className="py-3 text-sm">
              <p className="font-medium">{c.title}</p>
              <p className="mt-0.5 text-muted">{c.text}</p>
            </li>
          ))}
        </ol>
        <ul className="mt-4 list-disc space-y-1 pl-5 text-sm text-muted">
          {LIMITS.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      </section>
      <section aria-labelledby="app-h">
        <h2 id="app-h" className="text-xl font-semibold tracking-tight">
          Apply
        </h2>
        {account ? (
          <WithMessageSigner account={account}>{(sign) => (
            <>
              <Application account={account} sign={sign} />
              <ReviewQueue account={account} sign={sign} />
            </>
          )}</WithMessageSigner>
        ) : (
          <p role="status" className="mt-3 rounded-[var(--radius-card)] border border-border p-5 text-sm text-muted" data-testid="apply-connect">
            Connect the wallet you will issue from to apply. You sign the application with it; nothing is sent to the network and no funds move.
          </p>
        )}
      </section>
    </div>
  );
}

function Application({ account, sign }: { account: UiWalletAccount; sign: (m: string) => Promise<string> }) {
  const wallet = account.address;
  const [f, setF] = useState({ name: '', description: '', website: '', team: '', cohort: '', listingType: 'ownership-coin', draft: '', baseMint: '', contact: '', acknowledged: false });
  const [mine, setMine] = useState<StoredRecord[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));
  const load = useCallback(async () => {
    const r = await apiRead<{ records: StoredRecord[] }>(`/v1/issuer/records?kind=application&signer=${wallet}&limit=20`);
    setMine(r.ok ? r.data.records : []);
  }, [wallet]);
  useEffect(() => {
    void load();
  }, [load]);

  const errors: Record<string, string> = {};
  if (f.name.trim() === '' || f.name.trim().length > 80) errors.name = 'A name of up to 80 characters.';
  if (f.description.trim() === '' || f.description.trim().length > 1500) errors.description = 'A description of up to 1,500 characters.';
  if (f.team.trim() === '' || f.team.trim().length > 600) errors.team = 'Who is behind it, in up to 600 characters.';
  if (f.website.trim() !== '' && !/^https?:\/\/\S+$/.test(f.website.trim())) errors.website = 'A web address starting with https://.';
  if (f.baseMint.trim() !== '' && !isAddress(f.baseMint.trim())) errors.baseMint = 'Not a Solana address.';
  if (f.draft.trim() !== '' && !/^[0-9a-f]{64}$/.test(f.draft.trim().replace(/^.*\/draft\//, ''))) errors.draft = 'A draft id or link from the demand check.';
  const touched = (k: string) => (f[k as keyof typeof f] as string).trim() !== '';
  const valid = Object.keys(errors).length === 0 && f.acknowledged;

  const submit = async () => {
    setBusy(true);
    setError(null);
    const r = await publishRecord(sign, wallet, 'application', {
      name: f.name.trim(),
      description: f.description.trim(),
      website: f.website.trim() || null,
      team: f.team.trim(),
      cohort: f.cohort.trim() || null,
      listingType: f.listingType,
      draft: f.draft.trim() ? f.draft.trim().replace(/^.*\/draft\//, '') : null,
      baseMint: f.baseMint.trim() || null,
      contact: f.contact.trim() || null,
      selfChecks: [],
      acknowledged: true,
    });
    setBusy(false);
    if (r.ok) {
      setDone(r.data.record.id);
      void load();
    } else setError(r.error);
  };

  return (
    <div className="mt-3 space-y-8">
      <form className="max-w-2xl space-y-6" onSubmit={(e) => e.preventDefault()}>
        <Fieldset legend="Your application" note="An application is public: anyone with its id or your wallet address can read it. Give only what you are content to publish.">
          <Text label="Name of the project or company" value={f.name} onChange={(v) => set('name', v)} mono={false} error={touched('name') ? errors.name : undefined} />
          <div className="text-sm">
            <label className="block">
              <span className="text-muted">What it is and what holders get</span>
              <textarea value={f.description} onChange={(e) => set('description', e.target.value)} rows={5} className="mt-1 w-full rounded-lg border border-border-strong bg-bg px-3 py-2.5" />
            </label>
            {touched('description') && errors.description ? <span className="mt-1 block text-xs text-accent-text">{errors.description}</span> : null}
          </div>
          <div className="text-sm">
            <label className="block">
              <span className="text-muted">Who is behind it</span>
              <textarea value={f.team} onChange={(e) => set('team', e.target.value)} rows={3} className="mt-1 w-full rounded-lg border border-border-strong bg-bg px-3 py-2.5" />
            </label>
            {touched('team') && errors.team ? <span className="mt-1 block text-xs text-accent-text">{errors.team}</span> : null}
          </div>
          <Select label="What you are listing" value={f.listingType} onChange={(v) => set('listingType', v)} options={LISTING_TYPES.map((t) => [t.id, t.name] as [string, string])} />
          <Text label="Website (optional)" value={f.website} onChange={(v) => set('website', v)} error={touched('website') ? errors.website : undefined} />
          <Text label="Token address, if it exists (optional)" value={f.baseMint} onChange={(v) => set('baseMint', v)} error={touched('baseMint') ? errors.baseMint : undefined} />
          <Text label="Draft listing id or link (optional)" value={f.draft} onChange={(v) => set('draft', v)} error={touched('draft') ? errors.draft : undefined} />
          <Text label="Accelerator or program you belong to (optional)" value={f.cohort} onChange={(v) => set('cohort', v)} mono={false} hint="Not verified by anyone. It is shown as a claim." />
          <Text label="How to reach you (optional, public)" value={f.contact} onChange={(v) => set('contact', v)} mono={false} />
          <label className="flex min-h-11 items-start gap-3 text-sm">
            <input type="checkbox" checked={f.acknowledged} onChange={(e) => set('acknowledged', e.target.checked)} className="mt-0.5 size-5" />
            <span>I understand this application is public, that passing review is not an approval or legal advice, and that what I wrote is my own statement.</span>
          </label>
        </Fieldset>
        <button type="button" disabled={!valid || busy} onClick={() => void submit()} data-testid="submit-application" className="w-full rounded-full bg-accent-fill px-5 py-3 text-sm font-medium text-on-accent disabled:opacity-50">
          {busy ? 'Waiting for your wallet…' : 'Sign and submit the application'}
        </button>
        {error ? (
          <p role="alert" className="text-sm text-accent-text">
            {error}
          </p>
        ) : null}
        {done ? (
          <p role="status" className="text-sm text-positive" data-testid="application-done">
            Submitted. Its id is <span className="break-all font-mono">{done}</span>.
          </p>
        ) : null}
      </form>

      <div>
        <h3 className="font-medium">Your applications</h3>
        {!mine ? (
          <p className="mt-2 text-sm text-muted">Reading…</p>
        ) : mine.length === 0 ? (
          <p className="mt-2 text-sm text-muted" data-testid="no-applications">You have not applied.</p>
        ) : (
          <ul className="mt-2 space-y-3" data-testid="my-applications">
            {mine.map((r) => (
              <Status key={r.id} record={r} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function Status({ record }: { record: StoredRecord }) {
  const [v, setV] = useState<ApplicationView | null>(null);
  useEffect(() => {
    let live = true;
    void apiRead<ApplicationView>(`/v1/issuer/applications/${record.id}`).then((r) => live && r.ok && setV(r.data));
    return () => {
      live = false;
    };
  }, [record.id]);
  return (
    <li className="rounded-lg border border-border p-4 text-sm" data-testid="application">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{String(record.body.name)}</span>
        {v ? <Chip tone={STATUS_TONE[v.status]}>{STATUS_TEXT[v.status]}</Chip> : null}
        <span className="font-mono text-xs text-muted">{shortAddress(record.id)}</span>
      </div>
      {v?.decision ? (
        <p className="mt-2 text-muted">
          Decision by {shortAddress(v.decision.signer)}: {String(v.decision.body.outcome)}
          {v.decision.body.note ? `. ${String(v.decision.body.note)}` : ''}
        </p>
      ) : v ? (
        <p className="mt-2 text-muted" data-testid="no-decision">
          {v.curatorsConfigured === 0 ? 'No reviewers are named yet, so this cannot be decided. It is stored and public.' : 'Waiting for a reviewer.'}
        </p>
      ) : null}
    </li>
  );
}

type Curators = { configured: number; curators: string[] };
const OUTCOMES = [['accepted', 'Accept'], ['changes-requested', 'Ask for changes'], ['declined', 'Decline']] as const;

/** Shown only to a wallet the operator named as a reviewer: the applications, and a signed decision on each. */
function ReviewQueue({ account, sign }: { account: UiWalletAccount; sign: (m: string) => Promise<string> }) {
  const [curators, setCurators] = useState<Curators | null>(null);
  const [apps, setApps] = useState<StoredRecord[] | null>(null);
  useEffect(() => {
    let live = true;
    void (async () => {
      const c = await apiRead<Curators>('/v1/issuer/curators');
      if (!live || !c.ok) return;
      setCurators(c.data);
      if (c.data.curators.includes(account.address)) {
        const r = await apiRead<{ records: StoredRecord[] }>('/v1/issuer/records?kind=application&limit=50');
        if (live && r.ok) setApps(r.data.records);
      }
    })();
    return () => {
      live = false;
    };
  }, [account.address]);
  if (!curators || !curators.curators.includes(account.address)) return null;
  return (
    <div className="mt-10" data-testid="review-queue">
      <h3 className="font-medium">Review queue</h3>
      <p className="mt-1 text-sm text-muted">You are named as a reviewer. Each decision is signed with your wallet and is public, with your note.</p>
      {!apps ? <p className="mt-2 text-sm text-muted">Reading…</p> : apps.length === 0 ? <p className="mt-2 text-sm text-muted">No applications yet.</p> : (
        <ul className="mt-3 space-y-3">
          {apps.map((a) => (
            <Decide key={a.id} app={a} account={account} sign={sign} />
          ))}
        </ul>
      )}
    </div>
  );
}

function Decide({ app, account, sign }: { app: StoredRecord; account: UiWalletAccount; sign: (m: string) => Promise<string> }) {
  const [v, setV] = useState<ApplicationView | null>(null);
  const [note, setNote] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const load = useCallback(async () => {
    const r = await apiRead<ApplicationView>(`/v1/issuer/applications/${app.id}`);
    if (r.ok) setV(r.data);
  }, [app.id]);
  useEffect(() => {
    void load();
  }, [load]);
  return (
    <li className="rounded-lg border border-border p-4 text-sm" data-testid="queue-item">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{String(app.body.name)}</span>
        {v ? <Chip tone={STATUS_TONE[v.status]}>{STATUS_TEXT[v.status]}</Chip> : null}
        <span className="font-mono text-xs text-muted">{shortAddress(app.signer)}</span>
      </div>
      <p className="mt-2 text-muted">{String(app.body.description)}</p>
      <div className="mt-3 max-w-md">
        <Text label="Note to the applicant (public, optional)" value={note} onChange={setNote} mono={false} />
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        {OUTCOMES.map(([o, label]) => (
          <button
            key={o}
            type="button"
            data-testid={`decide-${o}`}
            className="min-h-11 rounded-full border border-border-strong px-4 py-2 text-sm hover:bg-surface"
            onClick={async () => {
              const r = await publishRecord(sign, account.address, 'decision', { application: app.id, outcome: o, note: note.trim() === '' ? null : note.trim() });
              setMsg(r.ok ? 'Decision recorded.' : r.error);
              if (r.ok) await load();
            }}
          >
            {label}
          </button>
        ))}
      </div>
      {msg ? <p role="status" className="mt-2 text-xs text-muted">{msg}</p> : null}
    </li>
  );
}
