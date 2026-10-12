'use client';

import Link from 'next/link';

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="mx-auto max-w-[700px] px-4 py-24 sm:px-6" role="alert">
      <p className="font-mono text-xs uppercase tracking-widest text-accent-text">Something broke</p>
      <h1 className="mt-4 text-[34px] font-semibold tracking-tight sm:text-[44px]">This page could not be shown.</h1>
      <p className="mt-4 text-muted">
        Nothing was sent from your wallet by this error. Try again; if it keeps happening, the{' '}
        <Link href="/status" className="text-accent-text underline">
          status page
        </Link>{' '}
        shows whether the API and the network are reachable.
      </p>
      {error.digest ? <p className="mt-3 font-mono text-xs text-muted">Reference: {error.digest}</p> : null}
      <button type="button" onClick={reset} className="mt-8 rounded-full bg-accent-fill px-5 py-3 text-sm font-medium text-on-accent transition-opacity hover:opacity-90">
        Try again
      </button>
    </div>
  );
}
