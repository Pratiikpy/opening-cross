import { KIND_LABEL, type CardKind, type RightsCard } from '@/lib/treasury';

const SECTIONS: { kinds: CardKind[]; title: string; lead: string }[] = [
  { kinds: ['protects', 'entitles'], title: 'What the program enforces', lead: 'Each rule below is code in the deployed treasury program. The chips name the instruction and the error it fails with when the rule is broken.' },
  { kinds: ['not-provided'], title: 'What it does not provide', lead: 'Things a holder might assume. The program has no instruction for any of them.' },
  { kinds: ['caveat'], title: 'Caveat', lead: '' },
];

function Card({ card }: { card: RightsCard }) {
  return (
    <li className="flex min-w-0 flex-col gap-3 rounded-[var(--radius-card)] border border-border bg-surface p-5 [overflow-wrap:anywhere]">
      <div>
        <p className="font-mono text-[11px] uppercase tracking-wider text-muted">{KIND_LABEL[card.kind]}</p>
        <h4 className="mt-1 text-[17px] font-semibold leading-snug">{card.title}</h4>
      </div>
      <p className="text-sm text-muted">{card.statement}</p>
      {card.now ? (
        <p className="rounded-lg border border-border bg-bg px-3 py-2 text-sm">
          <span className="font-medium">Now: </span>
          {card.now}
        </p>
      ) : null}
      {card.enforcedBy.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5" aria-label="Enforced by">
          {card.enforcedBy.map((e) => (
            <li key={`${e.instruction}:${e.error ?? e.rule}`} title={e.rule} className="rounded-md border border-border-strong px-2 py-0.5 font-mono text-xs">
              {e.instruction}
              {e.error ? ` → ${e.error}` : ' (calculation)'}
            </li>
          ))}
        </ul>
      ) : null}
      {card.absence ? <p className="text-xs text-muted">Why: {card.absence}</p> : null}
    </li>
  );
}

export function RightsCards({ cards }: { cards: RightsCard[] }) {
  return (
    <section aria-labelledby="rights" className="mt-14">
      <h2 id="rights" className="text-2xl font-semibold tracking-tight">Rights cards</h2>
      <p className="mt-2 max-w-2xl text-sm text-muted">
        What holding this coin does and does not give you, derived only from what the treasury program enforces. Nothing here is a promise by the team.
      </p>
      {SECTIONS.map((s) => {
        const list = cards.filter((c) => s.kinds.includes(c.kind));
        if (list.length === 0) return null;
        return (
          <div key={s.title} className="mt-8">
            <h3 className="text-lg font-semibold">{s.title}</h3>
            {s.lead ? <p className="mt-1 max-w-2xl text-sm text-muted">{s.lead}</p> : null}
            <ul className="mt-4 grid gap-4 md:grid-cols-2">
              {list.map((c) => (
                <Card key={c.id} card={c} />
              ))}
            </ul>
          </div>
        );
      })}
    </section>
  );
}
