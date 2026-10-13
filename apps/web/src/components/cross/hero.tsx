'use client';

import { useState } from 'react';
import type { BookResponse, CrossDetail } from '@/lib/types';
import { type Market, formatAtoms, formatDuration, formatPrice } from '@/lib/units';
import type { OrderRecord } from './order-record';
import { finalWindow } from './final-window';
import { coarseRange, imbalance } from './holder-coarse';
import { type EndingNow, type IndicativeRead, imbalanceText } from '@/lib/holder-rules';
import type { Phase } from './timeline';

function Stat({ label, children, sub, testId }: { label: string; children: React.ReactNode; sub?: string; testId?: string }) {
  return (
    <div className="rounded-[var(--radius-card)] border border-border p-5">
      <dt className="font-mono text-xs uppercase tracking-widest text-muted">{label}</dt>
      <dd className="mt-3 text-[32px] font-semibold leading-none tracking-tight sm:text-[40px]" data-testid={testId}>
        {children}
      </dd>
      {sub ? <dd className="mt-3 text-sm text-muted">{sub}</dd> : null}
    </div>
  );
}

const RATIONED: Record<string, string> = {
  none: 'Every order that crossed was filled in full.',
  buy: 'More was asked for than offered at this price, so buy orders at it were filled pro rata.',
  sell: 'More was offered than asked for at this price, so sell orders at it were filled pro rata.',
};

/** The three numbers that matter most, by stage: price, size and time while live; price, volume and fills once settled. */
export function Hero(props: { cross: CrossDetail; book: BookResponse | null; orders: OrderRecord[] | null; phase: Phase; now: bigint; market: Market; ending: EndingNow; indicative: IndicativeRead | null }) {
  return props.cross.state !== 'Live' ? <Settled cross={props.cross} orders={props.orders} market={props.market} /> : <LiveHero {...props} />;
}

function LiveHero({ cross, book, phase, now, market: m, ending, indicative }: { cross: CrossDetail; book: BookResponse | null; orders: OrderRecord[] | null; phase: Phase; now: bigint; market: Market; ending: EndingNow; indicative: IndicativeRead | null }) {
  const sealed = cross.disclosure === 'sealed';
  const offered = (book?.levels ?? []).reduce((s, l) => s + BigInt(l.sell), 0n);
  const wanted = (book?.levels ?? []).reduce((s, l) => s + BigInt(l.buy), 0n);
  const nextTs = phase === 'upcoming' ? cross.window.openTs : phase === 'open' ? cross.window.closeTs : phase === 'reveal' ? cross.window.revealEndTs : null;
  const timeLabel = phase === 'upcoming' ? 'Opens in' : phase === 'open' ? 'Closes in' : phase === 'reveal' ? 'Reveal ends in' : 'Call status';
  const hasBook = book !== null && book.levels.length > 0;
  // A cross with an ending period has its own, real one: the coarse figures come from /indicative and the generic last-minutes notice is not shown.
  const inEnding = ending.kind === 'ending' && phase === 'open';
  const fin = phase === 'open' && !inEnding ? finalWindow(cross.window.openTs, cross.window.closeTs, now) : null;
  // In the final minutes the page leads with a price range and a demand bucket; the exact figures are one press away.
  const [exact, setExact] = useState(false);
  const coarse = Boolean(fin?.active) && !exact && !sealed && book !== null;
  const range = coarse && book?.indicative ? coarseRange(BigInt(book.indicative.price), cross.grid) : null;
  const bucket = coarse ? imbalance(wanted, offered) : null;
  return (
    <>
    {inEnding && ending.kind === 'ending' ? (
      <p className="mb-4 rounded-[var(--radius-card)] border border-accent px-4 py-3 text-sm" data-testid="ending-notice">
        <span className="font-medium">Ending period, window {ending.bucket + 1} of {ending.buckets}.</span> {formatDuration(BigInt(cross.window.closeTs) - now > 0n ? BigInt(cross.window.closeTs) - now : 0n)} left. The price below is shown to the nearest of eight bands and the balance of demand only as a direction, so this page does not give away where the price is going. That is a display rule of this app, not secrecy: the order accounts are public on chain. The Rules tab says when orders can no longer be cancelled.
      </p>
    ) : null}
    {fin?.active ? (
      <p className="mb-4 rounded-[var(--radius-card)] border border-accent px-4 py-3 text-sm" data-testid="final-window">
        <span className="font-medium">Final minutes.</span> {formatDuration(fin.remaining)} left to place or cancel an order. Orders and cancellations still change the indicative price until the countdown ends. {exact ? 'Showing exact figures.' : 'The price and the balance of demand are rounded here so this page does not flicker with every order.'} This is a display choice only: the program has no hidden or coarse final window, the book is public and exact, and every order is treated alike.{' '}
        <button type="button" onClick={() => setExact(!exact)} aria-pressed={exact} className="inline-flex min-h-6 items-center py-1 text-accent-text underline">
          {exact ? 'Round the figures' : 'Show exact figures'}
        </button>
      </p>
    ) : null}
    <dl className="grid gap-4 sm:grid-cols-3" aria-label="Key numbers">
      <Stat
        label={phase === 'awaiting-settlement' ? 'Price once it settles' : 'Indicative price'}
        testId="price"
        sub={
          inEnding
            ? 'Nearest of eight price bands during the ending period. The exact price returns when the call closes.'
            : book?.indicative
            ? `${formatAtoms(BigInt(book.indicative.matched), m.baseDecimals)} tokens would trade. ${phase === 'upcoming' || phase === 'open' ? 'Indicative until the call closes.' : 'Settling the cross fixes the final price.'}`
            : sealed
              ? 'Sealed: prices stay hidden until bids are revealed.'
              : 'No crossing orders yet.'
        }
      >
        {inEnding ? (
          indicative === null ? (
            '…'
          ) : indicative.indicative?.price ? (
            <span data-testid="coarse-price" className="text-[26px] sm:text-[32px]">about {formatPrice(BigInt(indicative.indicative.price), m)}</span>
          ) : (
            'No price yet'
          )
        ) : range ? <span data-testid="coarse-price" className="text-[26px] sm:text-[32px]">about {formatPrice(range.low, m)} to {formatPrice(range.high, m)}</span> : book?.indicative ? formatPrice(BigInt(book.indicative.price), m) : sealed ? 'Sealed' : 'No price yet'}
      </Stat>
      <Stat
        label={inEnding ? 'Balance of demand' : 'Tokens offered'}
        testId="offered"
        sub={inEnding ? 'Shown as a direction only during the ending period.' : book === null ? 'Loading the book…' : sealed ? (hasBook ? `${formatAtoms(wanted, m.baseDecimals)} wanted so far. Only revealed bids are counted.` : 'Bids stay sealed until the reveal.') : bucket ? `Demand: ${bucket.label}.` : `${formatAtoms(wanted, m.baseDecimals)} wanted by buyers`}
      >
        {inEnding ? <span className="text-[26px] sm:text-[32px]">{indicative?.indicative ? imbalanceText(indicative.indicative.imbalance) : '…'}</span> : book === null ? '…' : sealed && !hasBook ? 'Sealed' : formatAtoms(offered, m.baseDecimals)}
      </Stat>
      <Stat label={timeLabel} sub={nextTs ? 'Counting down to the next stage.' : 'The call is closed. Anyone can settle the cross.'}>
        {nextTs ? <span data-testid="countdown" className="font-mono text-[28px] sm:text-[34px]">{formatDuration(BigInt(nextTs) - now)}</span> : 'Closed'}
      </Stat>
    </dl>
    </>
  );
}

function Settled({ cross, orders, market: m }: { cross: CrossDetail; orders: OrderRecord[] | null; market: Market }) {
  const c = cross.clearing;
  const total = orders?.length ?? null;
  const filled = orders ? orders.filter((o) => o.fill !== null && BigInt(o.fill) > 0n).length : null;
  const claimed = orders ? orders.filter((o) => o.status === 'claimed' || o.status === 'cancelled').length : null;
  return (
    <dl className="grid gap-4 sm:grid-cols-3" aria-label="Key numbers">
      <Stat
        label={c ? 'Clearing price' : 'Result'}
        testId="price"
        sub={c ? 'Every order that traded paid or received this one price.' : 'No price printed; every order is refunded in full.'}
      >
        {c ? formatPrice(BigInt(c.price), m) : 'No print'}
      </Stat>
      <Stat label="Matched" testId="matched" sub={c ? RATIONED[c.rationed] : 'Nothing traded.'}>
        {c ? `${formatAtoms(BigInt(c.matched), m.baseDecimals)}` : '0'}
        <span className="ml-2 text-base font-normal text-muted">tokens</span>
      </Stat>
      <Stat
        label="Orders filled"
        testId="fills"
        sub={
          total === null
            ? 'Loading the orders…'
            : !c
              ? `Of ${total} order${total === 1 ? '' : 's'}; all refunded.`
              : claimed !== null && claimed < (total ?? 0)
                ? `Of ${total} orders. ${claimed} settled so far; the rest have not claimed yet, so this can still rise.`
                : `Of ${total} order${total === 1 ? '' : 's'}${total !== null && filled !== null && filled < total ? '; the others were refunded in full.' : '.'}`
        }
      >
        {total === null ? '…' : c ? filled : 0}
      </Stat>
    </dl>
  );
}
