'use client';

import { useEffect, useState } from 'react';
import { type OrderView, loadOwnOrders } from '@/lib/holder-orders';
import type { Programs } from '@/lib/holder-programs';
import { type RulesRead, cancelDeadlineOf, clock } from '@/lib/holder-rules';
import { type SealedBid, downloadBackup, importBids, loadBids } from '@/lib/sealed';
import type { Signer } from '@/lib/tx';
import type { CrossDetail } from '@/lib/types';
import { type Market, formatAtoms, formatPrice, shortAddress } from '@/lib/units';
import { ActionButton } from './action-button';
import { ChallengePanel } from './challenge-panel';
import type { Phase } from './cross-view';
import { LockupsPanel } from './lockups-panel';
import { OutcomeNote } from './outcome-note';
import { type OwnMarks, deriveMarks, loadTerms } from './own-orders';

export function MyOrders({ cross, phase, market: m, owner, sign, version, onChanged, onMarks, rules, now, programs }: { cross: CrossDetail; phase: Phase; market: Market; owner: string; sign: Signer; version: number; onChanged: () => void; onMarks?: (marks: OwnMarks) => void; rules?: RulesRead | null | undefined; now: bigint; programs: Programs | null | 'unavailable' }) {
  const [orders, setOrders] = useState<OrderView[] | null>(null);
  const [bids, setBids] = useState<SealedBid[]>([]);
  const [importError, setImportError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void loadOwnOrders(cross.address, owner, cross.disclosure === 'sealed').then((o) => live && setOrders(o));
    setBids(loadBids(cross.address, owner));
    return () => {
      live = false;
    };
  }, [cross.address, owner, version]);

  const settled = cross.state === 'Cleared' || cross.state === 'NoPrint';
  const deadline = cancelDeadlineOf(rules?.calls, BigInt(cross.window.closeTs));
  const extended = (rules?.state?.draw.epoch ?? 0) > 0;
  const sealed = cross.disclosure === 'sealed';

  // When the wallet disconnects, the chart forgets these orders.
  useEffect(() => () => onMarks?.({ marks: [], unlocated: 0, hidden: 0 }), [onMarks]);

  // Tell the book chart where these orders sit. A sealed order is only reported once revealed.
  useEffect(() => {
    if (!orders || !onMarks) return;
    const inputs = orders.map((o) => {
      const bid = bids.find((b) => b.nonce === o.nonce);
      const known = !sealed || o.revealed;
      return { address: o.address, side: o.side, sealed, revealed: o.revealed, price: known ? (o.price ?? bid?.price ?? null) : null, quantity: known ? (o.quantity ?? bid?.quantity ?? null) : null, status: o.status };
    });
    onMarks(deriveMarks(inputs, loadTerms(cross.address, owner), cross.state !== 'Live'));
  }, [orders, bids, sealed, cross.address, cross.state, owner, onMarks]);
  const needsBackup = sealed && orders?.some((o) => o.open && !o.revealed && !bids.find((b) => b.nonce === o.nonce));

  return (
    <section aria-labelledby="mine" className="rounded-[var(--radius-card)] border border-border p-5">
      <div className="flex items-center justify-between">
        <h2 id="mine" className="font-medium">
          Your orders
        </h2>
        {sealed && bids.length ? (
          <button type="button" className="text-xs text-accent-text underline" onClick={() => downloadBackup(bids)}>
            Back up sealed bids
          </button>
        ) : null}
      </div>
      {orders !== null && orders.length > 0 && cross.state !== 'Live' ? (
        <a className="mt-2 flex min-h-6 items-center text-xs text-accent-text underline" href={`/receipt/${cross.address}/${owner}`}>
          Share a receipt of your orders here
        </a>
      ) : null}
      {orders === null ? (
        <p className="mt-3 text-sm text-muted">Loading…</p>
      ) : orders.length === 0 ? (
        <p className="mt-3 text-sm text-muted">You have no orders in this cross.</p>
      ) : (
        <ul className="mt-3 space-y-3" data-testid="my-orders">
          {orders.map((o) => {
            const bid = bids.find((b) => b.nonce === o.nonce);
            const price = o.price ?? bid?.price ?? null;
            const quantity = o.quantity ?? bid?.quantity ?? null;
            return (
              <li key={o.address} className="rounded-lg border border-border p-3 text-sm" data-testid="order">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium">
                    <span className="capitalize">{o.side}</span>
                    {quantity ? ` ${formatAtoms(BigInt(quantity), m.baseDecimals)}` : ''}
                    {price ? ` at ${formatPrice(BigInt(price), m)}` : ''}
                  </span>
                  <span className="font-mono text-xs text-muted" data-testid="order-status">
                    {o.open ? (o.revealed ? 'in the book' : 'sealed') : o.status === 'claimed' ? 'settled' : o.status === 'cancelled' ? 'cancelled' : 'paid out, amounts follow'}
                  </span>
                </div>
                <p className="mt-1 font-mono text-xs text-muted">{shortAddress(o.address)}</p>

                {!o.open && o.status === 'claimed' ? (
                  <dl className="mt-2 grid grid-cols-2 gap-1 text-xs" data-testid="fill-report">
                    <dt className="text-muted">Filled</dt>
                    <dd>{formatAtoms(BigInt(o.fill ?? '0'), m.baseDecimals)} tokens</dd>
                    {o.side === 'buy' ? (
                      <>
                        <dt className="text-muted">Tokens received</dt>
                        <dd>{formatAtoms(BigInt(o.base_out ?? '0'), m.baseDecimals)}</dd>
                        <dt className="text-muted">Paid (quote)</dt>
                        <dd>{formatAtoms(BigInt(o.escrow) - BigInt(o.quote_out ?? '0'), m.quoteDecimals)}{cross.clearing ? ` at ${formatPrice(BigInt(cross.clearing.price), m)}` : ''}</dd>
                        <dt className="text-muted">Refunded (quote)</dt>
                        <dd>{formatAtoms(BigInt(o.quote_out ?? '0'), m.quoteDecimals)}</dd>
                      </>
                    ) : (
                      <>
                        <dt className="text-muted">Received (quote)</dt>
                        <dd>{formatAtoms(BigInt(o.quote_out ?? '0'), m.quoteDecimals)}</dd>
                        <dt className="text-muted">Fee (quote)</dt>
                        <dd>{formatAtoms(BigInt(o.fee ?? '0'), m.quoteDecimals)}</dd>
                        <dt className="text-muted">Tokens returned</dt>
                        <dd>{formatAtoms(BigInt(o.base_out ?? '0'), m.baseDecimals)}</dd>
                      </>
                    )}
                  </dl>
                ) : null}
                {!o.open && o.status === 'claimed' ? <OutcomeNote o={o} clearing={cross.clearing} market={m} maxMatched={rules?.rules?.guards.maxMatched ?? null} /> : null}
                {!o.open && o.status !== 'claimed' && o.status !== 'cancelled' && settled ? (
                  <p className="mt-2 text-xs text-muted" data-testid="order-paid-out">
                    This order has been paid out on chain: the cross’s settlement refunded or filled it without waiting for you (anyone may send a refund for an order that has no fill). The amounts appear here once the index has recorded them.
                  </p>
                ) : null}

                <div className="mt-3 space-y-2">
                  {o.open && phase === 'open' && o.nonce && now < deadline && !extended ? (
                    <ActionButton label="Cancel order" variant="secondary" path="/v1/tx/cancel" body={() => ({ cross: cross.address, owner, nonce: o.nonce })} sign={sign} onDone={onChanged} testId="cancel-order" />
                  ) : null}
                  {o.open && phase === 'open' && (now >= deadline || extended) ? (
                    <p className="text-xs text-muted" data-testid="cancel-closed">
                      {extended ? 'This order was placed in the extension of the call, which cannot be cancelled.' : `Cancellation closed at ${clock(deadline)}. This order stays until the cross is settled, and is refunded in full if the cross does not print${rules?.rules?.ending.randomEnd ? ' or its ending window is not counted' : ''}.`}
                    </p>
                  ) : null}
                  {o.open && phase === 'open' && now < deadline && !extended && rules?.rules && (rules.rules.ending.endingSecs > 0 || rules.rules.ending.cancelCutoffSecs > 0) ? (
                    <p className="text-xs text-muted">You can cancel this order until {clock(deadline)}.</p>
                  ) : null}
                  {o.open && !o.revealed && phase === 'reveal' && o.nonce && bid ? (
                    <ActionButton label="Reveal bid" path="/v1/tx/reveal" body={() => ({ cross: cross.address, owner, nonce: o.nonce, price: bid.price, quantity: bid.quantity, salt: bid.salt })} sign={sign} onDone={onChanged} />
                  ) : null}
                  {o.open && settled && o.nonce ? (
                    <ActionButton
                      label={cross.state === 'NoPrint' ? 'Claim refund' : 'Claim fill and refund'}
                      path="/v1/tx/claim"
                      body={() => ({ cross: cross.address, owner, nonce: o.nonce, payer: owner })}
                      sign={sign}
                      onDone={onChanged}
                      testId="claim-order"
                    />
                  ) : null}
                  {o.open && settled && o.nonce && (cross.state === 'NoPrint' || !cross.clearing || !o.fill) ? (
                    <p className="text-xs text-muted">If nothing of this order traded, a keeper may refund it before you claim. It then shows here as paid out.</p>
                  ) : null}
                  {o.open && !o.revealed && phase === 'awaiting-settlement' && sealed ? (
                    <p className="text-xs text-muted">This bid was not revealed in time. It does not trade and is refunded in full at settlement.</p>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {needsBackup ? (
        <div className="mt-4 rounded-lg bg-surface p-3 text-sm">
          <p>This browser does not have the details for one of your sealed bids. Load your reveal backup to reveal it.</p>
          <input
            type="file"
            accept="application/json"
            aria-label="Load reveal backup"
            className="mt-2 text-xs"
            onChange={async (e) => {
              setImportError(null);
              const f = e.target.files?.[0];
              if (!f) return;
              try {
                importBids(await f.text(), cross.address, owner);
                setBids(loadBids(cross.address, owner));
              } catch (err) {
                setImportError(err instanceof Error ? err.message : String(err));
              }
            }}
          />
          {importError ? (
            <p role="alert" className="mt-1 text-xs text-accent-text">
              {importError}
            </p>
          ) : null}
        </div>
      ) : null}
      {rules?.rules && rules.calls?.lockVault && cross.state !== 'Live' ? <LockupsPanel cross={cross} owner={owner} market={m} sign={sign} version={version} onChanged={onChanged} /> : null}
      {rules?.rules && rules.state && BigInt(rules.rules.neutrality.bondQuote) > 0n && cross.state !== 'Live' ? <ChallengePanel cross={cross} rules={rules} market={m} owner={owner} sign={sign} version={version} onChanged={onChanged} now={now} programs={programs} /> : null}
    </section>
  );
}

