'use client';

import type { Autofill, Suggestion } from '@opening-cross/presets/launch';
import { SmallButton } from './fields';

const FIELD_LABEL: Record<Suggestion['field'], string> = { supplyMode: 'Supply', presetId: 'Format', listingType: 'Listing type' };
const VALUE_LABEL: Record<string, string> = { mint: 'Minted at settlement', escrow: 'Sell orders from escrow' };

/** What the chain says about the token, and the suggestions that follow from it. Nothing is applied until the issuer presses Apply. */
export function AutofillPanel({ autofill, onApply, names }: { autofill: Autofill; onApply: (s: Suggestion[]) => void; names: (s: Suggestion) => string }) {
  return (
    <div className="rounded-lg border border-border bg-surface p-4 text-sm" data-testid="autofill">
      <p className="font-medium">Read from the chain</p>
      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-muted">
        {autofill.facts.map((f) => (
          <li key={f}>{f}</li>
        ))}
      </ul>
      {autofill.blockers.length > 0 ? (
        <ul role="alert" className="mt-3 space-y-1 text-accent-text" data-testid="autofill-blockers">
          {autofill.blockers.map((b) => (
            <li key={b}>{b}</li>
          ))}
        </ul>
      ) : null}
      {autofill.notes.length > 0 ? (
        <ul className="mt-3 space-y-1 text-muted">
          {autofill.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      ) : null}
      {autofill.suggestions.length > 0 ? (
        <div className="mt-4">
          <p className="font-medium">Suggested for this token</p>
          <ul className="mt-2 space-y-2">
            {autofill.suggestions.map((s) => (
              <li key={s.field} className="text-muted">
                <span className="text-ink">
                  {FIELD_LABEL[s.field]}: {VALUE_LABEL[s.value] ?? names(s)}
                </span>{' '}
                because {s.because}.
              </li>
            ))}
          </ul>
          <div className="mt-3">
            <SmallButton testId="autofill-apply" onClick={() => onApply(autofill.suggestions)}>
              Apply these suggestions
            </SmallButton>
          </div>
        </div>
      ) : null}
    </div>
  );
}
