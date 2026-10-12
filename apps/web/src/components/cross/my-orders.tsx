'use client';

import { useEffect, useState } from 'react';
import { API_URL } from '@/lib/api';
import { type SealedBid, downloadBackup, importBids, loadBids, rememberedOrders } from '@/lib/sealed';
import type { Signer } from '@/lib/tx';
import type { CrossDetail, OwnerOrder } from '@/lib/types';
import { type Market, formatAtoms, formatPrice, shortAddress } from '@/lib/units';
import { ActionButton } from './action-button';
import type { Phase } from './cross-view';

/** One order as the chain sees it now (open) or as the indexer recorded it (closed). */
type OrderView = {
  address: string;
  open: boolean;
  side: 'buy' | 'sell';
  nonce: string | null;
  revealed: boolean;
  escrow: string;
  price: string | null;
  quantity: string | null;
  status?: OwnerOrder['status'];
  fill?: string | null;
  quote_out?: string | null;
  base_out?: string | null;
  fee?: string | null;
};

async function loadOrders(cross: string, owner: string): Promise<OrderView[]> {
  const indexed = await fetch(`${API_URL}/v1/owners/${owner}/orders`, { cache: 'no-store' })
    .then((r) => (r.ok ? (r.json() as Promise<{ orders: OwnerOrder[] }>) : { orders: [] }))
    .catch(() => ({ orders: [] as OwnerOrder[] }));
  const addresses = new Set([...indexed.orders.filter((o) => o.cross_address === cross).map((o) => o.address), ...rememberedOrders(cross, owner)]);
  if (addresses.size === 0) return [];
  const res = await fetch(`${API_URL}/v1/orders?addresses=${[...addresses].join(',')}`, { cache: 'no-store' }).catch(() => null);
  if (!res?.ok) return [];
  const { orders } = (await res.json()) as { orders: (Record<string, unknown> & { address: string; found: boolean })[] };
  const views = orders.map((o) =>
    !o.found
      ? null
      : o.open
        ? ({ address: o.address, open: true, side: o.side, nonce: String(o.nonce), revealed: Boolean(o.revealed), escrow: String(o.escrow), price: null, quantity: null } as OrderView)
        : ({ ...(o as unknown as OwnerOrder), address: o.address, open: false, nonce: null, revealed: o.status !== 'committed' } as OrderView),
  );
  return views.filter((v): v is OrderView => v !== null);
}

export function MyOrders({ cross, phase, market: m, owner, sign, version, onChanged }: { cross: CrossDetail; phase: Phase; market: Market; owner: string; sign: Signer; version: number; onChanged: () => void }) {
  const [orders, setOrders] = useState<OrderView[] | null>(null);
  const [bids, setBids] = useState<SealedBid[]>([]);
  const [importError, setImportError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void loadOrders(cross.address, owner).then((o) => live && setOrders(o));
    setBids(loadBids(cross.address, owner));
    return () => {
      live = false;
    };
  }, [cross.address, owner, version]);

  const settled = cross.state === 'Cleared' || cross.state === 'NoPrint';
  const sealed = cross.disclosure === 'sealed';
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
                    {o.open ? (o.revealed ? 'in the book' : 'sealed') : o.status === 'claimed' ? 'settled' : o.status === 'cancelled' ? 'cancelled' : 'settling…'}
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

                <div className="mt-3 space-y-2">
                  {o.open && phase === 'open' && o.nonce ? (
                    <ActionButton label="Cancel order" variant="secondary" path="/v1/tx/cancel" body={() => ({ cross: cross.address, owner, nonce: o.nonce })} sign={sign} onDone={onChanged} />
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
                    />
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
    </section>
  );
}
