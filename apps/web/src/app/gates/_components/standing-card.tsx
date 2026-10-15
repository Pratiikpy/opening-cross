'use client';

import { useSignMessage } from '@solana/react';
import type { UiWalletAccount } from '@wallet-standard/ui';
import { useCallback, useEffect, useState } from 'react';
import { useWallet } from '@/lib/wallet';
import { type Attestation, KYC_ATTESTER_URL, identityChallenge, requestAttestation } from '../_lib/attester';
import type { GateState } from '../_lib/chain';
import { type Diagnosis, TIER_NAME, claimPassAttested, countryName, diagnoseEligibility } from '../_lib/gate-client';
import { clusterNow, readAccounts } from '../_lib/rpc';
import { walletSigner } from '../_lib/unsigned';
import { Notice } from './notice';
import { RunButton } from './run-button';

/** Reasons that mean the provider has nothing on record for the wallet: the cure is to ask the attester. */
const NEEDS_ATTESTATION = new Set(['NO_ATTESTATION', 'ATTESTATION_EXPIRED']);
/** Reasons the attester gives that a person fixes with the identity provider, not here. */
const AT_PROVIDER = new Set(['NO_APASS', 'APASS_FROZEN', 'APASS_EXPIRED', 'NO_COUNTRY', 'AMBIGUOUS_COUNTRY', 'UNKNOWN_COUNTRY', 'APASS_NOT_LINKED']);
const PROVIDER_URL = process.env.NEXT_PUBLIC_KYC_PROVIDER_URL ?? '';

/** What the verify step shows: the attester's answer, or that the person declined to sign. */
type Shown = Attestation | { kind: 'declined' };

type Load = { phase: 'loading' } | { phase: 'error'; message: string } | { phase: 'ready'; d: Diagnosis };

/** Where this wallet stands under the gate, why not if it does not qualify, and the next step: record the verification, then claim the pass. */
export function StandingCard({ gate }: { gate: GateState }) {
  const { account } = useWallet();
  return (
    <section aria-labelledby="standing" className="rounded-[var(--radius-card)] border border-border p-5 text-sm" data-testid="standing-card">
      <h2 id="standing" className="font-mono text-xs uppercase tracking-widest text-muted">
        Your wallet
      </h2>
      {!gate.rules ? (
        <p className="mt-3 text-muted">This gate has no compliance rules, so there is no standing to check here. Its authority grants passes directly or from an allowlist.</p>
      ) : !account ? (
        <p className="mt-3 text-muted" data-testid="standing-connect">
          Connect a wallet to see whether it meets the rules. Connecting does not send anything on chain.
        </p>
      ) : (
        <Standing gate={gate} account={account} />
      )}
    </section>
  );
}

function Standing({ gate, account }: { gate: GateState; account: UiWalletAccount }) {
  const [load, setLoad] = useState<Load>({ phase: 'loading' });
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const d = await diagnoseEligibility({ mint: gate.mint as never, wallet: account.address as never, now: await clusterNow(), read: readAccounts });
        if (live) setLoad({ phase: 'ready', d });
      } catch (e) {
        if (live) setLoad({ phase: 'error', message: e instanceof Error ? e.message : 'The chain could not be read.' });
      }
    })();
    return () => {
      live = false;
    };
  }, [gate.mint, account.address, tick]);

  if (load.phase === 'loading') return <p role="status" className="mt-3 text-muted">Checking your wallet…</p>;
  if (load.phase === 'error') {
    return (
      <div className="mt-3">
        <Notice tone="warn" title="Your standing could not be read" alert>
          {load.message}
        </Notice>
      </div>
    );
  }
  const d = load.d;
  if (d.eligible) {
    return (
      <div className="mt-3">
        <Notice tone="success" title="You hold a pass" testId="pass-held">
          Your wallet meets the issuer&apos;s rules and may take part in crosses of this token and receive it.
        </Notice>
      </div>
    );
  }
  const asksAttester = d.reasons.some((r) => NEEDS_ATTESTATION.has(r.code)) || (!d.hasPass && d.identity === null);
  return (
    <div className="mt-3 space-y-4">
      {d.reasons.length ? (
        <Notice tone="warn" title={d.hasPass ? 'Your pass no longer meets the rules' : 'You cannot hold a pass yet'} testId="standing-reasons">
          <ul className="space-y-1">
            {d.reasons.map((r) => (
              <li key={r.code} data-reason={r.code}>
                {r.message}
              </li>
            ))}
          </ul>
        </Notice>
      ) : null}
      {d.identity ? (
        <p className="text-muted" data-testid="standing-record">
          Recorded for this wallet: {d.identity.country ? `${countryName(d.identity.country) ?? `country ${d.identity.country}`}, ` : ''}tier {TIER_NAME[d.identity.tier] ?? d.identity.tier}.
        </p>
      ) : null}
      {d.canClaim ? <Claim gate={gate} account={account} d={d} onDone={reload} /> : null}
      {!d.canClaim && asksAttester ? <Verify gate={gate} account={account} onDone={reload} /> : null}
    </div>
  );
}

function Claim({ gate, account, d, onDone }: { gate: GateState; account: UiWalletAccount; d: Diagnosis; onDone: () => void }) {
  const rules = gate.rules!;
  return (
    <div className="space-y-3">
      <p className="text-muted">
        Your verification is recorded and meets the rules. Claiming creates your pass on chain; you pay the network fee and the pass&apos;s rent, which comes back if the pass ends.
      </p>
      <RunButton
        account={account}
        label="Claim your pass"
        testId="claim-pass"
        onDone={onDone}
        build={async () => {
          if (rules.identity.__option !== 'Some' || d.identity === null) throw new Error('This gate takes no identity attestation, so there is nothing to claim with.');
          const payer = walletSigner(account.address);
          return [
            await claimPassAttested({
              payer,
              owner: account.address as never,
              mint: gate.mint as never,
              identity: d.identity.identity,
              identitySas: rules.identity.value,
              ...(rules.accreditation.__option === 'Some' ? { accreditationSas: rules.accreditation.value } : {}),
              ...(d.previousHolder ? { previousHolder: d.previousHolder } : {}),
            }),
          ];
        }}
      />
    </div>
  );
}

function Verify({ gate, account, onDone }: { gate: GateState; account: UiWalletAccount; onDone: () => void }) {
  const signMessage = useSignMessage(account);
  const [status, setStatus] = useState<string | null>(null);
  const [result, setResult] = useState<Shown | null>(null);
  const canSign = account.features.includes('solana:signMessage');
  const hasIdentityRoute = gate.rules?.identity.__option === 'Some';

  if (!hasIdentityRoute) {
    return (
      <p className="text-muted" data-testid="no-identity-route">
        This gate takes no identity attestation. The issuer grants passes directly or from an allowlist; ask the issuer.
      </p>
    );
  }
  if (!KYC_ATTESTER_URL) {
    return (
      <p className="text-muted" data-testid="no-kyc-provider">
        No identity provider is connected on this deployment yet, so there is no check to start here. The issuer can still grant a pass directly.
      </p>
    );
  }
  return (
    <div className="space-y-3" data-testid="verify">
      <p className="text-muted">
        The issuer accepts holders whose identity its provider has verified. Opening Bell never sees your documents. Recording your verification puts your country, tier and verification status on chain next to this wallet, where anyone can read them. You sign a short message first so nobody else can do this for you; it is not a transaction and costs nothing.
      </p>
      <button
        type="button"
        disabled={status !== null || !canSign}
        data-testid="verify-check"
        onClick={async () => {
          setResult(null);
          try {
            setStatus('Asking the attester…');
            const ch = await identityChallenge(account.address);
            if (!ch) {
              setResult({ kind: 'unreachable' });
              return;
            }
            setStatus('Waiting for your wallet…');
            const signed = await signMessage({ message: new TextEncoder().encode(ch.message) });
            setStatus('Asking the identity provider…');
            setResult(await requestAttestation(account.address, ch.issuedAt, new Uint8Array(signed.signature)));
            onDone();
          } catch (e) {
            setResult(e instanceof Error && /reject|cancel|denied/i.test(e.message) ? { kind: 'declined' } : { kind: 'refused', message: e instanceof Error ? e.message : 'The wallet could not sign.' });
          } finally {
            setStatus(null);
          }
        }}
        className="w-full rounded-full border border-border-strong px-5 py-2.5 text-sm font-medium transition-colors hover:bg-surface disabled:opacity-50"
      >
        {status ?? 'Record my verification'}
      </button>
      {!canSign ? <p className="text-xs text-muted">This wallet cannot sign messages, which the check needs. Use a wallet that can.</p> : null}
      <Outcome result={result} wallet={account.address} />
    </div>
  );
}

function Outcome({ result, wallet }: { result: Shown | null; wallet: string }) {
  if (!result) return null;
  switch (result.kind) {
    case 'attested':
      return (
        <Notice tone="success" title="Your verification is recorded" testId="verify-attested">
          {result.country ? `Country ${result.country}, ` : ''}tier {TIER_NAME[result.tier] ?? result.tier}, valid until {result.expiry ? new Date(result.expiry * 1000).toLocaleDateString() : 'further notice'}. If it meets the rules, the claim button appears above.
        </Notice>
      );
    case 'ineligible': {
      const atProvider = result.reasons.some((r) => AT_PROVIDER.has(r.code));
      return (
        <Notice tone="warn" title="Your verification cannot be recorded" testId="verify-ineligible" alert>
          <ul className="space-y-1">
            {result.reasons.map((r) => (
              <li key={r.code} data-reason={r.code}>
                {r.message}
              </li>
            ))}
          </ul>
          {result.closed ? <p className="mt-2">An earlier attestation for this wallet was removed, so any pass it supported can now be closed by anyone.</p> : null}
          {atProvider && PROVIDER_URL ? (
            <a href={PROVIDER_URL.replace('{wallet}', encodeURIComponent(wallet))} className="mt-3 inline-block rounded-full bg-accent-fill px-5 py-2.5 text-sm font-medium text-on-accent" rel="noopener noreferrer" data-testid="verify-provider-link">
              Go to the identity provider
            </a>
          ) : null}
        </Notice>
      );
    }
    case 'unavailable':
      return (
        <Notice tone="warn" title="The identity provider did not answer" testId="verify-unavailable" alert>
          Nothing was recorded and nothing was removed. Try again in a minute.
        </Notice>
      );
    case 'rate-limited':
      return (
        <Notice tone="warn" title="Checked a moment ago" testId="verify-limited" alert>
          Try again in {result.retryAfter} seconds.
        </Notice>
      );
    case 'declined':
      return <Notice title="You declined in your wallet" testId="verify-declined">Nothing was sent.</Notice>;
    case 'unreachable':
      return (
        <Notice tone="warn" title="The attester could not be reached" testId="verify-unreachable" alert>
          Nothing was recorded. Try again in a minute.
        </Notice>
      );
    default:
      return (
        <Notice tone="warn" title="The check could not be completed" testId="verify-refused" alert>
          {result.message}
        </Notice>
      );
  }
}
