'use client';

import { useEffect, useRef, useState } from 'react';

const btn = 'inline-flex min-h-10 items-center justify-center rounded-full border border-border-strong px-4 text-sm text-ink transition-colors hover:bg-surface';

/** Copy the page link, download the card as a PNG, download the receipt JSON. The state of a copy is said in words for screen readers too. */
export function ReceiptActions({ pagePath, imagePath, jsonPath }: { pagePath: string; imagePath: string; jsonPath: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="receipt-actions">
      <button
        type="button"
        className={btn}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(new URL(pagePath, window.location.origin).toString());
            setState('copied');
          } catch {
            setState('failed');
          }
          if (timer.current) clearTimeout(timer.current);
          timer.current = setTimeout(() => setState('idle'), 2500);
        }}
      >
        {state === 'copied' ? 'Link copied' : state === 'failed' ? 'Copy failed: select the address bar' : 'Copy link'}
      </button>
      <a className={btn} href={imagePath} download>
        Download image (PNG)
      </a>
      <a className={btn} href={jsonPath} download>
        Download receipt (JSON)
      </a>
      <span role="status" className="sr-only">
        {state === 'copied' ? 'The link was copied to the clipboard' : state === 'failed' ? 'The link could not be copied' : ''}
      </span>
    </div>
  );
}
