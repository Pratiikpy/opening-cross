'use client';

import { type ProgramKey, PROGRAM_NAMES, firstReleaseSentence, unknownReleaseSentence, useRelease } from '@/lib/issuer-programs';

/**
 * What the connected network runs, said before an action is offered. `what` names the feature in the sentence ("The treasury extension").
 * On the first release the actions below the notice are switched off by the page (see `IssuerAction`'s `needs`); on an unreadable program they
 * stay on and are simulated first.
 */
export function ProgramNotice({ which, what, className = '' }: { which: ProgramKey; what: string; className?: string }) {
  const r = useRelease(which);
  if (r.loading) {
    return (
      <p role="status" data-testid="program-notice" data-release="loading" className={`rounded-[var(--radius-card)] border border-border p-4 text-sm text-muted ${className}`}>
        Asking which release of {PROGRAM_NAMES[which]} this network runs…
      </p>
    );
  }
  if (r.release === 'extended') {
    return (
      <p role="status" data-testid="program-notice" data-release="extended" className={`rounded-[var(--radius-card)] border border-border p-4 text-sm text-muted ${className}`}>
        <span className="font-medium text-ink">Live on {r.network ?? 'this network'}.</span> {PROGRAM_NAMES[which]} has {what.toLowerCase()}; the actions below are signed by your wallet and land on chain.
      </p>
    );
  }
  if (r.release === 'first-release') {
    return (
      <div role="status" data-testid="program-notice" data-release="first-release" className={`rounded-[var(--radius-card)] border border-accent p-4 text-sm ${className}`}>
        <p className="font-medium">Not live on {r.network ?? 'this network'} yet</p>
        <p className="mt-1 text-muted">{firstReleaseSentence(what)}</p>
        <p className="mt-1 text-muted">You can still fill everything in and read exactly what would be signed. Signing is switched off until the program is upgraded.</p>
      </div>
    );
  }
  return (
    <p role="status" data-testid="program-notice" data-release="unknown" className={`rounded-[var(--radius-card)] border border-border-strong p-4 text-sm text-muted ${className}`}>
      <span className="font-medium text-ink">Release not confirmed. </span>
      {unknownReleaseSentence(what, r.unavailable ? 'unavailable' : r.notReported ? 'not-reported' : 'unread')}
    </p>
  );
}
