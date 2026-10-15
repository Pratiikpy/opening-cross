'use client';

import { useMint } from '@/lib/use-read';
import { shortAddress } from '@/lib/units';
import type { GateState } from '../_lib/chain';
import { requirementLines, setupNotes } from '../_lib/gate-client';

/** What the gate requires of a holder, in plain words, from the rules the chain holds. */
export function RulesCard({ gate }: { gate: GateState }) {
  const { info: token } = useMint(gate.mint);
  const rules = gate.rules;
  return (
    <section aria-labelledby="rules" className="rounded-[var(--radius-card)] border border-border p-5 text-sm" data-testid="rules-card">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="rules" className="font-mono text-xs uppercase tracking-widest text-muted">
          Who may hold this token
        </h2>
        <span className="rounded-full border border-border px-2.5 py-0.5 text-xs text-muted" data-testid="gate-mode">
          {gate.mode === 'Allowlist' ? 'Pass required to receive' : 'Open to receive'}
        </span>
      </div>
      {rules ? (
        <>
          {(() => {
            const lines = requirementLines(rules, token ? { tokenDecimals: token.decimals, ...(token.symbol ? { tokenSymbol: token.symbol } : {}) } : {});
            return lines.length ? (
              <ul className="mt-3 list-disc space-y-1 pl-5" data-testid="requirements">
                {lines.map((l) => (
                  <li key={l}>{l}</li>
                ))}
              </ul>
            ) : (
              <p className="mt-3 text-muted">The rules add nothing beyond holding a pass.</p>
            );
          })()}
          <ul className="mt-3 list-disc space-y-1 pl-5 text-muted" data-testid="setup-notes">
            {setupNotes(rules, gate.mode).map((n) => (
              <li key={n}>{n}</li>
            ))}
            <li>Checked when a pass is issued and again on every transfer while the token keeps its transfer hook. A token moved to a pool that does not allow a hook keeps only the checks made when a pass is issued.</li>
          </ul>
        </>
      ) : (
        <p className="mt-3 text-muted" data-testid="no-rules">
          This gate has no compliance rules. Passes are granted by its authority
          {gate.allowlistRoot ? ', from a published allowlist' : ''}
          {gate.sas ? ' or from an attestation under a credential the issuer names' : ''}. Which wallets an offering may admit is the issuer&apos;s decision.
        </p>
      )}
      <dl className="mt-4 grid gap-x-4 gap-y-1 border-t border-border pt-3 text-xs sm:grid-cols-[max-content_1fr]">
        <dt className="text-muted">Gate authority</dt>
        <dd className="break-all font-mono" title={gate.authority}>
          {shortAddress(gate.authority)}
        </dd>
        {rules ? (
          <>
            <dt className="text-muted">Passes issued</dt>
            <dd data-testid="pass-count">{rules.maxPasses > 0 ? `${rules.passes} of ${rules.maxPasses}` : String(rules.passes)}</dd>
          </>
        ) : null}
      </dl>
    </section>
  );
}
