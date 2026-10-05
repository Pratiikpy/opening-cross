// The Opening Bell mark from the design export: a bar crossed by one price line.
export function Logo({ className = '' }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2 font-semibold tracking-tight ${className}`}>
      <svg width="22" height="12" viewBox="0 0 22 12" aria-hidden="true">
        <rect x="0" y="5" width="22" height="2" fill="currentColor" />
        <rect x="7" y="0" width="8" height="12" fill="var(--accent)" />
      </svg>
      opening bell
    </span>
  );
}
