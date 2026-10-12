'use client';

import { useState } from 'react';
import { ActionError, type Signer, build, signSendConfirm } from '@/lib/tx';

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
};

/** Builds via the API, signs in the wallet, sends, confirms; shows each step and any refusal. */
export function ActionButton({ label, path, body, sign, onDone, onPartial, variant = 'primary', disabled, before }: Props) {
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busy = status !== null;
  return (
    <div className="space-y-2">
      <button
        type="button"
        disabled={busy || disabled}
        onClick={async () => {
          setError(null);
          setStatus('Preparing…');
          let built: Awaited<ReturnType<typeof build>> | null = null;
          try {
            before?.();
            built = await build(path, body());
            const sigs = await signSendConfirm(built.txs, sign, setStatus);
            onDone(sigs, built.extra);
          } catch (e) {
            if (built && e instanceof ActionError && e.completed > 0) onPartial?.(built.extra, e.completed, built.txs.length);
            setError(e instanceof ActionError ? e.message : `Something went wrong: ${e instanceof Error ? e.message : String(e)}`);
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
