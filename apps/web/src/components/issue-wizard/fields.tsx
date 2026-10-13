'use client';

// Form building blocks of the issuer wizard: a fieldset card, text and whole-number inputs, a select, and a status chip.
// Every control has a visible label, ties its error or hint to the input with aria-describedby, and is at least 44px tall.
import { useId, useState } from 'react';

export function Fieldset({ legend, id, children, note }: { legend: string; id?: string; children: React.ReactNode; note?: string }) {
  return (
    <fieldset id={id} className="space-y-4 rounded-[var(--radius-card)] border border-border p-5 scroll-mt-24">
      <legend className="px-1 font-medium">{legend}</legend>
      {note ? <p className="text-sm text-muted">{note}</p> : null}
      {children}
    </fieldset>
  );
}

export function Text({
  label,
  value,
  onChange,
  onBlur,
  error,
  hint,
  type = 'text',
  inputMode,
  placeholder,
  mono = true,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  onBlur?: () => void;
  error?: string | undefined;
  hint?: string;
  type?: string;
  inputMode?: 'numeric' | 'decimal';
  placeholder?: string;
  mono?: boolean;
  disabled?: boolean;
}) {
  const errorId = useId();
  const hintId = useId();
  return (
    <div className="text-sm">
      <label className="block">
        <span className="text-muted">{label}</span>
        <input
          type={type}
          value={value}
          inputMode={inputMode}
          spellCheck={false}
          autoComplete="off"
          placeholder={placeholder}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          onBlur={onBlur}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? errorId : hint ? hintId : undefined}
          className={`mt-1 min-h-11 w-full rounded-lg border border-border-strong bg-bg px-3 py-2.5 disabled:opacity-60 ${mono ? 'font-mono' : ''}`}
        />
      </label>
      {error ? (
        <span id={errorId} className="mt-1 block text-xs text-accent-text">
          {error}
        </span>
      ) : hint ? (
        <span id={hintId} className="mt-1 block text-xs text-muted">
          {hint}
        </span>
      ) : null}
    </div>
  );
}

/** A whole-number field. It keeps what the person typed (an empty box stays empty) and reports NaN until the text is a number. */
export function Num({ label, value, onChange, error, hint }: { label: string; value: number; onChange: (v: number) => void; error?: string | undefined; hint?: string }) {
  const [text, setText] = useState(Number.isFinite(value) ? String(value) : '');
  return (
    <Text
      label={label}
      value={text}
      inputMode="numeric"
      onChange={(v) => {
        setText(v);
        onChange(v.trim() === '' ? Number.NaN : Number(v));
      }}
      error={error}
      {...(hint ? { hint } : {})}
    />
  );
}

export function Select({ label, value, onChange, options, hint }: { label: string; value: string; onChange: (v: string) => void; options: [string, string][]; hint?: string }) {
  const hintId = useId();
  return (
    <div className="text-sm">
      <label className="block">
        <span className="text-muted">{label}</span>
        <select value={value} onChange={(e) => onChange(e.target.value)} aria-describedby={hint ? hintId : undefined} className="mt-1 min-h-11 w-full rounded-lg border border-border-strong bg-bg px-3 py-2.5">
          {options.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
      </label>
      {hint ? (
        <span id={hintId} className="mt-1 block text-xs text-muted">
          {hint}
        </span>
      ) : null}
    </div>
  );
}

export type ChipTone = 'ok' | 'warn' | 'block' | 'info';
const CHIP: Record<ChipTone, string> = {
  ok: 'border-positive text-positive',
  warn: 'border-border-strong text-ink',
  block: 'border-accent text-accent-text',
  info: 'border-border text-muted',
};

export function Chip({ tone, children }: { tone: ChipTone; children: React.ReactNode }) {
  return <span className={`inline-flex min-w-20 justify-center rounded-full border px-2.5 py-1 text-xs ${CHIP[tone]}`}>{children}</span>;
}

/** A plain button in the console's secondary style. */
export function SmallButton({ children, onClick, disabled, pressed, testId, label }: { children: React.ReactNode; onClick: () => void; disabled?: boolean; pressed?: boolean; testId?: string; label?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      {...(pressed !== undefined ? { 'aria-pressed': pressed } : {})}
      {...(label ? { 'aria-label': label } : {})}
      {...(testId ? { 'data-testid': testId } : {})}
      className="min-h-11 rounded-full border border-border-strong px-4 py-2 text-sm transition-colors hover:bg-surface disabled:opacity-50"
    >
      {children}
    </button>
  );
}
