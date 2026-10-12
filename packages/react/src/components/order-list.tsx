import { useId, useState } from 'react';
import { type CrossDetail, formatAtoms, formatPrice, marketOf, phaseOf, shortAddress } from '@opening-cross/client';
import { useOpeningCross } from '../context.js';
import { useClock } from '../hooks/use-clock.js';
import { useOrders } from '../hooks/use-orders.js';
import { useSealedBids } from '../hooks/use-sealed-bids.js';
import { CancelButton, ClaimButton, RevealButton } from './actions.js';

export type OrderListProps = {
  cross: CrossDetail;
  /** Change this number to re-read the orders at once (for example after placing one). */
  version?: number;
  /** Called after any action in the list (cancel, reveal, claim) confirms. */
  onChanged?: () => void;
  /** Unix seconds on the cluster's clock (from `useCross`). Default: this machine's clock. */
  now?: bigint;
  className?: string;
};

/** The connected wallet's orders in a cross, each with what is happening to it and the one action it can take now. */
export function OrderList({ cross, version = 0, onChanged, now: nowProp, className }: OrderListProps) {
  const { wallet } = useOpeningCross();
  const owner = wallet?.address ?? null;
  const [local, setLocal] = useState(0);
  const orders = useOrders(cross.address, owner, { version: version + local });
  const sealedBids = useSealedBids(cross.address, owner, version + local);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const clock = useClock();
  const id = useId();
  if (!wallet || !owner) return null;
  const now = nowProp ?? clock;
  const m = marketOf(cross);
  const phase = phaseOf(cross, now);
  const settled = cross.state === 'Cleared' || cross.state === 'NoPrint';
  const sealed = cross.disclosure === 'sealed';
  const changed = () => {
    setLocal((n) => n + 1);
    onChanged?.();
  };
  const needsBackup = sealed && orders.orders?.some((o) => o.open && !o.revealed && !sealedBids.bids.find((b) => b.nonce === o.nonce));

  return (
    <section className={`oc-card${className ? ` ${className}` : ''}`} aria-labelledby={`${id}-title`}>
      <div className="oc-row">
        <h2 id={`${id}-title`} className="oc-title">Your orders</h2>
        {sealed && sealedBids.bids.length ? (
          <button type="button" className="oc-link" onClick={() => sealedBids.download()}>
            Back up sealed bids
          </button>
        ) : null}
      </div>
      {orders.status === 'loading' || orders.status === 'idle' ? <p className="oc-muted">Loading&hellip;</p> : null}
      {orders.status === 'error' && !orders.orders ? <p role="alert" className="oc-error">{orders.error?.message}</p> : null}
      {orders.orders && orders.orders.length === 0 ? <p className="oc-muted">You have no orders in this cross.</p> : null}
      {orders.orders && orders.orders.length > 0 ? (
        <ul className="oc-list" data-testid="my-orders">
          {orders.orders.map((o) => {
            const bid = sealedBids.bids.find((b) => b.nonce === o.nonce);
            const price = o.price ?? bid?.price ?? null;
            const quantity = o.quantity ?? bid?.quantity ?? null;
            const state = o.open ? (o.revealed ? 'in the book' : 'sealed') : o.status === 'claimed' ? 'settled' : o.status === 'cancelled' ? 'cancelled' : 'settling…';
            return (
              <li key={o.address} className="oc-order" data-testid="order">
                <div className="oc-row">
                  <span className="oc-strong">
                    <span className="oc-cap">{o.side}</span>
                    {quantity ? ` ${formatAtoms(BigInt(quantity), m.baseDecimals)}` : ''}
                    {price ? ` at ${formatPrice(BigInt(price), m)}` : ''}
                  </span>
                  <span className="oc-mono oc-muted" data-testid="order-status">{state}</span>
                </div>
                <p className="oc-mono oc-muted">{shortAddress(o.address)}</p>
                {!o.open && o.status === 'claimed' ? (
                  <dl className="oc-facts oc-compact" data-testid="fill-report">
                    <div className="oc-fact-row"><dt>Filled</dt><dd>{formatAtoms(BigInt(o.fill ?? '0'), m.baseDecimals)} tokens</dd></div>
                    {o.side === 'buy' ? (
                      <>
                        <div className="oc-fact-row"><dt>Tokens received</dt><dd>{formatAtoms(BigInt(o.base_out ?? '0'), m.baseDecimals)}</dd></div>
                        <div className="oc-fact-row"><dt>Paid (quote)</dt><dd>{formatAtoms(BigInt(o.escrow) - BigInt(o.quote_out ?? '0'), m.quoteDecimals)}{cross.clearing ? ` at ${formatPrice(BigInt(cross.clearing.price), m)}` : ''}</dd></div>
                        <div className="oc-fact-row"><dt>Refunded (quote)</dt><dd>{formatAtoms(BigInt(o.quote_out ?? '0'), m.quoteDecimals)}</dd></div>
                      </>
                    ) : (
                      <>
                        <div className="oc-fact-row"><dt>Received (quote)</dt><dd>{formatAtoms(BigInt(o.quote_out ?? '0'), m.quoteDecimals)}</dd></div>
                        <div className="oc-fact-row"><dt>Fee (quote)</dt><dd>{formatAtoms(BigInt(o.fee ?? '0'), m.quoteDecimals)}</dd></div>
                        <div className="oc-fact-row"><dt>Tokens returned</dt><dd>{formatAtoms(BigInt(o.base_out ?? '0'), m.baseDecimals)}</dd></div>
                      </>
                    )}
                  </dl>
                ) : null}
                {o.open && o.nonce ? (
                  <div className="oc-actions">
                    {phase === 'open' ? <CancelButton cross={cross} owner={owner} nonce={o.nonce} onDone={changed} /> : null}
                    {phase === 'reveal' && !o.revealed ? <RevealButton cross={cross} owner={owner} nonce={o.nonce} onDone={changed} /> : null}
                    {settled ? <ClaimButton cross={cross} owner={owner} nonce={o.nonce} onDone={changed} /> : null}
                    {!o.revealed && phase === 'awaiting-settlement' && sealed ? <p className="oc-hint">This bid was not revealed in time. It does not trade and is refunded in full at settlement.</p> : null}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      {needsBackup ? (
        <div className="oc-notice">
          <p>This browser does not have the details for one of your sealed bids. Load your reveal backup to reveal it.</p>
          <label className="oc-file">
            <span className="oc-sr-only">Load reveal backup</span>
            <input
              type="file"
              accept="application/json"
              aria-label="Load reveal backup"
              onChange={async (e) => {
                setRestoreError(null);
                const f = e.target.files?.[0];
                if (!f) return;
                try {
                  await sealedBids.restore(await f.text());
                  setLocal((n) => n + 1);
                } catch (err) {
                  setRestoreError(err instanceof Error ? err.message : String(err));
                }
              }}
            />
          </label>
          {restoreError ? <p role="alert" className="oc-error">{restoreError}</p> : null}
        </div>
      ) : null}
    </section>
  );
}
