// Decision 5: anything that is not live data is visibly labelled.
export function ExampleTag({ children }: { children: React.ReactNode }) {
  return <span className="rounded-full border border-border-strong px-2 py-0.5 font-mono text-[11px] uppercase tracking-wider text-muted">{children}</span>;
}
