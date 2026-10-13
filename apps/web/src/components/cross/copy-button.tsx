'use client';

import { useEffect, useRef, useState } from 'react';

/** Copies a value to the clipboard and says so in words, for screen readers as well as the eye. */
export function CopyButton({ value, label }: { value: string; label: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  return (
    <>
      <button
        type="button"
        aria-label={label}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value);
            setState('copied');
          } catch {
            setState('failed');
          }
          if (timer.current) clearTimeout(timer.current);
          timer.current = setTimeout(() => setState('idle'), 2000);
        }}
        className="shrink-0 rounded-md border border-border px-2.5 py-1 text-xs text-muted transition-colors hover:border-border-strong hover:text-ink"
      >
        {state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : 'Copy'}
      </button>
      <span role="status" className="sr-only">
        {state === 'copied' ? 'Copied to the clipboard' : state === 'failed' ? 'Could not copy' : ''}
      </span>
    </>
  );
}
