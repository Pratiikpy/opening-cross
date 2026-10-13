import type { ReactNode } from 'react';
import type { Result } from '@/lib/api';

/** One figure with what it counts, its sample size and how it was computed. Shows the reason instead of a number when the data is not available. */
export function MetricCard({ id, label, value, sample, method, tone }: { id: string; label: string; value: string; sample: string; method: ReactNode; tone?: 'plain' | 'caution' }) {
  return (
    <div className="border-t-2 border-ink pt-3" data-testid={`metric-${id}`}>
      <dd className="text-[28px] font-semibold leading-tight tracking-tight">{value}</dd>
      <dt className="mt-1 text-sm text-ink">{label}</dt>
      <dd className="mt-2 font-mono text-xs text-muted" data-testid={`metric-${id}-sample`}>
        {sample}
      </dd>
      <dd className={`mt-1 text-xs ${tone === 'caution' ? 'text-ink' : 'text-muted'}`}>{method}</dd>
    </div>
  );
}

export function MetricUnavailable({ id, label, error }: { id: string; label: string; error: string }) {
  return (
    <div className="border-t-2 border-border pt-3" role="status" data-testid={`metric-${id}`}>
      <dd className="text-[28px] font-semibold leading-tight tracking-tight text-subtle">Unavailable</dd>
      <dt className="mt-1 text-sm text-ink">{label}</dt>
      <dd className="mt-2 text-xs text-muted">{error} Nothing is shown in its place.</dd>
    </div>
  );
}

/** Placeholder with the same footprint while the metrics load, announced to screen readers. */
export function MetricsSkeleton({ count = 4, label = 'Loading measured figures' }: { count?: number; label?: string }) {
  return (
    <div role="status" aria-live="polite" aria-label={label} data-testid="metrics-loading">
      <span className="sr-only">{label}</span>
      <div className="grid grid-cols-1 gap-8 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: count }, (_, i) => (
          <div key={i} className="border-t-2 border-border pt-3" aria-hidden="true">
            <div className="h-8 w-24 animate-pulse rounded bg-surface-2" />
            <div className="mt-3 h-4 w-40 animate-pulse rounded bg-surface-2" />
            <div className="mt-3 h-3 w-32 animate-pulse rounded bg-surface-2" />
          </div>
        ))}
      </div>
    </div>
  );
}

export type { Result };
