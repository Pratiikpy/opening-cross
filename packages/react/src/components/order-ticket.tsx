import { type ReactNode, useId, useMemo, useState } from 'react';
import {
  type CrossDetail,
  type Side,
  bytesOfHex,
  formatPrice,
  hexOfBytes,
  marketOf,
  phaseOf,
  previewOrder,
  randomNonce,
  randomSalt,
  validateOrderInput,
} from '@opening-cross/client';
import { useOpeningCross } from '../context.js';
import { useClock } from '../hooks/use-clock.js';
import { useSealedBids } from '../hooks/use-sealed-bids.js';
import { ActionButton } from './action-button.js';

export type OrderTicketProps = {
  cross: CrossDetail;
  /** Called after the order is confirmed on chain. `nonce` identifies the order for cancel, reveal and claim. */
  onPlaced?: (placed: { order: string | null; nonce: string; signatures: string[] }) => void;
  /** Shown instead of the form when no wallet is connected: put your connect button here. */
  connect?: ReactNode;
  /** Unix seconds on the cluster's clock, if you already have it (for example from `useCross`). Default: this machine's clock. */
  now?: bigint;
  className?: string;
};

/**
 * Place a buy or sell order. The ticket checks the price against the cross's grid as you type, and before anything is signed it shows
 * what leaves your wallet, the most you can pay, the fees, what happens if the cross does not print and how you get your money back.
 * Sealed crosses keep your salt in the vault before the order is built; the ticket then offers the backup file.
 */
export function OrderTicket({ cross, onPlaced, connect, now: nowProp, className }: OrderTicketProps) {
  const { builder, wallet, store } = useOpeningCross();
  const clock = useClock();
  const now = nowProp ?? clock;
  const id = useId();
  const [side, setSide] = useState<Side>('buy');
  const [priceText, setPriceText] = useState('');
  const [qtyText, setQtyText] = useState('');
  const [placed, setPlaced] = useState<{ nonce: string; signature: string | undefined } | null>(null);
  const bids = useSealedBids(cross.address, wallet?.address ?? null, placed ? 1 : 0);

  const market = useMemo(() => marketOf(cross), [cross]);
  const sealed = cross.disclosure === 'sealed';
  const escrowSupply = cross.supplyMode === 'escrow';
  const effectiveSide: Side = escrowSupply ? side : 'buy';
  const v = validateOrderInput(cross, market, { side: effectiveSide, priceText, quantityText: qtyText });
  const preview = v.ok ? previewOrder(cross, market, effectiveSide, v.price, v.quantity) : null;
  const phase = phaseOf(cross, now);
  const closedReason =
    phase === 'open' ? null : phase === 'upcoming' ? 'This cross has not opened yet.' : phase === 'settled' ? `This cross has already ${cross.state === 'NoPrint' ? 'ended without printing' : 'cleared'}; it takes no more orders.` : 'This cross has closed; it takes no more orders.';

  if (!wallet) {
    return (
      <section className={`oc-card${className ? ` ${className}` : ''}`} aria-labelledby={`${id}-title`}>
        <h2 id={`${id}-title`} className="oc-title">Place an order</h2>
        <p className="oc-muted">{connect ?? 'Connect a wallet to place an order in this cross.'}</p>
      </section>
    );
  }

  const owner = wallet.address;
  const priceError = !v.ok ? v.priceError : null;
  const qtyError = !v.ok ? v.quantityError : null;

  return (
    <section className={`oc-card${className ? ` ${className}` : ''}`} aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`} className="oc-title">Place an order</h2>
      {!escrowSupply ? <p className="oc-muted">The issuer&apos;s supply is set by its schedule; this cross takes buy orders only.</p> : null}
      {escrowSupply ? (
        <fieldset className="oc-segmented">
          <legend className="oc-sr-only">Side</legend>
          {(['buy', 'sell'] as const).map((s) => (
            <label key={s} className="oc-segment">
              <input type="radio" name={`${id}-side`} value={s} checked={side === s} onChange={() => setSide(s)} />
              <span>{s === 'buy' ? 'Buy' : 'Sell'}</span>
            </label>
          ))}
        </fieldset>
      ) : null}

      <div className="oc-field">
        <label htmlFor={`${id}-price`}>{effectiveSide === 'buy' ? 'Most you would pay per token' : 'Least you would take per token'}</label>
        <input
          id={`${id}-price`}
          className="oc-input"
          inputMode="decimal"
          autoComplete="off"
          value={priceText}
          onChange={(e) => setPriceText(e.target.value)}
          aria-invalid={priceError !== null}
          aria-describedby={`${id}-price-help`}
          placeholder={formatPrice(BigInt(cross.grid.minPrice), market)}
        />
        <p id={`${id}-price-help`} className={priceError ? 'oc-error' : 'oc-hint'}>
          {priceError ?? 'Everyone who is filled pays the same clearing price, which is never worse than your limit.'}
        </p>
      </div>
      <div className="oc-field">
        <label htmlFor={`${id}-qty`}>Tokens</label>
        <input id={`${id}-qty`} className="oc-input" inputMode="decimal" autoComplete="off" value={qtyText} onChange={(e) => setQtyText(e.target.value)} aria-invalid={qtyError !== null} aria-describedby={qtyError ? `${id}-qty-help` : undefined} placeholder="0" />
        {qtyError ? (
          <p id={`${id}-qty-help`} className="oc-error">
            {qtyError}
          </p>
        ) : null}
      </div>

      {preview ? (
        <div className="oc-preview" data-testid="preview">
          <h3 className="oc-subtitle">Before you sign</h3>
          <dl className="oc-facts">
            {preview.lines.map((l) => (
              <div key={l.label} className="oc-fact-row">
                <dt>{l.label}</dt>
                <dd>{l.text}</dd>
              </div>
            ))}
          </dl>
          {preview.requiresPass ? <p className="oc-hint">This cross needs an eligibility pass for the gate token; without one the program refuses the order and nothing is spent.</p> : null}
        </div>
      ) : null}

      {closedReason ? <p className="oc-hint" role="status">{closedReason}</p> : null}

      <ActionButton
        label={sealed ? 'Place sealed order' : 'Place order'}
        disabled={!v.ok || closedReason !== null}
        testId="place-order"
        action={async () => {
          if (!v.ok) throw new Error('The order is not valid yet.');
          const nonce = randomNonce();
          const salt = sealed ? bytesOfHex(randomSalt()) : undefined;
          // The reveal needs the salt: it is stored before anything is built or signed, so a refused order never leaves a bid that cannot be revealed.
          if (sealed) await store.save({ cross: cross.address, owner, nonce, side: effectiveSide, price: v.price.toString(), quantity: v.quantity.toString(), salt: hexOfBytes(salt!), placedAt: new Date().toISOString() });
          const built = await builder.placeOrder({ cross: cross.address, owner, nonce: BigInt(nonce), side: effectiveSide, price: v.price, quantity: v.quantity, ...(salt ? { salt } : {}) });
          return { ...built, extra: { ...built.extra, nonce } };
        }}
        onDone={async ({ signatures, extra }) => {
          const order = typeof extra.order === 'string' ? extra.order : null;
          const nonce = String(extra.nonce);
          if (order) await store.remember(cross.address, owner, order);
          setPlaced({ nonce, signature: signatures[0] });
          setPriceText('');
          setQtyText('');
          onPlaced?.({ order, nonce, signatures });
        }}
      />

      {placed ? (
        <div role="status" className="oc-notice" data-testid="placed">
          <p className="oc-strong">Order placed.</p>
          <p className="oc-mono oc-break">Nonce {placed.nonce}</p>
          {placed.signature ? <p className="oc-mono oc-break oc-muted">{placed.signature}</p> : null}
          {sealed ? (
            <p>
              Keep your reveal backup: without it this bid cannot be revealed.{' '}
              <button type="button" className="oc-link" onClick={() => bids.download()}>
                Download your reveal backup
              </button>
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
