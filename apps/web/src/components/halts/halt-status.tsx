'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Facts, Pill, Section } from '@/components/issuer/treasury-ui';
import { type FeedRead, type HaltRead, HALT_REASON, feedText, haltHeadline } from '@/lib/halts';
import { loadFeed, loadHalt } from '@/lib/series-load';
import { shortAddress } from '@/lib/units';

const TONE = { ok: 'ok', block: 'block', warn: 'warn', info: 'info' } as const;

export type HaltData = { halt: HaltRead | null; feed: FeedRead | null; error: string | null; feedError: string | null };

/** The halt state and the lender print feed of one token, read from the API. Re-read whenever `rev` changes. */
export function useHalt(baseMint: string | null, rev = 0): HaltData | undefined {
  const [data, setData] = useState<HaltData | undefined>(undefined);
  useEffect(() => {
    if (!baseMint) {
      setData(undefined);
      return;
    }
    let live = true;
    void Promise.all([loadHalt(baseMint), loadFeed(baseMint)]).then(([h, f]) => {
      if (live) setData({ halt: h.ok ? h.data : null, feed: f.ok ? f.data : null, error: h.ok ? null : h.error, feedError: f.ok ? null : f.error });
    });
    return () => {
      live = false;
    };
  }, [baseMint, rev]);
  return data;
}

/** What is stopping, or not stopping, trades of a token, and who can change it. Read-only: the same card is the holder's page and the issuer's console. */
export function HaltStatus({ data, baseMint }: { data: HaltData | undefined; baseMint: string }) {
  if (data === undefined) {
    return (
      <p role="status" className="text-sm text-muted">
        Reading the halt state of this token…
      </p>
    );
  }
  if (!data.halt) {
    return (
      <p role="alert" className="rounded-[var(--radius-card)] border border-border p-5 text-sm text-accent-text" data-testid="halt-error">
        The halt state could not be read: {data.error}
      </p>
    );
  }
  const head = haltHeadline(data.halt);
  const s = data.halt.state;
  return (
    <div className="space-y-6" data-testid="halt-status" data-halted={s ? String(s.halted) : 'none'}>
      <Section id="state" title="Is trading halted?" intro="A halt binds the crosses that honour it: while it lasts they refuse to print and refund every order in full. It is read from the chain.">
        <div className="flex flex-wrap items-center gap-3">
          <Pill tone={TONE[head.tone]} testId="halt-pill">
            {head.title}
          </Pill>
          {s ? <span className="text-sm text-muted">{HALT_REASON[s.reason]?.title ?? String(s.reason)}</span> : null}
        </div>
        <div className="space-y-2 text-sm" data-testid="halt-lines">
          {head.lines.map((l) => (
            <p key={l}>{l}</p>
          ))}
        </div>
        {s ? (
          <Facts
            rows={[
              ['Issuer authority', s.authority],
              ['Venue signer', s.venueSigner ?? 'none named'],
              ['Corporate action', s.corporateAction ? 'flagged' : 'not flagged'],
              ['Circuit breaker', s.breaker ? `halts if two prices inside ${s.breaker.windowSlots.toString()} slots differ by more than ${(Number(s.breaker.moveBps) / 100).toString()}%` : 'none'],
              ['Changed', data.halt.indexed ? `${data.halt.indexed.changes} time${data.halt.indexed.changes === 1 ? '' : 's'} (the indexer’s count)` : 'the indexer has not seen it change'],
              ['Halt state account', data.halt.halt ?? ''],
              ['Token', baseMint],
            ]}
          />
        ) : null}
      </Section>
      <Section id="feed" title="The lender print feed" intro="A resume cross that prints can publish its price and volume to lenders that accept the token as collateral. Only the publishers named below can record a print.">
        <p className="text-sm" data-testid="feed-text">
          {data.feed ? feedText(data.feed) : `The feed could not be read: ${data.feedError}`}
        </p>
        {data.feed?.feed ? (
          <Facts
            rows={[
              ['Publishers', (data.feed.publishers ?? []).map(shortAddress).join(', ') || 'none'],
              ['Prints recorded', (data.feed.printCount ?? 0).toString()],
              ['Feed account', data.feed.feed],
            ]}
          />
        ) : null}
        {data.feed?.prints && data.feed.prints.length > 0 ? (
          <ul className="divide-y divide-border border-y border-border text-sm" data-testid="feed-prints">
            {data.feed.prints.slice(0, 5).map((p) => (
              <li key={`${p.cross_address}:${p.slot}`} className="flex flex-wrap justify-between gap-2 py-2">
                <Link href={`/crosses/${p.cross_address}`} className="font-mono text-xs underline underline-offset-4">
                  {shortAddress(p.cross_address)}
                </Link>
                <span className="text-muted">
                  {p.matched} base atoms at {p.price} (price units)
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </Section>
    </div>
  );
}
