'use client';

import { type KeyboardEvent, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  type ReplayEvent,
  type ReplayResponse,
  axisPositions,
  describeEvent,
  elapsedSince,
  explorerTx,
  kindLabel,
  tallyAt,
  utcStamp,
} from '@/lib/replay';
import { type Market, formatAtoms, formatPrice, shortAddress } from '@/lib/units';
import { CopyButton } from './copy-button';

/** Milliseconds each event stays on screen while playing; the real clock times are always shown beside it. */
const SPEEDS = [
  { id: 'slow', label: 'Slow, 2 s per event', ms: 2000 },
  { id: 'normal', label: 'Normal, 1 s per event', ms: 1000 },
  { id: 'fast', label: 'Fast, 0.25 s per event', ms: 250 },
] as const;

const KIND_DOT: Record<string, string> = {
  created: 'bg-ink',
  order_placed: 'bg-border-strong',
  order_revealed: 'bg-border-strong',
  order_cancelled: 'bg-muted',
  base_mint_bound: 'bg-border-strong',
  cleared: 'bg-accent-fill',
  order_claimed: 'bg-positive',
  finalized: 'bg-positive',
};

const btn = 'inline-flex min-h-10 min-w-10 items-center justify-center rounded-full border border-border-strong px-3 text-sm text-ink transition-colors hover:bg-surface disabled:cursor-not-allowed disabled:text-subtle disabled:opacity-60';

/**
 * Plays a cross's recorded events in order. Controls: buttons, a slider, and keys on the player itself (Space plays or pauses,
 * arrows step, Home and End jump). The full ordered list below it is the text version of the same replay: every event with its
 * time, slot and transaction link, readable without playing anything.
 */
export function ReplayPlayer({ replay, market: m, cluster }: { replay: ReplayResponse; market: Market; cluster: 'devnet' | 'mainnet-beta' }) {
  const events = replay.events;
  const last = events.length;
  const [step, setStep] = useState(1); // 1-based: the number of events shown
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]['id']>('normal');
  const [announce, setAnnounce] = useState('');
  const ids = { speed: useId(), slider: useId(), help: useId() };
  const prevLast = useRef(last);

  // A live cross grows while it is watched: a viewer who is at the end stays at the end.
  useEffect(() => {
    setStep((s) => (s >= prevLast.current ? last : Math.min(s, last)));
    prevLast.current = last;
  }, [last]);

  const ms = SPEEDS.find((s) => s.id === speed)!.ms;
  useEffect(() => {
    if (!playing) return;
    const t = setInterval(() => setStep((s) => Math.min(s + 1, last)), ms);
    return () => clearInterval(t);
  }, [playing, ms, last]);
  // Playing stops by itself on the last event.
  useEffect(() => {
    if (playing && step >= last) setPlaying(false);
  }, [playing, step, last]);

  const tally = useMemo(() => tallyAt(events, step), [events, step]);
  const positions = useMemo(() => axisPositions(events), [events]);
  const first = events[0]?.time ?? null;
  const current = events[step - 1];

  const go = useCallback(
    (n: number, say = true) => {
      const next = Math.max(1, Math.min(n, last));
      setStep(next);
      if (say) setAnnounce(`Event ${next} of ${last}: ${events[next - 1] ? describeEvent(events[next - 1]!, m) : ''}`);
    },
    [events, last, m],
  );

  const toggle = useCallback(() => {
    if (!playing && step >= last) setStep(1);
    setAnnounce(playing ? 'Paused.' : 'Playing.');
    setPlaying(!playing);
  }, [playing, step, last]);

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    // Keys act on the player itself; a focused button, slider or menu keeps its own keys.
    if (e.target !== e.currentTarget) {
      if (e.key === 'Escape') setPlaying(false);
      return;
    }
    const k = e.key;
    if (k === ' ' || k === 'k') toggle();
    else if (k === 'ArrowRight' || k === 'l') go(step + 1);
    else if (k === 'ArrowLeft' || k === 'j') go(step - 1);
    else if (k === 'Home') go(1);
    else if (k === 'End') go(last);
    else if (k === 'Escape') setPlaying(false);
    else return;
    e.preventDefault();
  };

  if (last === 0 || !current) return <p className="text-sm text-muted">No events have been recorded for this cross yet.</p>;

  return (
    <div className="space-y-6">
      <div
        role="group"
        aria-label="Replay of this cross"
        aria-describedby={ids.help}
        tabIndex={0}
        onKeyDown={onKey}
        className="rounded-[var(--radius-card)] border border-border p-4 focus-visible:outline-offset-4 sm:p-5"
        data-testid="replay-player"
      >
        <p id={ids.help} className="text-xs text-muted">
          Focus this box, then Space plays or pauses, the left and right arrows step, Home and End jump to the first and last event. The same events are listed in full below.
        </p>

        <div className="mt-4 flex flex-wrap items-center gap-2" role="toolbar" aria-label="Replay controls">
          <button type="button" className={btn} onClick={() => go(1)} disabled={step === 1} aria-label="First event">
            <span aria-hidden="true">|&lt;</span>
          </button>
          <button type="button" className={btn} onClick={() => go(step - 1)} disabled={step === 1} aria-label="Previous event">
            <span aria-hidden="true">&lt;</span>
          </button>
          <button type="button" className="inline-flex min-h-10 min-w-24 items-center justify-center rounded-full border border-ink bg-ink px-3 text-sm text-bg transition-opacity hover:opacity-90" onClick={toggle} data-testid="replay-toggle">
            {playing ? 'Pause' : step >= last ? 'Replay' : 'Play'}
          </button>
          <button type="button" className={btn} onClick={() => go(step + 1)} disabled={step === last} aria-label="Next event">
            <span aria-hidden="true">&gt;</span>
          </button>
          <button type="button" className={btn} onClick={() => go(last)} disabled={step === last} aria-label="Last event">
            <span aria-hidden="true">&gt;|</span>
          </button>
          <label htmlFor={ids.speed} className="ml-auto text-sm text-muted">
            Speed
          </label>
          <select id={ids.speed} value={speed} onChange={(e) => setSpeed(e.target.value as typeof speed)} className="h-10 rounded-lg border border-border-strong bg-bg px-2 text-sm text-ink">
            {SPEEDS.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        </div>

        <div className="mt-5">
          <label htmlFor={ids.slider} className="mb-1 block text-xs text-muted">
            Event {step} of {last}
          </label>
          <input
            id={ids.slider}
            type="range"
            min={1}
            max={last}
            value={step}
            onChange={(e) => go(Number(e.target.value))}
            aria-valuetext={`Event ${step} of ${last}: ${kindLabel(current.kind)}`}
            className="h-6 w-full accent-[var(--accent-fill)]"
          />
          {/* The events on a real time axis: where in the cross's life each one happened. Decoration; the list below says the same in words. */}
          <div className="relative mt-1 h-3" aria-hidden="true" data-testid="replay-axis">
            <div className="absolute inset-x-0 top-1/2 h-px bg-border-strong" />
            {events.map((e, i) => (
              <span key={e.n} className={`absolute top-1/2 size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full ${KIND_DOT[e.kind] ?? 'bg-border-strong'} ${i + 1 > step ? 'opacity-30' : ''} ${i + 1 === step ? 'ring-2 ring-accent-fill ring-offset-1 ring-offset-bg' : ''}`} style={{ left: `${(positions[i] ?? 0) * 100}%` }} />
            ))}
          </div>
          <p className="mt-1 flex justify-between font-mono text-[11px] text-muted" aria-hidden="true">
            <span>{first ? utcStamp(first).slice(11, 19) : ''}</span>
            <span>{events.at(-1)?.time ? utcStamp(events.at(-1)!.time).slice(11, 19) : ''} UTC</span>
          </p>
        </div>

        <div className="mt-5 rounded-lg bg-surface p-4" data-testid="replay-now">
          <p className="flex flex-wrap items-center gap-2 font-mono text-xs uppercase tracking-widest text-muted">
            <span className={`size-2 rounded-full ${KIND_DOT[current.kind] ?? 'bg-border-strong'}`} aria-hidden="true" />
            {kindLabel(current.kind)}
            <span className="normal-case tracking-normal">{elapsedSince(first, current.time) ?? ''}</span>
          </p>
          <p className="mt-2 text-sm leading-relaxed">{describeEvent(current, m)}</p>
          <dl className="mt-3 grid gap-x-6 gap-y-1 text-xs text-muted sm:grid-cols-[auto_1fr]">
            <dt>Time</dt>
            <dd className="font-mono">{current.time ? <time dateTime={current.time}>{utcStamp(current.time)}</time> : 'not recorded by the index'}</dd>
            <dt>Slot</dt>
            <dd className="font-mono">{current.slot}</dd>
            <dt>Transaction</dt>
            <dd className="flex flex-wrap items-center gap-2 font-mono">
              <a className="break-all text-accent-text underline underline-offset-2" href={explorerTx(current.signature, cluster)} target="_blank" rel="noreferrer">
                {shortAddress(current.signature)}
                <span className="sr-only"> (opens the Solana explorer in a new tab)</span>
              </a>
              <CopyButton value={current.signature} label={`Copy the transaction signature of event ${current.n}`} />
            </dd>
          </dl>
        </div>

        <div className="mt-4 grid gap-3 text-sm sm:grid-cols-2" data-testid="replay-state">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1">
            <dt className="text-muted">Stage</dt>
            <dd className="font-medium capitalize">{tally.phase}</dd>
            <dt className="text-muted">Orders placed</dt>
            <dd className="font-mono">{tally.placed}</dd>
            <dt className="text-muted">Still open</dt>
            <dd className="font-mono">{tally.open}</dd>
            <dt className="text-muted">Cancelled</dt>
            <dd className="font-mono">{tally.cancelled}</dd>
            {replay.summary.revealed > 0 || tally.sealedHidden > 0 ? (
              <>
                <dt className="text-muted">Sealed, hidden</dt>
                <dd className="font-mono">{tally.sealedHidden}</dd>
              </>
            ) : null}
            <dt className="text-muted">Settled</dt>
            <dd className="font-mono">{tally.claimed}</dd>
          </dl>
          <div>
            <p className="text-muted">Limit prices in the book, from events</p>
            {tally.cleared ? (
              <p className="mt-1 text-xs text-muted">The book closed when the cross cleared.</p>
            ) : tally.levels.length === 0 ? (
              <p className="mt-1 text-xs text-muted">{tally.sealedHidden > 0 ? 'Only sealed orders so far: their prices stay hidden until the reveal.' : 'No order with a public price yet.'}</p>
            ) : (
              <div role="region" aria-label="Limit prices placed so far" tabIndex={0} className="mt-1 max-h-32 overflow-y-auto">
                <table className="w-full text-left font-mono text-xs">
                  <thead className="text-muted">
                    <tr>
                      <th scope="col" className="pr-3 font-normal">Price</th>
                      <th scope="col" className="pr-3 text-right font-normal">Buy</th>
                      <th scope="col" className="text-right font-normal">Sell</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tally.levels.map((l) => (
                      <tr key={l.price.toString()}>
                        <td className="pr-3">{formatPrice(l.price, m)}</td>
                        <td className="pr-3 text-right">{l.buy > 0n ? formatAtoms(l.buy, m.baseDecimals) : '0'}</td>
                        <td className="text-right">{l.sell > 0n ? formatAtoms(l.sell, m.baseDecimals) : '0'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="mt-2 text-xs text-muted">Built from order events only. The issuer&apos;s own supply is not an event, so the clearing price is not recomputed here; it appears at the Cleared event, as the chain recorded it.</p>
          </div>
        </div>
        <p role="status" aria-live="polite" className="sr-only">
          {announce}
        </p>
      </div>

      <EventList events={events} step={step} onGo={(n) => go(n)} m={m} cluster={cluster} first={first} />
    </div>
  );
}

/** The text version of the replay: every event in order, readable and linkable without playing anything. */
function EventList({ events, step, onGo, m, cluster, first }: { events: ReplayEvent[]; step: number; onGo: (n: number) => void; m: Market; cluster: 'devnet' | 'mainnet-beta'; first: string | null }) {
  const id = useId();
  return (
    <section aria-labelledby={id}>
      <h3 id={id} className="font-mono text-xs uppercase tracking-widest text-muted">
        All {events.length} events, in order
      </h3>
      <div role="region" aria-label="Every event of this cross, in order" tabIndex={0} className="mt-3 max-h-[28rem] overflow-y-auto rounded-lg border border-border">
        <ol className="divide-y divide-border" data-testid="replay-list">
          {events.map((e) => {
            const on = e.n === step;
            return (
              <li key={`${e.signature}-${e.n}`} aria-current={on ? 'step' : undefined} className={`grid gap-1 px-3 py-2.5 text-sm sm:grid-cols-[2.5rem_9.5rem_1fr_auto] sm:items-baseline sm:gap-3 ${on ? 'bg-surface' : ''}`}>
                <span className="font-mono text-xs text-muted">{e.n}</span>
                <span className="font-mono text-xs text-muted">
                  {e.time ? <time dateTime={e.time}>{utcStamp(e.time).slice(5, 19)} UTC</time> : 'no time'}
                  <span className="block">{elapsedSince(first, e.time) ?? ''}</span>
                </span>
                <span>
                  <span className="font-medium">{kindLabel(e.kind)}.</span> {describeEvent(e, m)}
                  <span className="mt-0.5 block font-mono text-xs text-muted">
                    slot {e.slot} ·{' '}
                    <a className="text-accent-text underline underline-offset-2" href={explorerTx(e.signature, cluster)} target="_blank" rel="noreferrer">
                      {shortAddress(e.signature)}
                      <span className="sr-only"> (opens the Solana explorer in a new tab)</span>
                    </a>
                  </span>
                </span>
                <button type="button" onClick={() => onGo(e.n)} className="min-h-8 justify-self-start rounded-full border border-border px-3 text-xs text-muted hover:bg-bg hover:text-ink sm:justify-self-end" aria-label={`Show event ${e.n} in the replay`}>
                  Show
                </button>
              </li>
            );
          })}
        </ol>
      </div>
    </section>
  );
}
