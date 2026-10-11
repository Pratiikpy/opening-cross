const LABEL: Record<string, string> = { Live: 'Live', Cleared: 'Cleared', NoPrint: 'Did not print', Finalized: 'Settled' };

/** What a live cross is doing right now, by its clock. `open` is kept for callers that only know whether it is taking orders. */
type LivePhase = 'upcoming' | 'open' | 'reveal' | 'awaiting-settlement';
const LIVE_LABEL: Record<LivePhase, string> = {
  upcoming: 'Opens soon',
  open: 'Open for orders',
  reveal: 'Revealing bids',
  'awaiting-settlement': 'Closed, awaiting settlement',
};

export function StateBadge({ state, open, phase }: { state: string; open?: boolean; phase?: LivePhase }) {
  const live = state === 'Live' && (phase ? phase === 'open' : Boolean(open));
  const text = state === 'Live' ? LIVE_LABEL[phase ?? (open ? 'open' : 'awaiting-settlement')] : (LABEL[state] ?? state);
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs ${live ? 'border-accent text-accent-text' : 'border-border text-muted'}`}>
      {live ? <span className="size-1.5 rounded-full bg-accent" aria-hidden="true" /> : null}
      {text}
    </span>
  );
}
