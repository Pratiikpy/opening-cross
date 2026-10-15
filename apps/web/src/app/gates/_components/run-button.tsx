'use client';

import type { UiWalletAccount } from '@wallet-standard/ui';
import { useState } from 'react';
import { useSigner } from '@/components/cross/use-signer';
import { explorerTx } from '@/lib/treasury';
import { ActionError, signSendConfirm } from '@/lib/tx';
import { failureText } from '@/lib/holder-tx';
import type { Instruction } from '@solana/kit';
import { unsignedTransaction } from '../_lib/unsigned';

type Props = {
  account: UiWalletAccount;
  label: string;
  /** Builds the instructions when the button is pressed, so they reflect the form as it is then. May throw an Error whose message is shown. */
  build: () => Promise<Instruction[]>;
  onDone?: (signatures: string[]) => void;
  disabled?: boolean;
  variant?: 'primary' | 'secondary';
  testId?: string;
};

/** Builds one transaction from gate-client instructions, has the wallet sign it, lands it and says what happened. */
export function RunButton({ account, label, build, onDone, disabled, variant = 'primary', testId }: Props) {
  const sign = useSigner(account);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [landed, setLanded] = useState<string[]>([]);
  return (
    <div className="space-y-2">
      <button
        type="button"
        disabled={status !== null || disabled}
        data-testid={testId}
        onClick={async () => {
          setError(null);
          setLanded([]);
          setStatus('Preparing…');
          try {
            const instructions = await build();
            const tx = await unsignedTransaction(instructions, account.address);
            const sigs = await signSendConfirm([tx], sign, setStatus);
            setLanded(sigs);
            onDone?.(sigs);
          } catch (e) {
            setError(e instanceof ActionError ? failureText(e) : e instanceof Error ? e.message : 'Something went wrong. Nothing was sent.');
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
      {landed.length ? (
        <p role="status" className="text-sm text-positive" data-testid={testId ? `${testId}-done` : undefined}>
          Done.{' '}
          <a href={explorerTx(landed[0]!)} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">
            View the transaction
          </a>
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-accent-text" data-testid={testId ? `${testId}-error` : undefined}>
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** A labelled text field in the page's style. */
export function Field({ id, label, value, onChange, placeholder, mono, hint, type = 'text' }: { id: string; label: string; value: string; onChange: (v: string) => void; placeholder?: string; mono?: boolean; hint?: string; type?: string }) {
  return (
    <div>
      <label htmlFor={id} className="block text-xs text-muted">
        {label}
      </label>
      <input
        id={id}
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        data-testid={id}
        className={`mt-1 w-full rounded-[var(--radius-card)] border border-border-strong bg-bg px-3 py-2 ${mono ? 'font-mono text-xs' : 'text-sm'}`}
      />
      {hint ? <p className="mt-1 text-xs text-muted">{hint}</p> : null}
    </div>
  );
}
