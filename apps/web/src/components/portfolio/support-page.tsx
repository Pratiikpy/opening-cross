'use client';

import { useEffect, useId, useState } from 'react';
import { HOLDER_API_URL } from '@/lib/holder-api';
import { useWallet } from '@/lib/wallet';
import { IdentityStatus } from './identity-status';

const TOPICS = [
  { v: 'order', t: 'An order' },
  { v: 'claim', t: 'A claim or a refund' },
  { v: 'identity', t: 'A pass or an identity check' },
  { v: 'alerts', t: 'Alerts' },
  { v: 'other', t: 'Something else' },
];
const KEY = 'opening-bell.support.v1';

type Config = { reachesAPerson: boolean; responseHours: number | null; commitment: string };
type Saved = { id: string; token: string; topic: string; at: number };
type Status = { status: 'open' | 'answered'; answer: string | null; createdAt: number };

const post = async <T,>(path: string, body: unknown): Promise<{ ok: true; data: T } | { ok: false; error: string }> => {
  try {
    const r = await fetch(`${HOLDER_API_URL}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const j = (await r.json().catch(() => ({}))) as T & { error?: string };
    return r.ok ? { ok: true, data: j } : { ok: false, error: j.error ?? `HTTP ${r.status}` };
  } catch {
    return { ok: false, error: 'The Opening Cross API could not be reached.' };
  }
};

function loadSaved(): Saved[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '[]') as Saved[];
    return Array.isArray(v) ? v.filter((s) => typeof s.id === 'string' && typeof s.token === 'string').slice(0, 20) : [];
  } catch {
    return [];
  }
}

export function SupportPage() {
  const { account } = useWallet();
  const id = useId();
  const [config, setConfig] = useState<Config | null | 'error'>(null);
  const [topic, setTopic] = useState('order');
  const [message, setMessage] = useState('');
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [saved, setSaved] = useState<Saved[]>([]);
  const [statuses, setStatuses] = useState<Record<string, Status | 'gone'>>({});

  useEffect(() => {
    let live = true;
    void fetch(`${HOLDER_API_URL}/v1/support/config`, { cache: 'no-store' })
      .then(async (r) => (r.ok ? ((await r.json()) as Config) : ('error' as const)))
      .catch(() => 'error' as const)
      .then((c) => live && setConfig(c));
    setSaved(loadSaved());
    return () => {
      live = false;
    };
  }, []);
  useEffect(() => {
    let live = true;
    for (const s of saved) {
      void post<Status>('/v1/support/status', { id: s.id, token: s.token }).then((r) => live && setStatuses((m) => ({ ...m, [s.id]: r.ok ? r.data : 'gone' })));
    }
    return () => {
      live = false;
    };
  }, [saved]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setNote(null);
    const r = await post<{ id: string; token: string; notified: boolean; commitment: string }>('/v1/support', { topic, message, ...(email ? { contact: email } : {}), ...(account ? { wallet: account.address } : {}) });
    setBusy(false);
    if (!r.ok) return setNote({ ok: false, text: r.error });
    const next = [{ id: r.data.id, token: r.data.token, topic, at: Math.floor(Date.now() / 1000) }, ...saved].slice(0, 20);
    try {
      localStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      // The reference below still works for this visit.
    }
    setSaved(next);
    setMessage('');
    setNote({ ok: true, text: `Sent. Your reference is ${r.data.id}. ${r.data.notified ? 'The team has been notified.' : 'It is stored for the team; no one was notified by email.'} ${r.data.commitment}` });
  }

  return (
    <div className="mt-8 grid items-start gap-8 lg:grid-cols-[1.2fr_1fr]">
      <div>
        <section aria-labelledby="ask-h" className="rounded-[var(--radius-card)] border border-border p-5">
          <h2 id="ask-h" className="font-medium">
            Ask a person
          </h2>
          {config === null ? (
            <p className="mt-2 text-sm text-muted">Checking…</p>
          ) : config === 'error' ? (
            <p role="alert" className="mt-2 text-sm text-accent-text">
              Support could not be reached just now. Your money is safe: orders and refunds work from the Orders page without anyone&apos;s help.
            </p>
          ) : (
            <>
              <p className="mt-2 text-sm" data-testid="support-commitment">
                {config.commitment}
              </p>
              {!config.reachesAPerson ? <p className="mt-1 text-sm text-muted">No inbox is connected on this deployment, so requests are kept for the team but nobody is mailed.</p> : null}
              <form onSubmit={(e) => void submit(e)} className="mt-4">
                <label htmlFor={`${id}-t`} className="text-sm text-muted">
                  What is it about?
                </label>
                <select id={`${id}-t`} value={topic} onChange={(e) => setTopic(e.target.value)} className="mt-1 w-full rounded-lg border border-border-strong bg-bg px-3 py-2.5 text-sm">
                  {TOPICS.map((t) => (
                    <option key={t.v} value={t.v}>
                      {t.t}
                    </option>
                  ))}
                </select>
                <label htmlFor={`${id}-m`} className="mt-4 block text-sm text-muted">
                  What happened? Include the cross address if you have it.
                </label>
                <textarea id={`${id}-m`} value={message} onChange={(e) => setMessage(e.target.value)} rows={5} required minLength={10} maxLength={2000} className="mt-1 w-full rounded-lg border border-border-strong bg-bg px-3 py-2.5 text-sm" />
                <label htmlFor={`${id}-e`} className="mt-4 block text-sm text-muted">
                  Email for a reply (optional: without one, check this page with your reference)
                </label>
                <input id={`${id}-e`} type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" className="mt-1 w-full rounded-lg border border-border-strong bg-bg px-3 py-2.5 text-sm" />
                <p className="mt-3 text-xs text-muted">{account ? 'Your connected wallet address is sent with the request so the team can look at your orders. ' : 'No wallet is connected, so none is sent. '}Never send a seed phrase or a private key: nobody here will ever ask for one.</p>
                <button type="submit" disabled={busy || message.trim().length < 10} className="mt-4 min-h-11 rounded-full bg-accent-fill px-5 py-2.5 text-sm font-medium text-on-accent hover:opacity-90 disabled:opacity-50">
                  {busy ? 'Sending…' : 'Send'}
                </button>
              </form>
              {note ? (
                <p role={note.ok ? 'status' : 'alert'} className={`mt-3 text-sm ${note.ok ? '' : 'text-accent-text'}`} data-testid="support-note">
                  {note.text}
                </p>
              ) : null}
            </>
          )}
        </section>

        <section aria-labelledby="mine-h" className="mt-8">
          <h2 id="mine-h" className="font-medium">
            Your requests
          </h2>
          {saved.length === 0 ? (
            <p className="mt-2 text-sm text-muted">None from this browser.</p>
          ) : (
            <ul className="mt-2 divide-y divide-border border-y border-border" data-testid="support-list">
              {saved.map((s) => {
                const st = statuses[s.id];
                return (
                  <li key={s.id} className="py-3 text-sm">
                    <p>
                      <span className="font-mono">{s.id}</span> <span className="text-muted">· {s.topic} · {new Date(s.at * 1000).toISOString().slice(0, 10)}</span>
                    </p>
                    <p className="mt-1 text-muted">{st === undefined ? 'Checking…' : st === 'gone' ? 'This request could not be found.' : st.status === 'answered' ? `Answered: ${st.answer}` : 'Open. A reply will appear here.'}</p>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
      <div className="space-y-6">
        <IdentityStatus />
        <section className="rounded-[var(--radius-card)] border border-border p-5 text-sm text-muted">
          <h2 className="font-medium text-ink">Before you ask</h2>
          <ul className="mt-2 list-disc space-y-1.5 pl-5">
            <li>Orders, claims and refunds are on the Orders page. Nothing waits on a person: anyone can settle a cross, and an order is paid out or refunded by its own claim.</li>
            <li>An unrevealed sealed bid is refunded in full once the cross settles.</li>
            <li>This is a devnet test deployment. Nothing here is advice, and nothing on it has real value.</li>
          </ul>
        </section>
      </div>
    </div>
  );
}
