import type { ReactNode } from 'react';

const TONE = {
  info: 'border-border bg-surface',
  success: 'border-positive bg-positive-bg',
  warn: 'border-accent-text',
} as const;

/** A short message with a title, for a state the person must read: a result, a refusal, a limit. */
export function Notice({ tone = 'info', title, children, testId, alert }: { tone?: keyof typeof TONE; title: string; children?: ReactNode; testId?: string; alert?: boolean }) {
  return (
    <div role={alert ? 'alert' : 'status'} data-testid={testId} className={`rounded-[var(--radius-card)] border p-4 text-sm ${TONE[tone]}`}>
      <p className={`font-medium ${tone === 'success' ? 'text-positive' : tone === 'warn' ? 'text-accent-text' : ''}`}>{title}</p>
      {children ? <div className="mt-1 text-muted">{children}</div> : null}
    </div>
  );
}
