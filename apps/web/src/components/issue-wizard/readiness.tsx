'use client';

import type { Check } from '@/lib/issuer-readiness';
import { Chip, type ChipTone } from './fields';

const STATUS_LABEL: Record<Check['status'], string> = { pass: 'Ready', fail: 'Not ready', warn: 'Check this', wait: 'Waiting' };
const TONE: Record<Check['status'], ChipTone> = { pass: 'ok', fail: 'block', warn: 'warn', wait: 'info' };

/** The readiness checklist: each item judged from the chain and the form, with the reason. Create stays off while any item fails or waits. */
export function Readiness({ checks, reading, canRead, onRefresh, walletConnected }: { checks: Check[]; reading: boolean; canRead: boolean; onRefresh: () => void; walletConnected: boolean }) {
  const failing = checks.filter((c) => c.status === 'fail').length;
  const waiting = checks.filter((c) => c.status === 'wait').length;
  return (
    <section id="readiness" aria-labelledby="readiness-h" className="scroll-mt-24 rounded-[var(--radius-card)] border border-border p-5" data-testid="readiness">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 id="readiness-h" className="font-medium">
            Readiness
          </h2>
          <p className="mt-1 text-sm text-muted" role="status" data-testid="readiness-summary">
            {reading
              ? 'Reading the chain…'
              : !walletConnected
                ? 'Connect a wallet to check it against the chain. The items below that need only your form are already judged.'
                : !canRead
                  ? 'Check both mints. Each item below is then judged from what the chain says, and Create stays off until none fails.'
                  : failing > 0
                    ? `${failing} ${failing === 1 ? 'item is' : 'items are'} not ready. Create the cross stays off until ${failing === 1 ? 'it is' : 'they are'} fixed.`
                    : waiting > 0
                      ? 'Nearly there: finish the fields marked waiting.'
                      : 'Everything is ready to create.'}
          </p>
        </div>
        <button type="button" onClick={onRefresh} disabled={!canRead || reading || !walletConnected} className="min-h-11 rounded-full border border-border-strong px-4 py-2 text-sm disabled:opacity-50">
          Read the chain again
        </button>
      </div>
      <ul className="mt-4 divide-y divide-border border-y border-border">
        {checks.map((c) => (
          <li key={c.id} className="flex flex-wrap items-start gap-x-4 gap-y-1 py-3 text-sm" data-testid={`check-${c.id}`} data-status={c.status}>
            <Chip tone={TONE[c.status]}>{STATUS_LABEL[c.status]}</Chip>
            <div className="min-w-0 flex-1 basis-60">
              <p className="font-medium">{c.label}</p>
              <p className="mt-0.5 text-muted">{c.detail}</p>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
