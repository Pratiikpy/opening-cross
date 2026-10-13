'use client';

import Link from 'next/link';
import { useState } from 'react';
import { isWatching } from '@/lib/holder-alerts';
import { useSaved, useWatchList } from './use-alerts';

/**
 * Follow a cross or a market: this browser lists it, and the push and Telegram subscriptions it manages are told. With no channel set
 * up the button says so and points to the Alerts page, rather than implying a reminder will arrive.
 */
export function FollowButton({ kind, address, label }: { kind: 'crosses' | 'markets'; address: string; label: string }) {
  const { watch, follow } = useWatchList();
  const { saved } = useSaved();
  const [note, setNote] = useState<string | null>(null);
  const on = isWatching(watch, kind, address);
  const hasChannel = saved.push !== null || saved.telegram !== null;

  async function toggle() {
    const r = await follow(kind, address);
    if (!r.saved) setNote('This browser would not save your follow list, so it will be forgotten when you leave.');
    else if (r.following && !hasChannel) setNote('Following in this browser. Choose how to be reminded on the Alerts page.');
    else if (r.following) setNote('Following. You will be reminded 10 minutes before it opens or closes.');
    else setNote(null);
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <button
        type="button"
        aria-pressed={on}
        onClick={() => void toggle()}
        className={`min-h-10 rounded-full border px-4 text-sm ${on ? 'border-accent bg-surface text-ink' : 'border-border-strong hover:bg-surface'}`}
      >
        {on ? <span aria-hidden="true">✓ </span> : null}
        {on ? 'Following' : 'Follow'}
        <span className="sr-only"> {label}</span>
      </button>
      {note ? (
        <span role="status" className="text-xs text-muted">
          {note} {!hasChannel && on ? <Link href="/alerts" className="underline">Alerts</Link> : null}
        </span>
      ) : null}
    </span>
  );
}
