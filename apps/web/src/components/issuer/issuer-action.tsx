'use client';

import type { UiWalletAccount } from '@wallet-standard/ui';
import { useState } from 'react';
import { useSigner } from '@/components/cross/use-signer';
import { ActionError, type Signer, type Unsigned, build, signSendConfirm } from '@/lib/tx';
import { type ProgramKey, PROGRAM_NAMES, dryRun, firstReleaseSentence, knownPrograms, useRelease } from '@/lib/issuer-programs';
import { shortAddress } from '@/lib/units';

type Props = {
  label: string;
  /** An API path: the unsigned transaction is built there. */
  path: string;
  body: () => unknown | Promise<unknown>;
  sign: Signer;
  /** The program release the action needs. On the first release the button is off and says why; on an unreadable one it stays on and is simulated. */
  needs?: ProgramKey | undefined;
  /** What the feature is called in the sentence that explains why the button is off ("The treasury extension"). */
  what?: string | undefined;
  disabled?: boolean | undefined;
  /** Why the button is off, when the page knows. */
  disabledReason?: string | undefined;
  /** Transactions already sent in an earlier attempt; the rest are sent. */
  skip?: number | undefined;
  /** Adds a signature a fresh keypair must give before the wallet signs (a limit order account). */
  cosign?: ((tx: Uint8Array) => Promise<Uint8Array>) | undefined;
  variant?: 'primary' | 'secondary';
  testId?: string | undefined;
  onDone: (signatures: string[], extra: Record<string, unknown>) => void;
  /** Called with what the API answered, before anything is signed. */
  onBuilt?: ((extra: Record<string, unknown>, txs: Unsigned[]) => void) | undefined;
  /** A multi-transaction action failed after some of it had landed. */
  onPartial?: ((extra: Record<string, unknown>, landed: number, total: number) => void) | undefined;
};

/**
 * Builds the unsigned transaction through the API, simulates it on the cluster, asks the wallet to sign, sends it and waits for it to confirm.
 * Every refusal is shown in words: the API's reason, the program's, or the cluster's. Nothing is signed when the dry run fails.
 */
export function IssuerAction({ label, path, body, sign, needs, what, disabled, disabledReason, skip = 0, cosign, variant = 'primary', testId, onDone, onBuilt, onPartial }: Props) {
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string[] | null>(null);
  const release = useRelease(needs ?? 'crossCore');
  const firstRelease = needs !== undefined && release.release === 'first-release';
  const off = Boolean(disabled) || firstRelease || status !== null;
  const reason = firstRelease ? firstReleaseSentence(what ?? `This action of ${PROGRAM_NAMES[needs]}`) : disabledReason;
  const known = knownPrograms(release.programs);
  const click = async () => {
    setError(null);
    setDone(null);
    setStatus('Preparing…');
    let built: Awaited<ReturnType<typeof build>> | null = null;
    try {
      built = await build(path, await body());
      onBuilt?.(built.extra, built.txs);
      const txs = built.txs.slice(skip);
      if (txs.length === 0) throw new ActionError('The API built nothing to sign.');
      setStatus('Checking with the cluster…');
      const sim = await dryRun(txs[0]!.transaction, known, needs ? PROGRAM_NAMES[needs] : undefined);
      if (sim.ok === false) throw new ActionError(sim.message);
      const signer: Signer = cosign ? async ({ transaction }) => sign({ transaction: await cosign(transaction) }) : sign;
      const sigs = await signSendConfirm(txs, signer, setStatus);
      setDone(sigs);
      onDone(sigs, built.extra);
    } catch (e) {
      if (built && e instanceof ActionError && e.completed > 0) onPartial?.(built.extra, e.completed + skip, built.txs.length);
      setError(e instanceof ActionError ? e.message : `Something went wrong: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setStatus(null);
    }
  };
  return (
    <div className="space-y-2">
      <button
        type="button"
        disabled={off}
        onClick={() => void click()}
        {...(testId ? { 'data-testid': testId } : {})}
        className={
          variant === 'primary'
            ? 'min-h-11 w-full rounded-full bg-accent-fill px-5 py-3 text-sm font-medium text-on-accent transition-opacity hover:opacity-90 disabled:opacity-50'
            : 'min-h-11 w-full rounded-full border border-border-strong px-5 py-2.5 text-sm font-medium transition-colors hover:bg-surface disabled:opacity-50'
        }
      >
        {status ?? label}
      </button>
      {reason && (disabled || firstRelease) ? (
        <p className="text-xs text-muted" data-testid={testId ? `${testId}-reason` : undefined}>
          {reason}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-accent-text" data-testid={testId ? `${testId}-error` : undefined}>
          {error}
        </p>
      ) : null}
      {done ? (
        <p role="status" className="text-xs text-muted" data-testid={testId ? `${testId}-done` : undefined}>
          Confirmed on chain{done.length > 1 ? ` (${done.length} transactions)` : ''}: <span className="font-mono">{done.map((s) => shortAddress(s)).join(', ')}</span>
        </p>
      ) : null}
    </div>
  );
}

type WalletActionProps = Omit<Props, 'sign'> & { account: UiWalletAccount | null };

/** An `IssuerAction` for whoever is connected; with no wallet the button is off and says what to do. */
export function WalletAction({ account, ...rest }: WalletActionProps) {
  if (!account) {
    return (
      <div className="space-y-2">
        <button type="button" disabled data-testid={rest.testId} className="min-h-11 w-full rounded-full border border-border-strong px-5 py-2.5 text-sm font-medium opacity-50">
          {rest.label}
        </button>
        <p className="text-xs text-muted">Connect the wallet you issue from to sign this.</p>
      </div>
    );
  }
  return <Connected account={account} {...rest} />;
}

function Connected({ account, ...rest }: WalletActionProps & { account: UiWalletAccount }) {
  const sign = useSigner(account);
  return <IssuerAction {...rest} sign={sign} />;
}
