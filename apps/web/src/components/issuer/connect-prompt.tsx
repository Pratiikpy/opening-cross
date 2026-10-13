/** Shown where a page needs the issuer's wallet: what it will show, and where to connect. */
export function ConnectPrompt({ what }: { what: string }) {
  return (
    <p role="status" className="mt-8 rounded-[var(--radius-card)] border border-border p-5 text-sm text-muted" data-testid="connect-prompt">
      Connect the wallet you issue from to see {what}. Use Connect wallet at the top right. This page only reads public data for that wallet and asks for a signature only when you publish something.
    </p>
  );
}
