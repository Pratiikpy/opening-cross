'use client';

import Link from 'next/link';
import { useState } from 'react';
import { isAddress } from '@solana/kit';

/** Opens a token's gate page. The address is only checked for shape here; the page reads the chain. */
export function GateFinder() {
  const [mint, setMint] = useState('');
  const m = mint.trim();
  const ok = isAddress(m);
  return (
    <form className="mt-8" onSubmit={(e) => e.preventDefault()} aria-labelledby="find-gate">
      <h2 id="find-gate" className="font-mono text-xs uppercase tracking-widest text-muted">
        Look up a token&apos;s gate
      </h2>
      <div className="mt-3 flex flex-col gap-3 sm:flex-row">
        <label className="sr-only" htmlFor="gate-mint">
          Token mint address
        </label>
        <input
          id="gate-mint"
          value={mint}
          onChange={(e) => setMint(e.target.value)}
          placeholder="Token mint address"
          autoComplete="off"
          spellCheck={false}
          aria-invalid={m !== '' && !ok}
          className="min-w-0 flex-1 rounded-[var(--radius-card)] border border-border-strong bg-bg px-4 py-2.5 font-mono text-sm"
          data-testid="gate-mint"
        />
        {ok ? (
          <Link href={`/gates/${m}`} className="rounded-full bg-accent-fill px-5 py-2.5 text-center text-sm font-medium text-on-accent" data-testid="gate-open">
            Open gate
          </Link>
        ) : (
          <span aria-disabled="true" className="rounded-full border border-border px-5 py-2.5 text-center text-sm text-muted" data-testid="gate-open-disabled">
            Open gate
          </span>
        )}
      </div>
      {m !== '' && !ok ? (
        <p role="alert" className="mt-2 text-sm text-accent-text" data-testid="gate-mint-invalid">
          That is not a Solana address.
        </p>
      ) : (
        <p className="mt-2 text-sm text-muted">Shows who may hold the token, what the issuer requires, and where your wallet stands.</p>
      )}
    </form>
  );
}
