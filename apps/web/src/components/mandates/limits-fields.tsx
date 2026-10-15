'use client';

import { Text } from '@/components/issue-wizard/fields';
import { KIND_LABEL, type AllowKind, type LimitsErrors, type LimitsForm } from '@/lib/mandates';

/** The limits of a mandate: what the agent may escrow, for how long, at what share of a cross, and which tokens, creators or crosses it may buy. */
export function LimitsFields({ value, onChange, errors, symbol }: { value: LimitsForm; onChange: (v: LimitsForm) => void; errors: LimitsErrors; symbol: string }) {
  const set = <K extends keyof LimitsForm>(k: K, v: LimitsForm[K]) => onChange({ ...value, [k]: v });
  const shown = (k: 'maxPerOrder' | 'totalCap' | 'sharePct' | 'days') => (value[k] === '' ? undefined : errors[k]);
  return (
    <div className="space-y-4" data-testid="limits-form">
      <div className="grid gap-4 sm:grid-cols-2">
        <Text label={`Most one order may escrow${symbol ? `, in ${symbol}` : ''}`} value={value.maxPerOrder} onChange={(v) => set('maxPerOrder', v)} inputMode="decimal" error={shown('maxPerOrder')} />
        <Text label={`Lifetime cap${symbol ? `, in ${symbol}` : ''}`} value={value.totalCap} onChange={(v) => set('totalCap', v)} inputMode="decimal" error={shown('totalCap')} hint="Counts every escrow ever committed, refunded or not: a ceiling on activity. The vault’s balance is the hard budget." />
        <Text label="Most of a cross’s declared supply one order may buy, %" value={value.sharePct} onChange={(v) => set('sharePct', v)} inputMode="decimal" error={errors.sharePct} hint="Above 0, at most 25. A cross that declares no supply is refused: a share of an unknown is not a limit." />
        <Text label="Expires in, days" value={value.days} onChange={(v) => set('days', v)} inputMode="numeric" error={errors.days} />
      </div>
      <fieldset className="space-y-3" data-testid="allow-list">
        <legend className="text-sm font-medium">What the agent may buy (one to eight)</legend>
        {value.allow.map((a, i) => (
          <div key={i} className="grid gap-3 sm:grid-cols-[180px_1fr_auto] sm:items-end">
            <div className="text-sm">
              <label className="block">
                <span className="text-muted">Kind</span>
                <select value={a.kind} onChange={(e) => set('allow', value.allow.map((x, j) => (j === i ? { ...x, kind: e.target.value as AllowKind } : x)))} className="mt-1 min-h-11 w-full rounded-lg border border-border-strong bg-bg px-3 py-2.5" aria-label={`Kind of entry ${i + 1}`}>
                  {(Object.keys(KIND_LABEL) as AllowKind[]).map((k) => (
                    <option key={k} value={k}>
                      {KIND_LABEL[k]}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <Text label={`Address of entry ${i + 1}`} value={a.key} onChange={(v) => set('allow', value.allow.map((x, j) => (j === i ? { ...x, key: v } : x)))} error={a.key === '' ? undefined : errors.entries[i]} />
            <button type="button" disabled={value.allow.length <= 1} onClick={() => set('allow', value.allow.filter((_, j) => j !== i))} aria-label={`Remove entry ${i + 1}`} className="min-h-11 rounded-full border border-border-strong px-4 py-2 text-sm hover:bg-surface disabled:opacity-50">
              Remove
            </button>
          </div>
        ))}
        {errors.allow ? <p className="text-xs text-accent-text">{errors.allow}</p> : null}
        <button type="button" disabled={value.allow.length >= 8} onClick={() => set('allow', [...value.allow, { kind: 'creator', key: '' }])} data-testid="add-allow" className="min-h-11 rounded-full border border-border-strong px-4 py-2 text-sm hover:bg-surface disabled:opacity-50">
          Add an entry
        </button>
      </fieldset>
    </div>
  );
}
