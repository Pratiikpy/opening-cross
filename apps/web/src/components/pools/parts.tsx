'use client';

// Small pieces the pool screens share: a figure tile, the kind and status marks, an address with its explorer link.
import { Pill } from '@/components/issuer/treasury-ui';
import { shortAddress } from '@/lib/units';
import { KIND_LABEL, explorerAddress, statusText } from './format';
import type { PoolKind, PoolStatus } from './types';

/** One headline figure: a label, the value, and one line that says what it is made of. */
export function Tile({ label, value, note, testId }: { label: string; value: React.ReactNode; note?: React.ReactNode; testId?: string }) {
  return (
    <div className="min-w-0 rounded-[var(--radius-card)] border border-border p-4" {...(testId ? { 'data-testid': testId } : {})}>
      <p className="text-xs uppercase tracking-wide text-muted">{label}</p>
      <p className="mt-1 text-xl font-semibold tabular-nums [overflow-wrap:anywhere]">{value}</p>
      {note ? <p className="mt-1 text-xs text-muted">{note}</p> : null}
    </div>
  );
}

export function KindPill({ kind }: { kind: PoolKind }) {
  return <Pill tone="info">{KIND_LABEL[kind]}</Pill>;
}

export function StatusPill({ status }: { status: PoolStatus }) {
  return (
    <Pill tone={status.open ? 'ok' : 'warn'} testId="pool-status">
      {statusText(status)}
    </Pill>
  );
}

/** A mono address that wraps on a phone, with its explorer link. */
export function Address({ value, network, short = false }: { value: string; network: string; short?: boolean }) {
  return (
    <a href={explorerAddress(value, network)} target="_blank" rel="noreferrer" className="font-mono underline underline-offset-4 [overflow-wrap:anywhere] hover:text-ink" title={value}>
      {short ? shortAddress(value) : value}
    </a>
  );
}

/** A table whose columns scroll sideways on a phone instead of squeezing the page. */
export function Scroll({ children, label }: { children: React.ReactNode; label: string }) {
  return (
    <div className="overflow-x-auto" role="region" aria-label={label} tabIndex={0}>
      {children}
    </div>
  );
}

export const TH = 'whitespace-nowrap px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted';
export const TD = 'whitespace-nowrap px-3 py-2 tabular-nums';
