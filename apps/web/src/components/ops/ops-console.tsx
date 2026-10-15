'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { CasesPanel } from './cases-panel';
import { IncidentsPanel } from './incidents-panel';
import { ListingsPanel } from './listings-panel';
import { LogPanel } from './log-panel';
import { OpsApiError, type OpsClient, type Principal, createOpsClient } from './ops-client';
import { INPUT, Field, Notice, PRIMARY, SECONDARY } from './ui';

const KEY = 'opening-cross.ops.token';

// The token lives in this tab's session storage and nowhere else: closing the tab ends the session, it is never written to a cookie
// or to disk, and it is sent only to this app's own /ops/api route.
function readToken(): string {
  try {
    return window.sessionStorage.getItem(KEY) ?? '';
  } catch {
    return '';
  }
}
function keepToken(token: string | null): void {
  try {
    if (token) window.sessionStorage.setItem(KEY, token);
    else window.sessionStorage.removeItem(KEY);
  } catch {
    /* session storage can be blocked; the person then signs in again on reload */
  }
}

const TABS = [
  { id: 'listings', label: 'Listings' },
  { id: 'incidents', label: 'Incidents' },
  { id: 'cases', label: 'Cases' },
  { id: 'log', label: 'Audit log' },
] as const;
type TabId = (typeof TABS)[number]['id'];

export function OpsConsole() {
  const [token, setToken] = useState<string | null>(null); // null until session storage has been read
  const [who, setWho] = useState<Principal | null>(null);
  const [checking, setChecking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const signOut = useCallback((why?: string) => {
    keepToken(null);
    setToken('');
    setWho(null);
    setProblem(why ?? null);
  }, []);

  const client = useMemo<OpsClient | null>(() => (token ? createOpsClient(token) : null), [token]);

  useEffect(() => {
    setToken(readToken());
  }, []);

  useEffect(() => {
    if (!client) return;
    let live = true;
    setChecking(true);
    client.me().then(
      (p) => {
        if (!live) return;
        setWho(p);
        setProblem(null);
        setChecking(false);
      },
      (e: unknown) => {
        if (!live) return;
        setChecking(false);
        setWho(null);
        const err = e instanceof OpsApiError ? e : null;
        if (err?.signedOut) signOut('That token was not accepted. Check it, or ask an admin for one.');
        else setProblem(err?.message ?? 'The console could not be reached.');
      },
    );
    return () => {
      live = false;
    };
  }, [client, signOut]);

  if (token === null) return <p className="text-sm text-muted" role="status">Loading…</p>;
  if (!token || !client) return <SignIn onToken={(t) => { keepToken(t); setProblem(null); setToken(t); }} problem={problem} />;
  if (!who) {
    return (
      <div className="space-y-4">
        {checking ? <p className="text-sm text-muted" role="status">Checking your token…</p> : null}
        {problem ? <Notice tone="error">{problem}</Notice> : null}
        {!checking ? <button type="button" className={SECONDARY} onClick={() => signOut()}>Use a different token</button> : null}
      </div>
    );
  }
  return <Signed client={client} who={who} signOut={signOut} />;
}

function SignIn({ onToken, problem }: { onToken: (t: string) => void; problem: string | null }) {
  const [value, setValue] = useState('');
  return (
    <form
      className="max-w-lg space-y-4 rounded-xl border border-border bg-surface p-5"
      onSubmit={(e) => {
        e.preventDefault();
        if (value.trim()) onToken(value.trim());
      }}
    >
      <h2 className="text-lg font-semibold">Sign in</h2>
      <p className="text-sm text-muted">Paste the console token an admin gave you. It stays in this browser tab until you sign out or close the tab, and every action you take is recorded under your name.</p>
      <Field id="ops-token" label="Console token">
        <input id="ops-token" data-testid="ops-token" type="password" autoComplete="off" spellCheck={false} value={value} onChange={(e) => setValue(e.target.value)} className={`${INPUT} font-mono`} />
      </Field>
      {problem ? <Notice tone="error" testId="ops-sign-in-error">{problem}</Notice> : null}
      <button type="submit" data-testid="ops-sign-in" disabled={!value.trim()} className={PRIMARY}>Sign in</button>
    </form>
  );
}

function Signed({ client, who, signOut }: { client: OpsClient; who: Principal; signOut: (why?: string) => void }) {
  const [tab, setTab] = useState<TabId>('listings');
  const out = useCallback(() => signOut('Your session ended. Sign in again.'), [signOut]);
  const focusTab = (id: TabId) => {
    setTab(id);
    document.getElementById(`ops-tab-${id}`)?.focus();
  };
  const onKey = (e: React.KeyboardEvent, i: number) => {
    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (e.key === 'Home') focusTab(TABS[0].id);
    else if (e.key === 'End') focusTab(TABS[TABS.length - 1]!.id);
    else if (step) {
      e.preventDefault();
      focusTab(TABS[(i + step + TABS.length) % TABS.length]!.id);
    }
  };
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-surface px-4 py-3">
        <p className="text-sm" data-testid="ops-who">
          Signed in as <strong className="font-semibold">{who.name}</strong> <span className="rounded-full border border-border-strong px-2 py-0.5 font-mono text-[11px] uppercase tracking-wider text-muted">{who.role}</span>
        </p>
        <button type="button" data-testid="ops-sign-out" className={SECONDARY} onClick={() => signOut()}>Sign out</button>
      </div>

      <div role="tablist" aria-label="Console sections" className="flex flex-wrap gap-1 border-b border-border">
        {TABS.map((t, i) => (
          <button
            key={t.id}
            id={`ops-tab-${t.id}`}
            role="tab"
            type="button"
            aria-selected={tab === t.id}
            aria-controls={`ops-panel-${t.id}`}
            tabIndex={tab === t.id ? 0 : -1}
            data-testid={`ops-tab-${t.id}`}
            onClick={() => setTab(t.id)}
            onKeyDown={(e) => onKey(e, i)}
            className={`-mb-px border-b-2 px-4 py-2.5 text-sm font-medium ${tab === t.id ? 'border-accent-fill text-ink' : 'border-transparent text-muted hover:text-ink'}`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div role="tabpanel" id={`ops-panel-${tab}`} aria-labelledby={`ops-tab-${tab}`}>
        {tab === 'listings' ? <ListingsPanel client={client} me={who} onSignedOut={out} /> : null}
        {tab === 'incidents' ? <IncidentsPanel client={client} me={who} onSignedOut={out} /> : null}
        {tab === 'cases' ? <CasesPanel client={client} me={who} onSignedOut={out} /> : null}
        {tab === 'log' ? <LogPanel client={client} me={who} onSignedOut={out} /> : null}
      </div>
    </div>
  );
}
