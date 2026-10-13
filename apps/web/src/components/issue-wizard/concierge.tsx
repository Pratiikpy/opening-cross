'use client';

import { useEffect, useState } from 'react';
import { type Step, type StepStatus, elapsed, nextStep } from '@/lib/issuer-concierge';
import { Chip, type ChipTone } from './fields';

const LABEL: Record<StepStatus, string> = { done: 'Done', current: 'Now', todo: 'To do', optional: 'Optional', later: 'Later', blocked: 'Blocked' };
const TONE: Record<StepStatus, ChipTone> = { done: 'ok', current: 'warn', todo: 'info', optional: 'info', later: 'info', blocked: 'block' };

/** The concierge: an ordered checklist of what stands between this draft and a cross on chain. It is not a chat and has no memory beyond the form. */
export function Concierge({ steps, openedMs, saved, onDiscard }: { steps: Step[]; openedMs: number; saved: boolean; onDiscard: () => void }) {
  const next = nextStep(steps);
  // Open on a wide screen, where it sits beside the form; closed on a narrow one, where it would push the form far down.
  const [open, setOpen] = useState(true);
  useEffect(() => {
    setOpen(window.matchMedia('(min-width: 1024px)').matches);
  }, []);
  const done = steps.filter((s) => s.status === 'done').length;
  const countable = steps.filter((s) => s.status !== 'later' && s.status !== 'optional').length;
  const body = (
    <>
      <p className="text-sm" data-testid="concierge-next">
        {next ? (
          <>
            <span className="text-muted">Next: </span>
            <a href={`#${next.anchor}`} className="font-medium underline underline-offset-4">
              {next.title}
            </a>
          </>
        ) : (
          <span className="font-medium">Nothing left before you create the cross.</span>
        )}
      </p>
      <p className="mt-1 text-xs text-muted" data-testid="concierge-meta">
        This draft was opened {elapsed(openedMs)} ago{saved ? ' and is saved in this browser only' : ''}.
      </p>
      <ol className="mt-4 space-y-3">
        {steps.map((s) => (
          <li key={s.id} data-testid={`step-${s.id}`} data-status={s.status} className="text-sm">
            <div className="flex items-start gap-3">
              <Chip tone={TONE[s.status]}>{LABEL[s.status]}</Chip>
              <div className="min-w-0 flex-1">
                <a href={`#${s.anchor}`} className="font-medium hover:underline">
                  {s.title}
                </a>
                {s.status === 'blocked' || s.id === next?.id ? <p className="mt-0.5 text-xs text-muted">{s.detail}</p> : null}
              </div>
            </div>
          </li>
        ))}
      </ol>
      <button type="button" onClick={onDiscard} className="mt-4 min-h-11 text-xs text-muted underline underline-offset-4">
        Discard this draft and start again
      </button>
    </>
  );
  return (
    <aside aria-label="Checklist" className="rounded-[var(--radius-card)] border border-border bg-bg" data-testid="concierge">
      <details open={open} onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
        <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 p-5 [&::-webkit-details-marker]:hidden">
          <span>
            <span className="block font-medium">Your checklist</span>
            <span className="mt-0.5 block text-xs text-muted">
              {done} of {countable} done{next ? ` · Next: ${next.title}` : ''}
            </span>
          </span>
          <span aria-hidden="true" className="text-muted">{open ? '−' : '+'}</span>
        </summary>
        <div className="px-5 pb-5">
          <p className="text-xs text-muted">A list, not a chat: each item is judged from your form and from the chain.</p>
          <div className="mt-3">{body}</div>
        </div>
      </details>
    </aside>
  );
}
