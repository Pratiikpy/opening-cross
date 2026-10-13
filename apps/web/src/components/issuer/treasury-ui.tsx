'use client';

import type { UiWalletAccount } from '@wallet-standard/ui';
import type { TreasuryView } from '@/lib/issuer-treasury-console';

/** What every section of the treasury console needs. */
export type Ctx = {
  address: string;
  view: TreasuryView;
  account: UiWalletAccount | null;
  quoteDecimals: number | null;
  coinDecimals: number | null;
  isAuthority: boolean;
  /** The chain's clock in seconds, as of the last read. */
  now: number;
  reload: () => void;
};

export const txPath = (address: string, action: string) => `/v1/treasuries/${address}/tx/${action}`;

/** A section card of the console: a heading, a sentence that says what the section is for, then its parts. */
export function Section({ id, title, intro, children }: { id: string; title: string; intro: React.ReactNode; children: React.ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-h`} className="scroll-mt-24 space-y-4 rounded-[var(--radius-card)] border border-border p-5" data-testid={`section-${id}`}>
      <div>
        <h2 id={`${id}-h`} className="text-lg font-semibold tracking-tight">
          {title}
        </h2>
        <div className="mt-1 max-w-2xl text-sm text-muted">{intro}</div>
      </div>
      {children}
    </section>
  );
}

export function Facts({ rows }: { rows: [string, React.ReactNode][] }) {
  return (
    <dl className="grid gap-x-8 gap-y-2 text-sm sm:grid-cols-2">
      {rows.map(([k, v]) => (
        <div key={k} className="min-w-0">
          <dt className="text-muted">{k}</dt>
          <dd className="font-mono [overflow-wrap:anywhere]">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

const TONES = { ok: 'border-positive text-positive', warn: 'border-border-strong text-ink', block: 'border-accent text-accent-text', info: 'border-border text-muted' } as const;
export function Pill({ tone = 'info', children, testId }: { tone?: keyof typeof TONES; children: React.ReactNode; testId?: string }) {
  return (
    <span {...(testId ? { 'data-testid': testId } : {})} className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs ${TONES[tone]}`}>
      {children}
    </span>
  );
}

/** Not offered: a feature the treasury was extended without. Said in a sentence, never a dead button. */
export function NotEnabled({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-lg border border-border p-4 text-sm text-muted" data-testid="not-enabled">
      {children}
    </p>
  );
}

export function WhyOff({ reason }: { reason: string | undefined }) {
  return reason ? <p className="text-xs text-muted">{reason}</p> : null;
}

export const NOT_AUTHORITY = 'Only the treasury’s authority wallet can do this. Connect that wallet.';
