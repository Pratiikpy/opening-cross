import { useId } from 'react';
import type { ActionError, BuiltAction } from '@opening-cross/client';
import { useOpeningCross } from '../context.js';
import { type ActionResult, useAction } from '../hooks/use-action.js';

export type ActionButtonProps = {
  label: string;
  /** Builds the unsigned transactions. Called when the button is pressed; anything it throws is shown as the error. */
  action: () => Promise<BuiltAction>;
  /** Called with the signatures and the builder's extra facts once every transaction is confirmed. */
  onDone?: ((result: ActionResult) => void) | undefined;
  /** Called when a multi-transaction action stopped after some of its transactions had landed. */
  onPartial?: ((landed: number, total: number, error: ActionError) => void) | undefined;
  variant?: 'primary' | 'secondary' | undefined;
  disabled?: boolean | undefined;
  className?: string | undefined;
  testId?: string | undefined;
};

/** A button that builds, signs, sends and confirms one action, showing each step and any refusal. Needs a wallet in the provider. */
export function ActionButton({ label, action, onDone, onPartial, variant = 'primary', disabled, className, testId }: ActionButtonProps) {
  const { wallet } = useOpeningCross();
  const a = useAction();
  const errorId = useId();
  return (
    <div className={`oc-action${className ? ` ${className}` : ''}`}>
      <button
        type="button"
        className={`oc-button oc-button-${variant}`}
        disabled={a.busy || disabled || !wallet}
        aria-busy={a.busy}
        aria-describedby={a.error ? errorId : undefined}
        data-testid={testId}
        onClick={async () => {
          const outcome = await a.run(action);
          if (!outcome) return;
          if (outcome.ok) onDone?.(outcome);
          else if (outcome.partial) onPartial?.(outcome.partial.landed, outcome.partial.total, outcome.error);
        }}
      >
        {a.busy ? (a.status ?? 'Working…') : label}
      </button>
      <p className="oc-sr-only" role="status" aria-live="polite">
        {a.busy ? a.status : a.signatures ? `${label}: done.` : ''}
      </p>
      {a.error ? (
        <p id={errorId} role="alert" className="oc-error">
          {a.error.message}
          {a.partial ? ` ${a.partial.landed} of ${a.partial.total} transactions had already landed; check the cross before you try again.` : ''}
        </p>
      ) : null}
    </div>
  );
}
