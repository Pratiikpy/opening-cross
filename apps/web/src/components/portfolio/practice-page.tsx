'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { BookChart } from '@/components/cross/book-chart';
import { clearBook } from '@/components/cross/clearing';
import { ExampleTag } from '@/components/example-tag';
import { DECIMALS, DURATION, GRID, PLAY_BALANCE, levelsAt, outcome, scenario } from '@/lib/holder-practice';
import type { BookResponse } from '@/lib/types';
import { type Market, buyerPays, formatAtoms, formatDuration, formatPrice, parseAtoms, parsePrice } from '@/lib/units';

const market: Market = { priceScale: BigInt(GRID.priceScale), baseDecimals: DECIMALS.base, quoteDecimals: DECIMALS.quote };
const play = (v: bigint) => `${formatAtoms(v, 6)} play money`;

type Phase = 'ready' | 'running' | 'done';

/** A practice cross: play money, simulated bidders, a 60-second call, cleared by the same rule as a real one. */
export function PracticePage() {
  const [seed, setSeed] = useState(1);
  const orders = useMemo(() => scenario(seed), [seed]);
  const [phase, setPhase] = useState<Phase>('ready');
  const [t, setT] = useState(0);
  const [priceText, setPriceText] = useState('');
  const [qtyText, setQtyText] = useState('');
  const [mine, setMine] = useState<{ side: 'buy'; price: bigint; quantity: bigint } | null>(null);
  const started = useRef(0);

  useEffect(() => {
    if (phase !== 'running') return;
    const id = setInterval(() => {
      const s = Math.min(DURATION, Math.floor((Date.now() - started.current) / 1000));
      setT(s);
      if (s >= DURATION) setPhase('done');
    }, 250);
    return () => clearInterval(id);
  }, [phase]);

  const min = BigInt(GRID.minPrice);
  const tick = BigInt(GRID.tick);
  const price = priceText ? parsePrice(priceText, market) : null;
  const priceError = priceText && (price === null || price < min || price > min + BigInt(GRID.ticks - 1) * tick || (price - min) % tick !== 0n) ? `Prices run from ${formatPrice(min, market)} in steps of ${formatPrice(tick, market)}.` : null;
  const qty = qtyText ? parseAtoms(qtyText, market.baseDecimals) : null;
  const qtyError = qtyText && (qty === null || qty === 0n) ? 'Enter a number of tokens.' : null;
  const escrow = typeof price === 'bigint' && !priceError && qty ? buyerPays(qty, price, market.priceScale) : null;
  const tooMuch = escrow !== null && escrow > PLAY_BALANCE;

  const visible = phase === 'ready' ? 0 : t;
  const levels = levelsAt(orders, visible, mine);
  const indicative = clearBook(levels, GRID);
  const book: BookResponse = {
    disclosure: 'open',
    levels,
    indicative: indicative ? { price: indicative.price.toString(), matched: indicative.matched.toString() } : null,
    note: 'Simulated bidders and a simulated seller. Nothing here is real.',
  };
  const result = phase === 'done' ? outcome(orders, mine) : null;

  function start() {
    started.current = Date.now();
    setT(0);
    setMine(null);
    setPriceText('');
    setQtyText('');
    setPhase('running');
  }
  function reset() {
    setSeed((s) => s + 1);
    setPhase('ready');
    setT(0);
    setMine(null);
    setPriceText('');
    setQtyText('');
  }

  return (
    <div className="mt-8">
      <p className="rounded-[var(--radius-card)] border border-accent px-4 py-3 text-sm" data-testid="practice-banner">
        <span className="font-medium">Practice: no real money.</span> Everything on this page is simulated: the seller, the other bidders and the {formatAtoms(PLAY_BALANCE, 6)} play money you start with. Nothing touches a wallet or the chain. The price is found by the same rule a real cross uses.
      </p>

      <div className="mt-6 grid items-start gap-6 lg:grid-cols-[1.4fr_1fr]">
        <section aria-labelledby="pbook" className="min-w-0 rounded-[var(--radius-card)] border border-border p-4 sm:p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 id="pbook" className="font-mono text-xs uppercase tracking-widest text-muted">
              The book <ExampleTag>Practice</ExampleTag>
            </h2>
            <p className="font-mono text-sm" data-testid="practice-clock" aria-live="off">
              {phase === 'ready' ? `${DURATION}s call` : phase === 'running' ? `Closes in ${formatDuration(BigInt(DURATION - t))}` : 'Closed'}
            </p>
          </div>
          <p className="mt-2 text-sm text-muted" aria-live="polite" data-testid="practice-indicative">
            {phase === 'ready' ? 'Press Start. Bidders arrive during the call and the indicative price moves with them.' : indicative ? `Indicative price now: ${formatPrice(indicative.price, market)} (${formatAtoms(indicative.matched, 6)} tokens would trade).` : 'No crossing orders yet.'}
          </p>
          <div className="mt-5">
            {phase === 'ready' ? (
              <p className="text-sm text-muted">The book is empty until the call starts.</p>
            ) : (
              <BookChart book={book} market={market} clearing={indicative?.price.toString() ?? null} clearingLabel={phase === 'done' ? 'Cleared price' : 'Indicative price'} />
            )}
          </div>
        </section>

        <div className="space-y-6">
          {phase === 'ready' ? (
            <section className="rounded-[var(--radius-card)] border border-border p-5">
              <h2 className="font-medium">How a cross works, in 60 seconds</h2>
              <ol className="mt-3 list-decimal space-y-1.5 pl-5 text-sm text-muted">
                <li>Name the most you would pay per token, and how many you want.</li>
                <li>Your money is held in escrow while the call is open. You can change your mind until it closes.</li>
                <li>When it closes, one price is found. Everyone who trades pays that same price, never worse than their limit.</li>
                <li>What was not used comes back to you.</li>
              </ol>
              <button type="button" onClick={start} className="mt-4 min-h-11 w-full rounded-full bg-accent-fill px-5 py-3 text-sm font-medium text-on-accent hover:opacity-90">
                Start the practice call
              </button>
            </section>
          ) : phase === 'running' ? (
            <section aria-labelledby="pticket" className="rounded-[var(--radius-card)] border border-border p-5">
              <h2 id="pticket" className="font-medium">
                {mine ? 'Your practice order' : 'Place a practice order'}
              </h2>
              <p className="mt-1 text-sm text-muted">You have {play(PLAY_BALANCE - (mine ? buyerPays(mine.quantity, mine.price, market.priceScale) : 0n))} free.</p>
              {mine ? (
                <div className="mt-3 text-sm" data-testid="practice-mine">
                  <p>
                    Buy {formatAtoms(mine.quantity, 6)} tokens at up to {formatPrice(mine.price, market)}. {play(buyerPays(mine.quantity, mine.price, market.priceScale))} is held in escrow.
                  </p>
                  <button type="button" onClick={() => setMine(null)} className="mt-3 min-h-11 rounded-full border border-border-strong px-4 text-sm hover:bg-surface">
                    Cancel and change it
                  </button>
                </div>
              ) : (
                <form
                  className="mt-3"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (typeof price === 'bigint' && !priceError && qty && !tooMuch) setMine({ side: 'buy', price, quantity: qty });
                  }}
                >
                  <label className="block text-sm">
                    <span className="text-muted">Most you would pay per token</span>
                    <input inputMode="decimal" value={priceText} onChange={(e) => setPriceText(e.target.value)} aria-invalid={Boolean(priceError)} className="mt-1 w-full rounded-lg border border-border-strong bg-bg px-3 py-2.5 font-mono" placeholder="1.50" />
                  </label>
                  {priceError ? <p className="mt-1 text-xs text-accent-text">{priceError}</p> : null}
                  <label className="mt-3 block text-sm">
                    <span className="text-muted">Tokens</span>
                    <input inputMode="decimal" value={qtyText} onChange={(e) => setQtyText(e.target.value)} aria-invalid={Boolean(qtyError)} className="mt-1 w-full rounded-lg border border-border-strong bg-bg px-3 py-2.5 font-mono" placeholder="100" />
                  </label>
                  {qtyError ? <p className="mt-1 text-xs text-accent-text">{qtyError}</p> : null}
                  {escrow !== null ? (
                    <p className={`mt-3 text-sm ${tooMuch ? 'text-accent-text' : 'text-muted'}`}>
                      {tooMuch ? `That would hold ${play(escrow)}, more than you have.` : `Up to ${play(escrow)} is held in escrow. You pay the clearing price for what is filled and the rest comes back.`}
                    </p>
                  ) : null}
                  <button type="submit" disabled={typeof price !== 'bigint' || Boolean(priceError) || !qty || tooMuch} className="mt-4 min-h-11 w-full rounded-full bg-accent-fill px-5 py-3 text-sm font-medium text-on-accent hover:opacity-90 disabled:opacity-50">
                    Place practice order
                  </button>
                </form>
              )}
            </section>
          ) : (
            <Debrief result={result!} mine={mine} onReset={reset} />
          )}
        </div>
      </div>
    </div>
  );
}

function Debrief({ result: r, mine, onReset }: { result: ReturnType<typeof outcome>; mine: { price: bigint; quantity: bigint } | null; onReset: () => void }) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const clear = r.cleared;
  const questions = [
    { id: 'price', q: 'Everyone who traded paid…', options: [{ v: 'clearing', t: `The same price: ${clear ? formatPrice(clear.price, market) : 'none'}` }, { v: 'limit', t: 'Their own limit price' }, { v: 'highest', t: 'The highest bid in the book' }], answer: 'clearing', why: 'One clearing price for every order that trades. A limit only says the most you would pay.' },
    { id: 'size', q: 'Did bidding a lot more change what you paid per token?', options: [{ v: 'yes', t: 'Yes, you pay your limit' }, { v: 'no', t: 'No, you pay the clearing price' }], answer: 'no', why: r.higher ? `With a limit of ${formatPrice(r.higher.limit, market)} the run would have charged ${play(r.higher.paid)} for ${formatAtoms(r.higher.fill, 6)} tokens.` : 'A higher limit does not raise the price you pay; it only makes a fill more likely.' },
    { id: 'refund', q: 'What happens to escrow that was not used?', options: [{ v: 'back', t: 'It comes back to you' }, { v: 'fee', t: 'It is kept as a fee' }], answer: 'back', why: mine ? `You held ${play(r.escrow)} and paid ${play(r.paid)}, so ${play(r.refund)} came back.` : 'Unused escrow is refunded in full.' },
  ];
  const done = questions.every((q) => answers[q.id]);
  return (
    <section aria-labelledby="pdebrief" className="rounded-[var(--radius-card)] border border-border p-5" data-testid="practice-debrief">
      <h2 id="pdebrief" className="font-medium">
        The call closed
      </h2>
      {clear ? (
        <p className="mt-2 text-sm">
          One price was found: <span className="font-mono">{formatPrice(clear.price, market)}</span> per token, {formatAtoms(clear.matched, 6)} tokens traded.
        </p>
      ) : (
        <p className="mt-2 text-sm">No price printed: no buyer and seller overlapped, so every order is refunded in full.</p>
      )}
      {mine ? (
        <p className="mt-2 text-sm" data-testid="practice-result">
          Your order: {r.fill > 0n ? `filled for ${formatAtoms(r.fill, 6)} of ${formatAtoms(mine.quantity, 6)} tokens at ${formatPrice(clear!.price, market)}, paying ${play(r.paid)}. ${play(r.refund)} came back.` : `not filled (your limit was below the price). All ${play(r.escrow)} came back.`}
        </p>
      ) : (
        <p className="mt-2 text-sm text-muted">You did not place an order, so nothing was held or paid.</p>
      )}
      <h3 className="mt-5 text-sm font-medium">Three questions</h3>
      <div className="mt-2 space-y-4">
        {questions.map((q) => (
          <fieldset key={q.id}>
            <legend className="text-sm">{q.q}</legend>
            <div className="mt-1.5 space-y-1.5">
              {q.options.map((o) => (
                <label key={o.v} className="flex min-h-11 cursor-pointer items-center gap-3 rounded-lg border border-border px-3 text-sm has-[:checked]:border-border-strong has-[:checked]:bg-surface">
                  <input type="radio" name={q.id} value={o.v} checked={answers[q.id] === o.v} onChange={() => setAnswers((a) => ({ ...a, [q.id]: o.v }))} className="size-4 accent-[var(--accent-fill)]" />
                  {o.t}
                </label>
              ))}
            </div>
            {answers[q.id] ? (
              <p role="status" className="mt-1.5 text-xs text-muted" data-testid={`why-${q.id}`}>
                {answers[q.id] === q.answer ? 'Right. ' : 'Not quite. '}
                {q.why}
              </p>
            ) : null}
          </fieldset>
        ))}
      </div>
      <button type="button" onClick={onReset} className="mt-5 min-h-11 w-full rounded-full bg-accent-fill px-5 py-3 text-sm font-medium text-on-accent hover:opacity-90">
        {done ? 'Practice again with new bidders' : 'Reset'}
      </button>
    </section>
  );
}
