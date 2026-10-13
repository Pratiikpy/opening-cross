'use client';

import type { RulesRead } from '@/lib/holder-rules';
import type { Signer } from '@/lib/tx';
import type { CrossDetail } from '@/lib/types';
import { ActionButton } from './action-button';

const PURPOSE: Record<'end' | 'extension', string> = {
  end: 'This cross’s rules draw which ending window is the last that counts (or a lottery for the contested volume). The draw has to finish before the cross can be settled.',
  extension: 'The cross did not print and its rules allow one extension. A draw sets how long the call reopens; it has to finish before anything else happens.',
};

export function SettlePanel({ cross, payer, sign, onDone, rules }: { cross: CrossDetail; payer: string; sign: Signer; onDone: () => void; rules?: RulesRead | null | undefined }) {
  const owed = rules?.calls?.drawOwed ?? null;
  const status = rules?.calls?.drawStatus ?? 'not-begun';
  if (owed) {
    const begin = status === 'not-begun' || status === 'void';
    return (
      <section aria-labelledby="settle" className="rounded-[var(--radius-card)] border border-border p-5" data-testid="draw-panel">
        <h2 id="settle" className="font-medium">
          A draw comes before settlement
        </h2>
        <p className="mt-1 text-sm text-muted">{PURPOSE[owed]}</p>
        <p className="mt-2 text-sm text-muted">
          The draw is the cluster’s own block hashes, not a verifiable random function: four hashes from different leaders’ turns are combined, so no single block producer decides it. Anyone may send either step; you pay only the network fee.
          {status === 'void' ? ' The block hashes needed for the last attempt are no longer available, so it has to begin again.' : ''}
        </p>
        <div className="mt-4 space-y-3">
          {begin ? (
            <ActionButton label="Begin the draw" path="/v1/tx/draw-begin" body={() => ({ cross: cross.address, payer })} sign={sign} onDone={onDone} variant="secondary" testId="draw-begin" />
          ) : (
            <>
              <p className="text-sm" data-testid="draw-status">
                {status === 'waiting' ? 'The draw has begun. It can finish about twenty slots (around eight seconds) after it began.' : status === 'ready' ? 'The draw can finish now.' : 'A draw is under way.'}
              </p>
              <ActionButton label="Finish the draw" path="/v1/tx/draw-finish" body={() => ({ cross: cross.address, payer })} sign={sign} onDone={onDone} variant="secondary" testId="draw-finish" />
            </>
          )}
        </div>
      </section>
    );
  }
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
        <ActionButton label="Settle this cross" path="/v1/tx/settle" body={() => ({ cross: cross.address, payer })} sign={sign} onDone={onDone} variant="secondary" testId="settle" />
      </div>
    </section>
  );
}
