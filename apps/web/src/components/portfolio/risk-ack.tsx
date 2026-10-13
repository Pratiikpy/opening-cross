'use client';

import { useEffect, useId, useState } from 'react';
import { RISK_POINTS, acknowledge, hasAcknowledged } from '@/lib/risk-ack';

/**
 * Whether this wallet has accepted the risks on this device. `null` until the browser has been asked, so a button never enables
 * on a guess. Accepting is remembered in this browser only.
 */
export function useRiskAck(owner: string): { acknowledged: boolean | null; accept: () => void } {
  const [acknowledged, setAcknowledged] = useState<boolean | null>(null);
  useEffect(() => setAcknowledged(hasAcknowledged(owner)), [owner]);
  return {
    acknowledged,
    accept: () => {
      acknowledge(owner);
      // Accepted for this order even where the browser would not remember it.
      setAcknowledged(true);
    },
  };
}

/** The one-time step before a wallet's first order on this device: four plain statements and a checkbox. Renders nothing once accepted. */
export function RiskAck({ acknowledged, accept }: { acknowledged: boolean | null; accept: () => void }) {
  const id = useId();
  if (acknowledged === true) return <p className="mt-4 text-xs text-muted">You accepted the risks for this wallet on this device.</p>;
  if (acknowledged === null) return null;
  return (
    <div className="mt-4 rounded-lg border border-border-strong p-3 text-sm" data-testid="risk-ack">
      <p className="font-medium" id={`${id}-t`}>
        Before your first order
      </p>
      <ul className="mt-2 list-disc space-y-1.5 pl-5 text-muted">
        {RISK_POINTS.map((p) => (
          <li key={p}>{p}</li>
        ))}
      </ul>
      <label className="mt-3 flex min-h-6 cursor-pointer items-start gap-3 py-1">
        <input type="checkbox" className="mt-0.5 size-6 shrink-0 cursor-pointer accent-[var(--accent-fill)]" onChange={(e) => e.target.checked && accept()} aria-describedby={`${id}-t`} />
        <span>I have read this and I understand the risks</span>
      </label>
    </div>
  );
}
