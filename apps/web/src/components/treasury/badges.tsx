import { DISCLOSURE_LABEL, type DisclosureState } from '@/lib/treasury';

const TONE: Record<DisclosureState, string> = {
  current: 'border-positive text-positive',
  requested: 'border-accent text-accent-text',
  overdue: 'border-accent bg-accent-fill text-on-accent',
  closed: 'border-border text-muted',
  unknown: 'border-border text-muted',
};

export function DisclosureBadge({ state }: { state: DisclosureState }) {
  return <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium ${TONE[state]}`}>{DISCLOSURE_LABEL[state]}</span>;
}

export function TreasuryStateBadge({ state }: { state: 'Active' | 'Liquidating' | undefined }) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs ${state === 'Liquidating' ? 'border-accent text-accent-text' : 'border-border text-muted'}`}>
      {state === 'Active' ? <span className="size-1.5 rounded-full bg-positive" aria-hidden="true" /> : null}
      {state ?? 'Unreadable'}
    </span>
  );
}

export function NetworkTag({ network }: { network: string }) {
  return <span className="rounded-full border border-border-strong px-2 py-0.5 font-mono text-[11px] uppercase tracking-wider text-muted">{network}</span>;
}
