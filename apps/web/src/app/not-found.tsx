import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="mx-auto max-w-[700px] px-4 py-24 sm:px-6">
      <p className="font-mono text-xs uppercase tracking-widest text-accent-text">404</p>
      <h1 className="mt-4 text-[34px] font-semibold tracking-tight sm:text-[44px]">This page does not exist.</h1>
      <p className="mt-4 text-muted">
        The address may be mistyped, or the cross may be on a different network from the one this site follows. Crosses are listed newest first.
      </p>
      <div className="mt-8 flex flex-wrap gap-3">
        <Link href="/crosses" className="rounded-full bg-accent-fill px-5 py-3 text-sm font-medium text-on-accent transition-opacity hover:opacity-90">
          Browse crosses
        </Link>
        <Link href="/" className="rounded-full border border-border-strong px-5 py-3 text-sm font-medium transition-colors hover:bg-surface">
          Back to the start
        </Link>
      </div>
    </div>
  );
}
