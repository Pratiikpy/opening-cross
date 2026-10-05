'use client';

import type { Signer } from '@/lib/tx';
import type { CrossDetail } from '@/lib/types';
import { ActionButton } from './action-button';

export function SettlePanel({ cross, payer, sign, onDone }: { cross: CrossDetail; payer: string; sign: Signer; onDone: () => void }) {
  return (
    <section aria-labelledby="settle" className="rounded-[var(--radius-card)] border border-border p-5">
      <h2 id="settle" className="font-medium">
        Ready to settle
      </h2>
      <p className="mt-1 text-sm text-muted">
        The call is closed. Settling merges the book and finds the clearing price. Anyone may do it; you pay only the network fee, and no funds
        move to you.
      </p>
      <div className="mt-4">
        <ActionButton label="Settle this cross" path="/v1/tx/settle" body={() => ({ cross: cross.address, payer })} sign={sign} onDone={onDone} variant="secondary" />
      </div>
    </section>
  );
}
