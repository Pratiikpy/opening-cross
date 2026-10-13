'use client';

import { useEffect, useState } from 'react';
import { API_URL } from '../../lib/api';
import { type BadgeModel, type BadgeTone, type SafetyReport, badgeModel, fetchSafety } from '../../lib/safety';
import { shortAddress } from '../../lib/units';

// Tone -> classes, from the design tokens only (each pairing is in test/contrast.test.ts's token set).
const PILL: Record<BadgeTone, string> = {
  clear: 'border-positive bg-positive-bg text-positive',
  notice: 'border-border-strong bg-surface text-ink',
  halt: 'border-accent-text bg-surface text-accent-text',
  block: 'border-accent-text bg-accent-fill text-on-accent',
};
const MARK: Record<BadgeTone, string> = { clear: '✓', notice: 'i', halt: '!', block: '×' };

/**
 * What the issuer of this token can do, as a pill and an expandable list. Pass the `safety` field of the cross (or the
 * answer of /v1/tokens/:mint/safety); without a report it renders nothing, never a guess.
 */
export function SafetyBadge({ safety, label = 'Token safety' }: { safety: SafetyReport | null | undefined; label?: string }) {
  if (!safety) return null;
  const m = badgeModel(safety);
  return <Badge model={m} label={label} />;
}

function Badge({ model, label }: { model: BadgeModel; label: string }) {
  return (
    <section aria-label={label} className="text-sm" data-testid="safety-badge" data-tone={model.tone}>
      <p className="flex flex-wrap items-center gap-2">
        <span className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium ${PILL[model.tone]}`} data-testid="safety-label">
          <span aria-hidden="true" className="font-mono">{MARK[model.tone]}</span>
          {model.label}
        </span>
        <span className="text-muted" data-testid="safety-headline">{model.headline}</span>
      </p>
      {model.items.length > 0 ? (
        <details className="mt-2" open={model.tone === 'block' || model.tone === 'halt'}>
          <summary className="cursor-pointer text-muted underline underline-offset-2">What the issuer can do</summary>
          <ul className="mt-2 divide-y divide-border rounded-[var(--radius-card)] border border-border" data-testid="safety-items">
            {model.items.map((i) => (
              <li key={i.code} className="grid gap-1 p-3 sm:grid-cols-[14rem_1fr] sm:gap-4" data-level={i.level}>
                <span className="font-medium">
                  {i.title}
                  <span className="ml-2 font-mono text-xs font-normal text-muted">{i.levelLabel}</span>
                </span>
                <span className="text-muted">
                  {i.message}
                  {i.holder ? (
                    <>
                      {' '}
                      <span className="font-mono text-xs" title={i.holder}>Held by {shortAddress(i.holder)}</span>
                    </>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}

/** The badge for a mint the page only knows by address: reads the API itself. Shows nothing while loading or if the read fails. */
export function SafetyBadgeForMint({ mint, label }: { mint: string | null; label?: string }) {
  const [report, setReport] = useState<SafetyReport | null>(null);
  useEffect(() => {
    if (!mint) return;
    let live = true;
    fetchSafety(API_URL, mint).then((r) => live && setReport(r.ok ? r.data : null));
    return () => {
      live = false;
    };
  }, [mint]);
  return <SafetyBadge safety={report} {...(label && { label })} />;
}
