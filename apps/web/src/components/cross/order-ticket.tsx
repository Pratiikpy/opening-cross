'use client';

import { useEffect, useState } from 'react';
import { readTokenBalance, shortfall } from '@/lib/balance';
import { ActionError, type Signer } from '@/lib/tx';
import type { BookResponse, CrossDetail } from '@/lib/types';
import { type Market, buyerPays, formatAtoms, formatPrice, parseAtoms, parsePrice } from '@/lib/units';
import { downloadBackup, loadBids, randomNonce, randomSalt, rememberOrder, saveBid } from '@/lib/sealed';
import { Eligibility } from '@/components/gate/eligibility';
import { HOLDER_API_URL } from '@/lib/holder-api';
import { SOL_NEEDED, useLamports, useSponsor } from './holder-readiness';
import { RiskAck, useRiskAck } from '@/components/portfolio/risk-ack';
import { type ClassId, type RulesRead, type Standing, blocked, classOptions, endingNow, needsAck, ticketChecks } from '@/lib/holder-rules';
import type { Built } from '@/lib/holder-tx';
import { ActionButton } from './action-button';
import { rememberTerms } from './own-orders';
import { type OrderPreview, previewOrder } from './preview';

type Side = 'buy' | 'sell';

/** Checks a typed price against the cross's grid; returns the on-chain price or a message. */
function onGrid(text: string, c: CrossDetail, m: Market): bigint | string {
  const p = parsePrice(text, m);
  const min = BigInt(c.grid.minPrice);
  const tick = BigInt(c.grid.tick);
  const max = min + BigInt(c.grid.ticks - 1) * tick;
  const range = `between ${formatPrice(min, m)} and ${formatPrice(max, m)}, in steps of ${formatPrice(tick, { ...m })}`;
  if (p === null) return `Enter a price ${range}.`;
  if (p < min || p > max) return `The price must be ${range}.`;
  if ((p - min) % tick !== 0n) {
    const below = min + ((p - min) / tick) * tick;
    return `Prices move in steps of ${formatPrice(tick, m)}. Try ${formatPrice(below, m)} or ${formatPrice(below + tick, m)}.`;
  }
  return p;
}

const DAY = 86_400;

export function OrderTicket({
  cross,
  market: m,
  owner,
  sign,
  book,
  onPlaced,
  rules,
  standing,
  now,
}: {
  cross: CrossDetail;
  market: Market;
  owner: string;
  sign: Signer;
  book: BookResponse | null;
  onPlaced: () => void;
  /** The cross's rules (GET /v1/crosses/:address/rules); `undefined` until read. A cross with rules gets the class choices and the checks. */
  rules: RulesRead | null | undefined;
  standing: Standing | null;
  now: bigint;
}) {
  const [side, setSide] = useState<Side>('buy');
  const ruled = rules?.rules ?? null;
  const [cls, setCls] = useState<ClassId>(0);
  const [lockDays, setLockDays] = useState('');
  const [acked, setAcked] = useState(false);
  const [priceText, setPriceText] = useState('');
  const [qtyText, setQtyText] = useState('');
  const [placed, setPlaced] = useState<string | null>(null);
  const sealed = cross.disclosure === 'sealed';
  const risk = useRiskAck(owner);
  // A wallet with tokens but too little SOL can have the network fee and the order account's deposit paid for it, where the deployment offers that.
  const sponsor = useSponsor();
  const [sponsorRefresh, setSponsorRefresh] = useState(0);
  const lamports = useLamports(owner, sponsorRefresh);
  const sponsorOffered = ruled === null && rules !== undefined && sponsor?.enabled === true && lamports !== null && lamports < SOL_NEEDED;
  const [sponsorChoice, setSponsorChoice] = useState(true);
  const sponsored = sponsorOffered && sponsorChoice;

  const price = priceText ? onGrid(priceText, cross, m) : null;
  const qty = qtyText ? parseAtoms(qtyText, m.baseDecimals) : null;
  const qtyError = qtyText && (qty === null || qty === 0n) ? `Enter an amount of tokens, up to ${m.baseDecimals} decimal places.` : null;
  const ready = typeof price === 'bigint' && qty !== null && qty > 0n;
  const escrow = ready ? (side === 'buy' ? buyerPays(qty, price, m.priceScale) : qty) : null;
  const feeBps = cross.fees.protocolBps + cross.fees.integratorBps;
  // What the wallet holds of the token this order locks up; an order it cannot fund is stopped here, with the shortfall.
  const [held, setHeld] = useState<bigint | null>(null);
  const [refresh, setRefresh] = useState(0);
  const lockMint = side === 'buy' ? cross.quoteMint : cross.baseMint;
  useEffect(() => {
    let live = true;
    setHeld(null);
    if (lockMint) void readTokenBalance(owner, lockMint).then((v) => live && setHeld(v));
    return () => {
      live = false;
    };
  }, [owner, lockMint, refresh]);
  const lockDecimals = side === 'buy' ? m.quoteDecimals : m.baseDecimals;
  const missing = escrow !== null ? shortfall(held, escrow) : 0n;
  // The ending period: the figures the book would give are shown only in coarse form, so the preview does not hand them out either.
  const ending = endingNow(ruled, rules?.state, BigInt(cross.window.closeTs), now);
  const coarseEnding = ending.kind === 'ending';
  const preview = ready ? previewOrder({ side, price, quantity: qty, market: m, grid: cross.grid, feeBps, sealed: sealed || coarseEnding, book }) : null;

  // The rules: which classes this wallet can take, and what stops or needs accepting before the wallet is asked to sign.
  const the = standing ?? { gatePass: null, priorityPass: null, usage: null };
  const options = ruled ? classOptions(ruled, { wallet: owner, now, market: m, gated: cross.gateMint !== null }, the) : null;
  const effectiveClass: ClassId = side === 'buy' ? cls : 0;
  const lockSecs = effectiveClass === 2 ? Math.floor(Number(lockDays || '0') * DAY) : 0;
  const lotteryUnit = ruled && effectiveClass === 1 ? BigInt(ruled.alloc.lotteryUnit) : 0n;
  const checks = ruled
    ? ticketChecks({ rules: ruled, ...(rules?.state ? { state: rules.state } : {}), ...(rules?.calls ? { calls: rules.calls } : {}), wallet: owner, side, cls: effectiveClass, lockSecs, escrow: ready ? escrow : null, quantity: ready ? qty : null, now, closeTs: BigInt(cross.window.closeTs), market: m, gated: cross.gateMint !== null, standing: the })
    : [];
  const stops = blocked(checks);
  const acks = needsAck(checks);
  const rulesPending = rules === undefined;

  return (
    <section aria-labelledby="ticket" className="rounded-[var(--radius-card)] border border-border p-5">
      <h2 id="ticket" className="font-medium">
        Place an order
      </h2>
      {cross.supplyMode !== 'escrow' ? (
        <p className="mt-1 text-sm text-muted">The issuer's supply is set by its schedule; this cross takes buy orders only.</p>
      ) : null}
      <fieldset className={`mt-4 grid rounded-full border border-border p-1 text-sm ${cross.supplyMode === 'escrow' ? 'grid-cols-2' : 'hidden'}`}>
        <legend className="sr-only">Side</legend>
        {(['buy', 'sell'] as const).map((s) => (
          <label key={s} className="block">
            <input type="radio" name="side" value={s} checked={side === s} onChange={() => { setSide(s); setCls(0); setAcked(false); }} className="peer sr-only" />
            <span className="block cursor-pointer rounded-full py-2 text-center capitalize text-muted peer-checked:bg-ink peer-checked:text-bg peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-[var(--focus)] hover:text-ink peer-checked:hover:text-bg">
              {s}
            </span>
          </label>
        ))}
      </fieldset>
      <label className="mt-4 block text-sm">
        <span className="text-muted">{side === 'buy' ? 'Most you would pay per token' : 'Least you would take per token'}</span>
        <input
          inputMode="decimal"
          value={priceText}
          onChange={(e) => setPriceText(e.target.value)}
          aria-invalid={typeof price === 'string'}
          aria-describedby="price-help"
          className="mt-1 w-full rounded-lg border border-border-strong bg-bg px-3 py-2.5 font-mono"
          placeholder={formatPrice(BigInt(cross.grid.minPrice), m)}
        />
      </label>
      <p id="price-help" className={`mt-1 text-xs ${typeof price === 'string' ? 'text-accent-text' : 'text-muted'}`}>
        {typeof price === 'string' ? price : 'Everyone who is filled pays the same clearing price, which is never worse than your limit.'}
      </p>
      <label className="mt-4 block text-sm">
        <span className="text-muted">{lotteryUnit > 0n ? 'Tokens (one lot, fixed by the class)' : 'Tokens'}</span>
        <input
          inputMode="decimal"
          value={lotteryUnit > 0n ? formatAtoms(lotteryUnit, m.baseDecimals) : qtyText}
          onChange={(e) => setQtyText(e.target.value)}
          readOnly={lotteryUnit > 0n}
          aria-invalid={Boolean(qtyError)}
          className="mt-1 w-full rounded-lg border border-border-strong bg-bg px-3 py-2.5 font-mono"
          placeholder="0"
        />
      </label>
      {qtyError ? <p className="mt-1 text-xs text-accent-text">{qtyError}</p> : null}

      {ruled && options && side === 'buy' && options.length > 1 ? (
        <fieldset className="mb-4 mt-5" data-testid="class-choice">
          <legend className="text-sm text-muted">How this order shares the volume at the margin</legend>
          <div className="mt-2 space-y-2">
            {options.map((o) => (
              <label key={o.id} className={`flex min-h-6 items-start gap-3 rounded-lg border p-3 text-sm ${cls === o.id ? 'border-accent' : 'border-border'} ${o.available ? 'cursor-pointer' : 'opacity-70'}`}>
                <input
                  type="radio"
                  name="class"
                  value={o.id}
                  checked={cls === o.id}
                  disabled={!o.available}
                  onChange={() => {
                    setCls(o.id);
                    setAcked(false);
                    if (o.id === 1 && ruled && BigInt(ruled.alloc.lotteryUnit) > 0n) setQtyText(formatAtoms(BigInt(ruled.alloc.lotteryUnit), m.baseDecimals));
                  }}
                  className="mt-0.5 size-5 shrink-0 accent-[var(--accent-fill)]"
                />
                <span>
                  <span className="block font-medium">{o.label}</span>
                  <span className="mt-0.5 block text-xs text-muted">{o.summary}</span>
                  {o.why ? <span className="mt-0.5 block text-xs">{o.why}</span> : null}
                </span>
              </label>
            ))}
          </div>
          {cls === 2 ? (
            <label className="mt-3 block text-sm">
              <span className="text-muted">Lock the tokens you receive for how many days (at least {Number((ruled.alloc.minLockSecs / DAY).toFixed(2))})</span>
              <input inputMode="decimal" value={lockDays} onChange={(e) => setLockDays(e.target.value)} className="mt-1 w-full rounded-lg border border-border-strong bg-bg px-3 py-2.5 font-mono" placeholder={String(Math.ceil(ruled.alloc.minLockSecs / DAY))} data-testid="lock-days" />
            </label>
          ) : null}
        </fieldset>
      ) : null}

      {escrow !== null && ready && preview ? (
        <div className="mt-4 space-y-3 rounded-lg bg-surface p-3 text-sm" data-testid="preview">
          <p>
            {side === 'buy'
              ? `Up to ${formatAtoms(escrow, m.quoteDecimals)} is held in escrow. You pay the clearing price for what you are filled; the rest comes back at settlement.`
              : `${formatAtoms(escrow, m.baseDecimals)} tokens are held in escrow. You receive at least ${formatAtoms((qty! * (price as bigint)) / m.priceScale, m.quoteDecimals)} less the ${feeBps / 100}% seller fee for what is filled.`}
            {sealed ? ' Your price stays sealed until you reveal it after the close.' : ''}
          </p>
          <PreviewDetail p={preview} side={side} market={m} quantity={qty!} hiddenBy={coarseEnding ? 'ending' : 'sealed'} />
        </div>
      ) : null}

      {missing > 0n && held !== null && escrow !== null ? (
        <p role="alert" className="mt-3 text-sm text-accent-text" data-testid="shortfall">
          This wallet holds {formatAtoms(held, lockDecimals)} of the {side === 'buy' ? 'quote token' : 'token'} and the order locks up to {formatAtoms(escrow, lockDecimals)}. It needs {formatAtoms(missing, lockDecimals)} more.
        </p>
      ) : null}
      {sponsorOffered ? (
        <label className="mt-4 flex min-h-6 cursor-pointer items-start gap-3 rounded-lg border border-border p-3 text-sm" data-testid="sponsor-choice">
          <input type="checkbox" checked={sponsorChoice} onChange={(e) => setSponsorChoice(e.target.checked)} className="mt-0.5 size-5 shrink-0 accent-[var(--accent-fill)]" />
          <span>
            <span className="block font-medium">Let Opening Bell pay the fee</span>
            <span className="mt-0.5 block text-xs text-muted">This wallet holds {formatAtoms(lamports ?? 0n, 9, 4)} SOL. Opening Bell pays the network fee and puts in the deposit for the order account (about 0.0016 SOL, returned to you when the order is claimed or cancelled). It does not pay for the tokens in escrow. Devnet only, a few orders per wallet per day.</span>
          </span>
        </label>
      ) : null}
      {cross.gateMint ? <Eligibility cross={cross.address} gateMint={cross.gateMint} owner={owner} sign={sign} /> : null}
      {rulesPending ? (
        <p role="status" className="mt-4 text-xs text-muted">
          Reading this cross’s rules before you can place an order…
        </p>
      ) : null}
      {ruled && checks.length > 0 ? (
        <div className="mt-4 space-y-2 text-sm" data-testid="rule-checks">
          {stops.length > 0 ? (
            <ul role="alert" className="space-y-1 text-accent-text" data-testid="rule-blocks">
              {stops.map((c) => (
                <li key={c.id}>{c.message}</li>
              ))}
            </ul>
          ) : null}
          {checks
            .filter((c) => c.level === 'note')
            .map((c) => (
              <p key={c.id} className="text-xs text-muted" data-testid="rule-note">
                {c.message}
              </p>
            ))}
          {acks.length > 0 ? (
            <label className="flex min-h-6 cursor-pointer items-start gap-3 rounded-lg border border-border p-3" data-testid="rule-ack">
              <input type="checkbox" checked={acked} onChange={(e) => setAcked(e.target.checked)} className="mt-0.5 size-5 shrink-0 accent-[var(--accent-fill)]" />
              <span>
                {acks.map((c) => (
                  <span key={c.id} className="block">
                    {c.message}
                  </span>
                ))}
                <span className="mt-1 block font-medium">I understand and want to place this order.</span>
              </span>
            </label>
          ) : null}
        </div>
      ) : null}
      <RiskAck {...risk} />
      <div className="mt-4">
        {(() => {
          const nonce = randomNonce();
          const salt = sealed ? randomSalt() : undefined;
          return (
            <ActionButton
              label={sealed ? 'Place sealed order' : 'Place order'}
              path={ruled ? '/v1/tx/place-order-ext' : sponsored ? `${HOLDER_API_URL}/v1/tx/place-order-sponsored` : '/v1/tx/place-order'}
              disabled={!ready || risk.acknowledged !== true || missing > 0n || rulesPending || stops.length > 0 || (acks.length > 0 && !acked)}
              testId="place-order"
              sign={sign}
              hold={ruled && ruled.ending.endingSecs > 0 ? { secs: 12, validUntil: placementEnd, now: () => BigInt(Math.floor(Date.now() / 1000)) } : undefined}
              before={() => {
                if (risk.acknowledged !== true) throw new ActionError('Read and accept the risks above before your first order.');
                // The reveal needs these; keep them before anything is signed.
                if (sealed && !saveBid({ cross: cross.address, owner, nonce, side, price: String(price), quantity: String(qty), salt: salt!, placedAt: new Date().toISOString() })) {
                  throw new ActionError('This browser could not store your sealed bid, so it could not be revealed later. Nothing was sent.');
                }
              }}
              body={() => ({ cross: cross.address, owner, side, price: String(price), quantity: String(qty), nonce, ...(salt ? { salt } : {}), ...(ruled && side === 'buy' ? { class: effectiveClass, ...(effectiveClass === 2 ? { lockSecs } : {}) } : {}) })}
              onDone={(sigs, extra) => {
                if (typeof extra.order === 'string') {
                  rememberOrder(cross.address, owner, extra.order);
                  // An open order's price is not served by the API; keep it here so the book chart can mark it.
                  if (!sealed) rememberTerms(cross.address, owner, extra.order, { side, price: String(price), quantity: String(qty) });
                }
                setPlaced(sigs[0] ?? null);
                setPriceText('');
                setQtyText('');
                setAcked(false);
                setRefresh((n) => n + 1);
                setSponsorRefresh((n) => n + 1);
                onPlaced();
              }}
            />
          );
        })()}
      </div>
      {placed ? (
        <div role="status" className="mt-4 rounded-lg border border-border p-3 text-sm">
          <p className="font-medium">Order placed.</p>
          <p className="mt-1 break-all font-mono text-xs text-muted">{placed}</p>
          {sealed ? (
            <button type="button" onClick={() => downloadBackup(loadBids(cross.address, owner))} className="mt-2 text-accent-text underline">
              Download your reveal backup
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

/** The last second a built order is right for, from the answer's `placement`; null when the answer names none. */
function placementEnd(built: Built): bigint | null {
  const p = built.extra.placement as { validUntil?: string | null } | undefined;
  return p && typeof p.validUntil === 'string' && /^\d+$/.test(p.validUntil) ? BigInt(p.validUntil) : null;
}

const share = (bps: bigint) => `${(Number(bps) / 100).toFixed(1)}%`;
const percent = (bps: bigint) => `${bps > 0n ? '+' : ''}${(Number(bps) / 100).toFixed(1)}%`;

/** What signing would do, from the live book, before anything is signed. */
function PreviewDetail({ p, side, market: m, quantity, hiddenBy }: { p: OrderPreview; side: Side; market: Market; quantity: bigint; hiddenBy: 'sealed' | 'ending' }) {
  const quote = (v: bigint) => formatAtoms(v, m.quoteDecimals);
  const tokens = (v: bigint) => formatAtoms(v, m.baseDecimals);
  const outcome = (o: NonNullable<OrderPreview['best']>) =>
    side === 'buy' ? `you pay ${quote(o.quote)} and ${quote(o.other)} comes back` : `you receive ${quote(o.quote)} after a ${quote(o.other)} fee`;
  return (
    <div className="border-t border-border pt-3" data-testid="preview-detail">
    <dl className="space-y-2">
      {p.hidden ? (
        <div>
          <dt className="text-xs text-muted">The book</dt>
          <dd>{hiddenBy === 'ending' ? 'The ending period is open, so this page shows the indicative price only to the nearest band and does not compare your order with the exact book. Only what your own order fixes is shown here.' : 'Bids are sealed, so the book is hidden and there is no indicative price to compare with. Only what your own order fixes is shown here.'}</dd>
        </div>
      ) : (
        <>
          <div>
            <dt className="text-xs text-muted">Best case: filled in full at today’s indicative price</dt>
            <dd data-testid="preview-best">
              {p.best
                ? `At ${formatPrice(p.best.price, m)}, ${outcome(p.best)}.`
                : p.bestMissing === 'limit-does-not-reach'
                  ? `Today’s indicative price is ${formatPrice(p.indicative!, m)}, which your limit does not reach, so at this price your order would not trade.`
                  : 'There is no indicative price yet, because no buy and sell orders cross.'}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted">Worst case: filled in full at your limit</dt>
            <dd data-testid="preview-worst">
              At {formatPrice(p.worst.price, m)}, {outcome(p.worst)}. The price you get is never worse than this.
            </dd>
          </div>
        </>
      )}
      <div>
        <dt className="text-xs text-muted">{side === 'buy' ? 'Your share of the supply' : 'Your share of the supply on offer'}</dt>
        <dd data-testid="preview-share">
          {p.share
            ? side === 'buy'
              ? `${share(p.share.bps)} of the ${tokens(p.share.against)} tokens offered at or below your limit${p.share.bps > 10_000n ? '. You ask for more than is on offer, so you cannot be filled in full' : ''}.`
              : `${share(p.share.bps)} of the ${tokens(p.share.against)} tokens that would be on offer with your order.`
            : p.hidden
              ? (hiddenBy === 'ending' ? 'The supply on offer is not shown in the ending period.' : 'The supply on offer is not visible while bids are sealed.')
              : 'Nothing is offered at or below your limit yet.'}
        </dd>
      </div>
      {!p.hidden ? (
        <div>
          <dt className="text-xs text-muted">Price impact on the indicative price</dt>
          <dd data-testid="preview-impact">
            {p.impact
              ? p.impact.before === null && p.impact.after === null
                ? 'Your order alone would not create a crossing, so there would still be no indicative price.'
                : p.impact.before === null
                  ? `Your order would create the first indicative price, ${formatPrice(p.impact.after!, m)}.`
                  : p.impact.after === null
                    ? 'Your order would remove the crossing, leaving no indicative price.'
                    : p.impact.before === p.impact.after
                      ? `None. The indicative price stays ${formatPrice(p.impact.before, m)}.`
                      : `${formatPrice(p.impact.before, m)} to ${formatPrice(p.impact.after, m)} (${p.impact.bps === null ? 'change not defined' : percent(p.impact.bps)}).`
              : p.impactMissing === 'no-book'
                ? 'Loading the book…'
                : 'Not shown: this page could not reproduce the indicative price from the book as it stands, so it will not guess at the change.'}
            {p.impact && (p.impact.before !== null || p.impact.after !== null) ? ` If the call closed right after your order, it would be filled for ${tokens(p.impact.fill)} of your ${tokens(quantity)}.` : ''}
          </dd>
        </div>
      ) : null}
    </dl>
    <p className="mt-3 text-xs text-muted">Orders can still arrive before the call closes, so this is a preview of the book as it is now, not a promise.</p>
    </div>
  );
}
