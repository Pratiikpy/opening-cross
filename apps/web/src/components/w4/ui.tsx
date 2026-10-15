'use client';

import Link from 'next/link';
import { type FeatureKey, networkName, offReason, useFeature } from '@/lib/new-programs';
import { WalletAction } from '@/components/issuer/issuer-action';
import type { ComponentProps } from 'react';

/** The frame of a public Wave 3D page: a trail, one h1 and a sentence about what the page is. */
export function PublicPage({ title, intro, trail, children, wide = false }: { title: string; intro?: React.ReactNode; trail?: { href: string; label: string }[]; children: React.ReactNode; wide?: boolean }) {
  return (
    <div className={`mx-auto ${wide ? 'max-w-[1200px]' : 'max-w-[960px]'} px-4 py-12 sm:px-6`}>
      {trail && trail.length > 0 ? (
        <p className="text-sm text-muted">
          {trail.map((t, i) => (
            <span key={t.href}>
              {i > 0 ? ' / ' : ''}
              <Link href={t.href} className="underline underline-offset-4 hover:text-ink">
                {t.label}
              </Link>
            </span>
          ))}
        </p>
      ) : null}
      <h1 className="mt-3 text-[30px] font-semibold leading-tight tracking-tight sm:text-[38px]">{title}</h1>
      {intro ? <div className="mt-2 max-w-2xl text-muted">{intro}</div> : null}
      <div className="mt-8 space-y-6">{children}</div>
    </div>
  );
}

const BOX = 'rounded-[var(--radius-card)] border p-4 text-sm';

/**
 * What the connected network runs for one feature, said before an action is offered. It reads GET /v1/programs and never turns "could not be checked"
 * into "missing": a feature that is not on the network is described as built and proved, not live.
 */
export function FeatureNotice({ feature, what, className = '' }: { feature: FeatureKey; what: string; className?: string }) {
  const a = useFeature(feature);
  if (a.phase === 'loading') {
    return (
      <p role="status" data-testid="feature-notice" data-state="loading" className={`${BOX} border-border text-muted ${className}`}>
        Asking which programs {networkName(null)} runs…
      </p>
    );
  }
  if (a.phase === 'unavailable') {
    return (
      <p role="status" data-testid="feature-notice" data-state="unavailable" className={`${BOX} border-border-strong text-muted ${className}`}>
        <span className="font-medium text-ink">Release not confirmed. </span>
        This page could not ask the API which programs are deployed, so it cannot say whether {what.toLowerCase()} is live. Each action is simulated on the cluster before your wallet is asked, and nothing is signed if the program refuses it.
      </p>
    );
  }
  if (a.available === true) {
    return (
      <p role="status" data-testid="feature-notice" data-state="live" className={`${BOX} border-border text-muted ${className}`}>
        <span className="font-medium text-ink">Live on {networkName(a.network)}.</span> {what} is on this network; the actions below are signed by your wallet and land on chain.
      </p>
    );
  }
  if (a.available === false) {
    return (
      <div role="status" data-testid="feature-notice" data-state="not-deployed" className={`${BOX} border-accent ${className}`}>
        <p className="font-medium">Built, not on {networkName(a.network)} yet</p>
        <p className="mt-1 text-muted">
          {what} is built and proved on LiteSVM and a local validator. {a.feature?.note ?? ''} It goes live when the operations key is funded (H27, H43).
        </p>
        <p className="mt-1 text-muted">You can read what the screen would do and fill it in. Signing is switched off until the program is on the network.</p>
      </div>
    );
  }
  return (
    <p role="status" data-testid="feature-notice" data-state="unknown" className={`${BOX} border-border-strong text-muted ${className}`}>
      <span className="font-medium text-ink">Release not confirmed. </span>
      The API could not check just now whether {what.toLowerCase()} is on {networkName(a.network)}. Each action is simulated on the cluster before your wallet is asked, and nothing is signed if the program refuses it.
    </p>
  );
}

type ActionProps = ComponentProps<typeof WalletAction>;
/**
 * A wallet action whose button is off, with the reason, while the feature is definitely not on the network. An unknown release leaves it on, because the
 * transaction is simulated first.
 */
export function FeatureAction({ feature, what, disabled, disabledReason, connectHint = 'Connect a wallet to sign this.', ...rest }: Omit<ActionProps, 'needs' | 'what'> & { feature: FeatureKey; what: string }) {
  const a = useFeature(feature);
  const off = offReason(a, what);
  return <WalletAction {...rest} connectHint={connectHint} what={what} disabled={Boolean(disabled) || off !== null} disabledReason={off ?? disabledReason} />;
}

export function Loading({ what }: { what: string }) {
  return (
    <p role="status" className="text-sm text-muted" data-testid="loading">
      Reading {what}…
    </p>
  );
}

export function Failed({ children, testId = 'read-error' }: { children: React.ReactNode; testId?: string }) {
  return (
    <p role="alert" className="rounded-[var(--radius-card)] border border-accent p-4 text-sm" data-testid={testId}>
      {children}
    </p>
  );
}

/** A sentence a screen says instead of a dead control. */
export function Plain({ children, testId }: { children: React.ReactNode; testId?: string }) {
  return (
    <p className="rounded-lg border border-border p-4 text-sm text-muted" {...(testId ? { 'data-testid': testId } : {})}>
      {children}
    </p>
  );
}

export function when(ts: string | number | bigint | null | undefined): string {
  if (ts === null || ts === undefined) return 'an unknown time';
  const n = Number(ts);
  return Number.isFinite(n) ? `${new Date(n * 1000).toISOString().replace('T', ' ').slice(0, 16)} UTC` : 'an unknown time';
}
