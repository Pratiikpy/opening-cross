'use client';

import { useEffect, useState } from 'react';
import { API_URL } from '@/lib/api';
import type { AuthenticityVerdict, AuthenticityView, VerdictClass } from '@/lib/trust-types';
import { shortAddress } from '@/lib/units';

const LABEL: Record<VerdictClass, string> = {
  GENUINE: "Matches the issuer's list and keys",
  FAMILY_UNLISTED: "Held by the issuer's keys, not yet on its list",
  IMPERSONATOR: 'Copies a genuine token and is not it',
  ADDRESS_LOOKALIKE: 'Address made to look like a genuine token',
  UNVERIFIED_STOCK_TOKEN: 'Tokenized stock from an issuer we cannot verify',
  UNRELATED_TOKEN: 'Not a covered issuer token',
  NOT_A_MINT: 'Not a token mint',
  UNKNOWN: 'Could not be confirmed',
};
const BAD = new Set<VerdictClass>(['IMPERSONATOR', 'ADDRESS_LOOKALIKE', 'NOT_A_MINT']);

function Row({ role, v }: { role: string; v: AuthenticityVerdict }) {
  const tone = v.verdict === 'GENUINE' ? 'border-positive text-positive' : BAD.has(v.verdict) ? 'border-accent text-accent-text' : 'border-border text-muted';
  const name = v.listing ? v.listing.symbol : (v.observed.symbol ?? shortAddress(v.mint));
  const copied = v.impersonates[0];
  return (
    <li className="py-3" data-testid={`identity-${role.toLowerCase()}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p>
          <span className="text-muted">{role}</span> <span className="font-medium">{name}</span> <span className="font-mono text-xs text-muted">{shortAddress(v.mint)}</span>
        </p>
        <span className={`rounded-full border px-2.5 py-0.5 text-xs ${tone}`}>{LABEL[v.verdict]}</span>
      </div>
      {v.verdict !== 'GENUINE' && v.reasons[0] ? <p className="mt-1 text-muted">{v.reasons[0].message}</p> : null}
      {copied ? (
        <p className="mt-1 text-muted">
          The real {copied.symbol} is <span className="break-all font-mono">{copied.mint}</span>.
        </p>
      ) : null}
    </li>
  );
}

/** "Is this real?" for both tokens of a cross, from the issuers' own lists and the chain. Mainnet mints only. */
export function IdentityPanel({ address, initial = null }: { address: string; initial?: AuthenticityView | null }) {
  const [a, setA] = useState<AuthenticityView | null>(initial);
  useEffect(() => {
    // The server's read is the first paint; the browser then asks again, so a result the server missed or that has changed
    // replaces it. A failed read keeps what is already shown.
    let live = true;
    fetch(`${API_URL}/v1/crosses/${address}/authenticity`, { cache: 'no-store' })
      .then((r) => (r.ok ? (r.json() as Promise<AuthenticityView>) : null))
      .then((v) => live && v && setA(v))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [address]);
  if (!a) return null;
  if (!a.comparable) {
    return (
      <p className="px-1 text-xs text-muted" data-testid="identity-not-comparable">
        Identity check: {a.note}
      </p>
    );
  }
  return (
    <section aria-labelledby="identity" className="rounded-[var(--radius-card)] border border-border p-5 text-sm" data-testid="identity-panel">
      <h2 id="identity" className="font-mono text-xs uppercase tracking-widest text-muted">
        Is this real?
      </h2>
      <ul className="mt-1 divide-y divide-border">
        {a.base ? <Row role="Token" v={a.base.verdict} /> : null}
        <Row role="Quote" v={a.quote.verdict} />
      </ul>
      <p className="mt-2 text-xs text-muted">Checked against the issuers' own lists and the keys on chain (registry of {a.registry.generatedAt.slice(0, 10)}). It says who issued a token, not whether it is a good buy.</p>
    </section>
  );
}
