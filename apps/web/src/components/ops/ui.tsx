'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { OpsApiError, type OpsClient, type Principal } from './ops-client';

export type PanelProps = { client: OpsClient; me: Principal; onSignedOut: () => void };

export const INPUT = 'mt-1 w-full rounded-lg border border-border-strong bg-bg px-3 py-2.5 text-sm text-ink placeholder:text-subtle';
export const PRIMARY = 'rounded-full bg-accent-fill px-5 py-2.5 text-sm font-medium text-on-accent disabled:opacity-50';
export const SECONDARY = 'rounded-full border border-border-strong px-4 py-2 text-sm font-medium text-ink hover:bg-surface disabled:opacity-50';

export function Field({ id, label, hint, children }: { id: string; label: string; hint?: string; children: ReactNode }) {
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium">{label}</label>
      {hint ? <p id={`${id}-hint`} className="mt-0.5 text-xs text-muted">{hint}</p> : null}
      {children}
    </div>
  );
}

const TONES: Record<string, string> = {
  neutral: 'border-border-strong text-muted',
  good: 'border-positive text-positive',
  warn: 'border-accent text-accent-text',
  bad: 'border-accent bg-accent-fill text-on-accent',
};
export function Badge({ tone = 'neutral', children }: { tone?: keyof typeof TONES; children: ReactNode }) {
  return <span className={`inline-flex items-center rounded-full border px-2 py-0.5 font-mono text-[11px] uppercase tracking-wider ${TONES[tone]}`}>{children}</span>;
}

/** A message the person must be able to read at once: it is announced when it appears. */
export function Notice({ tone, children, testId }: { tone: 'error' | 'ok' | 'info'; children: ReactNode; testId?: string }) {
  const style = tone === 'error' ? 'border-accent text-accent-text' : tone === 'ok' ? 'border-positive text-positive' : 'border-border-strong text-muted';
  return (
    <p role={tone === 'error' ? 'alert' : 'status'} data-testid={testId} className={`rounded-lg border px-3 py-2 text-sm ${style}`}>
      {children}
    </p>
  );
}

export function Json({ value, label = 'Show the data' }: { value: unknown; label?: string }) {
  return (
    <details className="mt-1 text-xs">
      <summary className="cursor-pointer text-muted underline underline-offset-4">{label}</summary>
      <pre className="mt-1 max-h-72 overflow-auto rounded-lg bg-surface p-3 font-mono text-[12px] leading-5 text-ink">{JSON.stringify(value, null, 2)}</pre>
    </details>
  );
}

export type Loaded<T> = { state: 'loading' } | { state: 'error'; error: OpsApiError } | { state: 'ready'; data: T };

/** Runs `load` on mount and whenever its inputs change, and again on `reload()`. A slower, older answer never replaces a newer one. */
export function useLoad<T>(load: () => Promise<T>, inputs: readonly unknown[]): [Loaded<T>, () => void] {
  const [value, setValue] = useState<Loaded<T>>({ state: 'loading' });
  const [tick, setTick] = useState(0);
  const latest = useRef(0);
  const loader = useRef(load);
  loader.current = load;
  useEffect(() => {
    const mine = ++latest.current;
    setValue((v) => (v.state === 'ready' ? v : { state: 'loading' }));
    loader.current().then(
      (data) => {
        if (mine === latest.current) setValue({ state: 'ready', data });
      },
      (e: unknown) => {
        if (mine === latest.current) setValue({ state: 'error', error: e instanceof OpsApiError ? e : new OpsApiError(0, e instanceof Error ? e.message : String(e)) });
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...inputs, tick]);
  return [value, useCallback(() => setTick((t) => t + 1), [])];
}

/** Runs one action at a time and keeps what it said: `busy`, the error to show, and the success message. `run` returns `{ value }` when the action worked and null when it failed (a void action's value is undefined, so the result itself says which). */
export function useAction(onSignedOut: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const run = useCallback(
    async <T,>(fn: () => Promise<T>, message: (r: T) => string): Promise<{ value: T } | null> => {
      setBusy(true);
      setError(null);
      setDone(null);
      try {
        const r = await fn();
        setDone(message(r));
        return { value: r };
      } catch (e) {
        if (e instanceof OpsApiError && e.signedOut) onSignedOut();
        setError(e instanceof Error ? e.message : String(e));
        return null;
      } finally {
        setBusy(false);
      }
    },
    [onSignedOut],
  );
  return { busy, error, done, run, clear: () => { setError(null); setDone(null); } };
}

export function LoadState<T>({ loaded, empty, children }: { loaded: Loaded<T>; empty?: (d: T) => string | null; children: (d: T) => ReactNode }) {
  if (loaded.state === 'loading') return <p className="text-sm text-muted" role="status">Loading…</p>;
  if (loaded.state === 'error') return <Notice tone="error">{loaded.error.message}</Notice>;
  const none = empty?.(loaded.data);
  if (none) return <p className="rounded-lg border border-dashed border-border-strong px-4 py-6 text-center text-sm text-muted">{none}</p>;
  return <>{children(loaded.data)}</>;
}
