'use client';

import { useEffect, useState } from 'react';
import { API_URL } from '@/lib/api';
import { RPC_URL } from '@/lib/config';
import { type ReplayResponse, clusterOf, isReplayResponse } from '@/lib/replay';
import type { CrossDetail } from '@/lib/types';
import type { Market } from '@/lib/units';
import { ReplayPlayer } from './replay-player';

type Load = { state: 'loading' } | { state: 'error'; message: string } | { state: 'ready'; replay: ReplayResponse };

/** The Replay tab: GET /v1/replay/:address, played back event by event. Read again whenever the cross changes, so a live cross keeps growing. */
export function ReplayTab({ cross, version, market }: { cross: CrossDetail; version: number; market: Market }) {
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  useEffect(() => {
    let live = true;
    void (async () => {
      // The API reads its index, not the chain, but sits behind a rate limiter: wait and try again rather than show an error for a busy moment.
      for (let attempt = 0; attempt < 4 && live; attempt++) {
        try {
          const r = await fetch(`${API_URL}/v1/replay/${cross.address}`, { cache: 'no-store' });
          if (r.status === 429 || r.status === 503) {
            await new Promise((ok) => setTimeout(ok, 1000 * 2 ** attempt));
            continue;
          }
          const body = (await r.json()) as unknown;
          if (!live) return;
          if (!r.ok) return setLoad({ state: 'error', message: (body as { error?: string }).error ?? `The API answered ${r.status}.` });
          if (!isReplayResponse(body)) return setLoad({ state: 'error', message: 'The API answered with a shape this page does not recognise.' });
          return setLoad({ state: 'ready', replay: body });
        } catch {
          break;
        }
      }
      if (live) setLoad((prev) => (prev.state === 'ready' ? prev : { state: 'error', message: 'The replay could not be loaded right now.' }));
    })();
    return () => {
      live = false;
    };
  }, [cross.address, version]);

  const head = (
    <h2 id="replay-h" className="font-mono text-xs uppercase tracking-widest text-muted">
      Replay
    </h2>
  );
  return (
    <section aria-labelledby="replay-h" className="space-y-4">
      <div>
        {head}
        <p className="mt-2 text-sm text-muted">
          Every on-chain event of this cross in the order it happened, with its block time, slot and transaction.
          {cross.state === 'Live' ? ' The cross is still live, so this list grows as events arrive.' : ''}
        </p>
      </div>
      {load.state === 'loading' ? (
        <p role="status" className="text-sm text-muted">
          Loading the replay…
        </p>
      ) : load.state === 'error' ? (
        <p role="status" className="text-sm text-muted">
          {load.message}
        </p>
      ) : (
        <>
          {!load.replay.complete ? <p className="text-xs text-muted">Not complete yet: the cross has not been finalized.</p> : null}
          <ReplayPlayer replay={load.replay} market={market} cluster={clusterOf(RPC_URL)} />
          <p className="text-xs text-muted">Source: {load.replay.source}. Times are block times in UTC as the indexer recorded them.</p>
        </>
      )}
    </section>
  );
}
