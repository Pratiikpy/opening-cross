import { REASON_TITLE, REASON_TONE, type Reason } from '@/lib/gate';

const TONE = {
  good: 'border-positive text-positive',
  warn: 'border-border-strong text-ink',
  block: 'border-accent text-accent-text',
} as const;

const MARK = { good: 'Passes', warn: 'Next step', block: 'Blocks' } as const;

/** Why a wallet is or is not eligible, one row per rule, in the program's terms and in plain words, with what would satisfy it. */
export function ReasonList({ reasons }: { reasons: Reason[] }) {
  return (
    <ul className="divide-y divide-border" data-testid="gate-reasons">
      {reasons.map((r) => {
        const tone = REASON_TONE[r.code];
        return (
          <li key={r.code} className="py-3" data-testid={`reason-${r.code}`}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="font-medium">{REASON_TITLE[r.code]}</p>
              <span className={`rounded-full border px-2.5 py-0.5 text-xs ${TONE[tone]}`}>{MARK[tone]}</span>
            </div>
            <p className="mt-1 text-muted">{r.message}</p>
            {r.fix ? (
              <p className="mt-1">
                <span className="text-muted">What would satisfy it: </span>
                <span className="break-words">{r.fix}</span>
              </p>
            ) : null}
            <p className="mt-1 break-words font-mono text-xs text-subtle">Rule: {r.rule}</p>
          </li>
        );
      })}
    </ul>
  );
}
