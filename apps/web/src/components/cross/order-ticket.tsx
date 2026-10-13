'use client';

import { useEffect, useState } from 'react';
import { readTokenBalance, shortfall } from '@/lib/balance';
import { ActionError, type Signer } from '@/lib/tx';
import type { BookResponse, CrossDetail } from '@/lib/types';
import { type Market, buyerPays, formatAtoms, formatPrice, parseAtoms, parsePrice } from '@/lib/units';
import { downloadBackup, loadBids, randomNonce, randomSalt, rememberOrder, saveBid } from '@/lib/sealed';
import { Eligibility } from '@/components/gate/eligibility';
import { RiskAck, useRiskAck } from '@/components/portfolio/risk-ack';
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

export function OrderTicket({ cross, market: m, owner, sign, book, onPlaced }: { cross: CrossDetail; market: Market; owner: string; sign: Signer; book: BookResponse | null; onPlaced: () => void }) {
  const [side, setSide] = useState<Side>('buy');
  const [priceText, setPriceText] = useState('');
  const [qtyText, setQtyText] = useState('');
  const [placed, setPlaced] = useState<string | null>(null);
  const sealed = cross.disclosure === 'sealed';
  const risk = useRiskAck(owner);

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
  const preview = ready ? previewOrder({ side, price, quantity: qty, market: m, grid: cross.grid, feeBps, sealed, book }) : null;

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
            <input type="radio" name="side" value={s} checked={side === s} onChange={() => setSide(s)} className="peer sr-only" />
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
        <span className="text-muted">Tokens</span>
        <input
          inputMode="decimal"
          value={qtyText}
          onChange={(e) => setQtyText(e.target.value)}
          aria-invalid={Boolean(qtyError)}
          className="mt-1 w-full rounded-lg border border-border-strong bg-bg px-3 py-2.5 font-mono"
          placeholder="0"
        />
      </label>
      {qtyError ? <p className="mt-1 text-xs text-accent-text">{qtyError}</p> : null}

      {escrow !== null && ready && preview ? (
        <div className="mt-4 space-y-3 rounded-lg bg-surface p-3 text-sm" data-testid="preview">
          <p>
            {side === 'buy'
              ? `Up to ${formatAtoms(escrow, m.quoteDecimals)} is held in escrow. You pay the clearing price for what you are filled; the rest comes back at settlement.`
              : `${formatAtoms(escrow, m.baseDecimals)} tokens are held in escrow. You receive at least ${formatAtoms((qty! * (price as bigint)) / m.priceScale, m.quoteDecimals)} less the ${feeBps / 100}% seller fee for what is filled.`}
            {sealed ? ' Your price stays sealed until you reveal it after the close.' : ''}
          </p>
          <PreviewDetail p={preview} side={side} market={m} quantity={qty!} />
        </div>
      ) : null}

      {missing > 0n && held !== null && escrow !== null ? (
        <p role="alert" className="mt-3 text-sm text-accent-text" data-testid="shortfall">
          This wallet holds {formatAtoms(held, lockDecimals)} of the {side === 'buy' ? 'quote token' : 'token'} and the order locks up to {formatAtoms(escrow, lockDecimals)}. It needs {formatAtoms(missing, lockDecimals)} more.
        </p>
      ) : null}
      {cross.gateMint ? <Eligibility cross={cross.address} gateMint={cross.gateMint} owner={owner} sign={sign} /> : null}
      <RiskAck {...risk} />
      <div className="mt-4">
        {(() => {
          const nonce = randomNonce();
          const salt = sealed ? randomSalt() : undefined;
          return (
            <ActionButton
              label={sealed ? 'Place sealed order' : 'Place order'}
              path="/v1/tx/place-order"
              disabled={!ready || risk.acknowledged !== true || missing > 0n}
              sign={sign}
              before={() => {
                if (risk.acknowledged !== true) throw new ActionError('Read and accept the risks above before your first order.');
                // The reveal needs these; keep them before anything is signed.
                if (sealed && !saveBid({ cross: cross.address, owner, nonce, side, price: String(price), quantity: String(qty), salt: salt!, placedAt: new Date().toISOString() })) {
                  throw new ActionError('This browser could not store your sealed bid, so it could not be revealed later. Nothing was sent.');
                }
              }}
              body={() => ({ cross: cross.address, owner, side, price: String(price), quantity: String(qty), nonce, ...(salt ? { salt } : {}) })}
              onDone={(sigs, extra) => {
                if (typeof extra.order === 'string') {
                  rememberOrder(cross.address, owner, extra.order);
                  // An open order's price is not served by the API; keep it here so the book chart can mark it.
                  if (!sealed) rememberTerms(cross.address, owner, extra.order, { side, price: String(price), quantity: String(qty) });
                }
                setPlaced(sigs[0] ?? null);
                setPriceText('');
                setQtyText('');
                setRefresh((n) => n + 1);
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

const share = (bps: bigint) => `${(Number(bps) / 100).toFixed(1)}%`;
const percent = (bps: bigint) => `${bps > 0n ? '+' : ''}${(Number(bps) / 100).toFixed(1)}%`;

/** What signing would do, from the live book, before anything is signed. */
function PreviewDetail({ p, side, market: m, quantity }: { p: OrderPreview; side: Side; market: Market; quantity: bigint }) {
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
          <dd>Bids are sealed, so the book is hidden and there is no indicative price to compare with. Only what your own order fixes is shown here.</dd>
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
              ? 'The supply on offer is not visible while bids are sealed.'
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
