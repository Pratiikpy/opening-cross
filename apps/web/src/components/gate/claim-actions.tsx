'use client';

import { useSignMessage } from '@solana/react';
import type { UiWalletAccount } from '@wallet-standard/ui';
import { useEffect, useState } from 'react';
import { ActionButton } from '@/components/cross/action-button';
import { ATTESTER_URL, type AttesterInfo, type Claim, type Standing, bytesToBase64, loadAttester, loadChallenge, submitAttestation } from '@/lib/gate';
import type { Signer } from '@/lib/tx';

/** Asks the devnet test attester for an attestation: the wallet signs a short text that proves control of the wallet, nothing more. */
function AttestButton({ account, onDone }: { account: UiWalletAccount; onDone: () => void }) {
  const signMessage = useSignMessage(account);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  return (
    <div className="space-y-2">
      <button
        type="button"
        disabled={status !== null}
        data-testid="attest-button"
        onClick={async () => {
          setError(null);
          setDone(null);
          try {
            setStatus('Asking the attester…');
            const ch = await loadChallenge(account.address);
            if (!ch.ok) throw new Error(ch.error);
            setStatus('Waiting for your wallet…');
            const signed = await signMessage({ message: new TextEncoder().encode(ch.data.message) });
            setStatus('Writing the attestation…');
            const out = await submitAttestation(account.address, ch.data.issuedAt, bytesToBase64(new Uint8Array(signed.signature)));
            if (!out.ok) throw new Error(out.error);
            setDone(out.data.reused ? 'You already hold a current attestation.' : 'Attestation written. You can claim your pass now.');
            onDone();
          } catch (e) {
            setError(e instanceof Error && /reject|cancel|denied/i.test(e.message) ? 'You declined in your wallet. Nothing was sent.' : e instanceof Error ? e.message : String(e));
          } finally {
            setStatus(null);
          }
        }}
        className="w-full rounded-full border border-border-strong px-5 py-2.5 text-sm font-medium transition-colors hover:bg-surface disabled:opacity-50"
      >
        {status ?? 'Get a devnet test attestation'}
      </button>
      {done ? (
        <p role="status" className="text-sm text-positive">
          {done}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-accent-text">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * What the wallet can do about its standing: claim a pass when it qualifies, or, where the gate trusts the devnet test attester and
 * the wallet has no live attestation, get one. Every claim is built by the API and signed in the wallet.
 */
export function ClaimActions({
  mint,
  account,
  sign,
  claim,
  sas,
  onChanged,
}: {
  mint: string;
  account: UiWalletAccount;
  sign: Signer;
  claim: Claim | null;
  sas: Standing['sas'] | undefined;
  onChanged: () => void;
}) {
  const [attester, setAttester] = useState<AttesterInfo | null>(null);
  useEffect(() => {
    let live = true;
    if (ATTESTER_URL) void loadAttester().then((r) => live && r.ok && setAttester(r.data));
    return () => {
      live = false;
    };
  }, []);
  const needsAttestation = !!sas?.configured && sas.state !== 'live';
  const attesterIsTrusted = !!attester && !!sas && attester.credential === sas.credential && attester.schema === sas.schema;
  const canSignMessage = account.features.includes('solana:signMessage');
  return (
    <div className="space-y-3" data-testid="claim-actions">
      {claim ? (
        <ActionButton
          label={claim.route === 'allowlist' ? 'Claim pass with allowlist proof' : 'Claim pass with attestation'}
          path={claim.endpoint}
          body={() => claim.body}
          sign={sign}
          onDone={() => onChanged()}
        />
      ) : null}
      {needsAttestation && attesterIsTrusted ? (
        canSignMessage ? (
          <>
            <AttestButton account={account} onDone={onChanged} />
            <p className="text-xs text-muted">{attester!.label}. It checks that you control this wallet by having you sign a short text. It does not check who you are.</p>
          </>
        ) : (
          <p className="text-sm text-muted">This wallet cannot sign messages, which the devnet test attester needs. Use a wallet that supports it.</p>
        )
      ) : null}
      <span className="sr-only">{mint}</span>
    </div>
  );
}
