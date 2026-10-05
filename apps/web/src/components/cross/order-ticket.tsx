'use client';

import { useState } from 'react';
import { ActionError, type Signer } from '@/lib/tx';
import type { CrossDetail } from '@/lib/types';
import { type Market, buyerPays, formatAtoms, formatPrice, parseAtoms, parsePrice } from '@/lib/units';
import { downloadBackup, loadBids, randomNonce, randomSalt, rememberOrder, saveBid } from '@/lib/sealed';
import { ActionButton } from './action-button';

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

export function OrderTicket({ cross, market: m, owner, sign, onPlaced }: { cross: CrossDetail; market: Market; owner: string; sign: Signer; onPlaced: () => void }) {
  const [side, setSide] = useState<Side>('buy');
  const [priceText, setPriceText] = useState('');
  const [qtyText, setQtyText] = useState('');
  const [placed, setPlaced] = useState<string | null>(null);
  const sealed = cross.disclosure === 'sealed';

  const price = priceText ? onGrid(priceText, cross, m) : null;
  const qty = qtyText ? parseAtoms(qtyText, m.baseDecimals) : null;
  const qtyError = qtyText && (qty === null || qty === 0n) ? `Enter an amount of tokens, up to ${m.baseDecimals} decimal places.` : null;
  const ready = typeof price === 'bigint' && qty !== null && qty > 0n;
  const escrow = ready ? (side === 'buy' ? buyerPays(qty, price, m.priceScale) : qty) : null;
  const feeBps = cross.fees.protocolBps + cross.fees.integratorBps;

  return (
    <section aria-labelledby="ticket" className="rounded-[var(--radius-card)] border border-border p-5">
      <h2 id="ticket" className="font-medium">
        Place an order
      </h2>
      {cross.supplyMode !== 'escrow' ? (
        <p className="mt-1 text-sm text-muted">The issuer's supply is set by its schedule; this cross takes buy orders only.</p>
      ) : null}
      <div role="radiogroup" aria-label="Side" className={`mt-4 grid rounded-full border border-border p-1 text-sm ${cross.supplyMode === 'escrow' ? 'grid-cols-2' : 'hidden'}`}>
        {(['buy', 'sell'] as const).map((s) => (
          <button
            key={s}
            type="button"
            role="radio"
            aria-checked={side === s}
            onClick={() => setSide(s)}
            className={`rounded-full py-2 capitalize ${side === s ? 'bg-ink text-bg' : 'text-muted hover:text-ink'}`}
          >
            {s}
          </button>
        ))}
      </div>
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

      {escrow !== null && ready ? (
        <p className="mt-4 rounded-lg bg-surface p-3 text-sm" data-testid="preview">
          {side === 'buy'
            ? `Up to ${formatAtoms(escrow, m.quoteDecimals)} is held in escrow. You pay the clearing price for what you are filled; the rest comes back at settlement.`
            : `${formatAtoms(escrow, m.baseDecimals)} tokens are held in escrow. You receive at least ${formatAtoms((qty! * (price as bigint)) / m.priceScale, m.quoteDecimals)} less the ${feeBps / 100}% seller fee for what is filled.`}
          {sealed ? ' Your price stays sealed until you reveal it after the close.' : ''}
        </p>
      ) : null}

      <div className="mt-4">
        {(() => {
          const nonce = randomNonce();
          const salt = sealed ? randomSalt() : undefined;
          return (
            <ActionButton
              label={sealed ? 'Place sealed order' : 'Place order'}
              path="/v1/tx/place-order"
              disabled={!ready}
              sign={sign}
              before={() => {
                // The reveal needs these; keep them before anything is signed.
                if (sealed && !saveBid({ cross: cross.address, owner, nonce, side, price: String(price), quantity: String(qty), salt: salt!, placedAt: new Date().toISOString() })) {
                  throw new ActionError('This browser could not store your sealed bid, so it could not be revealed later. Nothing was sent.');
                }
              }}
              body={() => ({ cross: cross.address, owner, side, price: String(price), quantity: String(qty), nonce, ...(salt ? { salt } : {}) })}
              onDone={(sigs, extra) => {
                if (typeof extra.order === 'string') rememberOrder(cross.address, owner, extra.order);
                setPlaced(sigs[0] ?? null);
                setPriceText('');
                setQtyText('');
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
