'use client';

import { useState } from 'react';
import { type Built, type RunOptions, buildReasoned, failureText } from '@/lib/holder-tx';
import { ActionError, type Signer, signSendConfirm } from '@/lib/tx';

type Props = {
  label: string;
  path: string;
  body: () => unknown;
  sign: Signer;
  onDone: (signatures: string[], extra: Record<string, unknown>) => void;
  /** Called when a multi-transaction action failed after some of its transactions had already landed. */
  onPartial?: (extra: Record<string, unknown>, landed: number, total: number) => void;
  variant?: 'primary' | 'secondary';
  disabled?: boolean;
  /** Runs before anything is built; throw an ActionError to stop with a message. */
  before?: () => void;
  /** Runs on the unsigned answer, before the wallet is asked; throw an ActionError to stop. */
  inspect?: (built: Built) => void;
  /** Hold the build until the window an order lands in has changed, when it is about to (orders in an ending period). */
  hold?: RunOptions['holdIfEndsWithin'];
  /** Extra text the test harness can find the button by. */
  testId?: string;
};

/** Builds via the API, signs in the wallet, sends, confirms; shows each step and any refusal, with the program's rule errors in plain words. */
export function ActionButton({ label, path, body, sign, onDone, onPartial, variant = 'primary', disabled, before, inspect, hold, testId }: Props) {
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busy = status !== null;
  return (
    <div className="space-y-2">
      <button
        type="button"
        disabled={busy || disabled}
        data-testid={testId}
        onClick={async () => {
          setError(null);
          setStatus('Preparing…');
          let built: Built | null = null;
          try {
            before?.();
            built = await buildReasoned(path, body());
            if (hold) {
              const until = hold.validUntil(built);
              if (until !== null && until - hold.now() <= BigInt(hold.secs)) {
                for (let s = Number(until - hold.now()) + 2; s > 0; s--) {
                  setStatus(`The ending window changes in a moment; building again in ${s}s…`);
                  await new Promise((r) => setTimeout(r, 1000));
                }
                built = await buildReasoned(path, body());
              }
            }
            inspect?.(built);
            const sigs = await signSendConfirm(built.txs, sign, setStatus);
            onDone(sigs, built.extra);
          } catch (e) {
            if (built && e instanceof ActionError && e.completed > 0) onPartial?.(built.extra, e.completed, built.txs.length);
            setError(failureText(e));
          } finally {
            setStatus(null);
          }
        }}
        className={
          variant === 'primary'
            ? 'w-full rounded-full bg-accent-fill px-5 py-3 text-sm font-medium text-on-accent transition-opacity hover:opacity-90 disabled:opacity-50'
            : 'w-full rounded-full border border-border-strong px-5 py-2.5 text-sm font-medium transition-colors hover:bg-surface disabled:opacity-50'
        }
      >
        {status ?? label}
      </button>
      {error ? (
        <p role="alert" className="text-sm text-accent-text">
          {error}
        </p>
      ) : null}
    </div>
  );
}
