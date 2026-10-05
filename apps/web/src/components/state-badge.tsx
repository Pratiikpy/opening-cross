const LABEL: Record<string, string> = { Live: 'Live', Cleared: 'Cleared', NoPrint: 'Did not print', Finalized: 'Settled' };

export function StateBadge({ state, open }: { state: string; open?: boolean }) {
  const text = state === 'Live' ? (open ? 'Open for orders' : 'Closed, awaiting settlement') : (LABEL[state] ?? state);
  const live = state === 'Live' && open;
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs ${live ? 'border-accent text-accent-text' : 'border-border text-muted'}`}>
      {live ? <span className="size-1.5 rounded-full bg-accent" aria-hidden="true" /> : null}
      {text}
    </span>
  );
}
