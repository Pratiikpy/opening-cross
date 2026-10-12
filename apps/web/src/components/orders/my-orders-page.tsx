'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { StateBadge } from '@/components/state-badge';
import { API_URL } from '@/lib/api';
import { describeOrder } from '@/lib/orders';
import type { CrossDetail, OwnerOrder } from '@/lib/types';
import { type Market, formatAtoms, formatPrice, shortAddress } from '@/lib/units';
import { useWallet } from '@/lib/wallet';

type Row = { order: OwnerOrder; cross: CrossDetail | null };
type Load = { state: 'loading' } | { state: 'error'; message: string } | { state: 'ready'; rows: Row[]; truncated: boolean };

const MAX_CROSSES = 60;

async function getJson<T>(path: string): Promise<T | null> {
  try {
    const r = await fetch(`${API_URL}${path}`, { cache: 'no-store' });
    return r.ok ? ((await r.json()) as T) : null;
  } catch {
    return null;
  }
}

async function load(owner: string): Promise<Load> {
  const res = await getJson<{ orders: OwnerOrder[] }>(`/v1/owners/${owner}/orders`);
  if (!res) return { state: 'error', message: 'The Opening Cross API could not be reached, so your orders cannot be listed. Nothing is lost: they are on chain.' };
  const addresses = [...new Set(res.orders.map((o) => o.cross_address))];
  const wanted = addresses.slice(0, MAX_CROSSES);
  const crosses = new Map<string, CrossDetail | null>();
  await Promise.all(wanted.map(async (a) => crosses.set(a, await getJson<CrossDetail>(`/v1/crosses/${a}`))));
  return {
    state: 'ready',
    rows: res.orders.filter((o) => crosses.has(o.cross_address)).map((order) => ({ order, cross: crosses.get(order.cross_address) ?? null })),
    truncated: addresses.length > MAX_CROSSES,
  };
}

const marketOf = (c: CrossDetail): Market => ({ priceScale: BigInt(c.grid.priceScale), baseDecimals: c.decimals.base, quoteDecimals: c.decimals.quote });

export function MyOrdersPage() {
  const { account } = useWallet();
  const [data, setData] = useState<Load>({ state: 'loading' });
  const [now, setNow] = useState<bigint>(() => BigInt(Math.floor(Date.now() / 1000)));
  const owner = account?.address;

  useEffect(() => {
    if (!owner) return;
    let live = true;
    setData({ state: 'loading' });
    void load(owner).then((d) => live && setData(d));
    const tick = setInterval(() => setNow(BigInt(Math.floor(Date.now() / 1000))), 1000);
    return () => {
      live = false;
      clearInterval(tick);
    };
  }, [owner]);

  if (!owner) {
    return (
      <p role="status" className="mt-10 rounded-[var(--radius-card)] border border-border p-5 text-sm text-muted">
        Connect a wallet with Connect wallet at the top right to see its orders. Orders are read from the chain index by wallet address; nothing is stored about you.
      </p>
    );
  }
  if (data.state === 'loading') {
    return (
      <p role="status" className="mt-10 text-sm text-muted">
        Loading your orders…
      </p>
    );
  }
  if (data.state === 'error') {
    return (
      <p role="alert" className="mt-10 rounded-[var(--radius-card)] border border-border p-5 text-sm text-muted">
        {data.message}
      </p>
    );
  }
  if (data.rows.length === 0) {
    return (
      <div className="mt-10 rounded-[var(--radius-card)] border border-border p-5 text-sm text-muted" data-testid="no-orders">
        <p>This wallet has no orders the index has seen yet. New orders appear here once their block is finalized, usually within a minute.</p>
        <Link href="/crosses" className="mt-3 inline-block text-accent-text underline">
          Browse crosses
        </Link>
      </div>
    );
  }
  return (
    <>
      <ul className="mt-10 divide-y divide-border border-y border-border" data-testid="orders-list">
        {data.rows.map(({ order: o, cross: c }) => {
          if (!c) {
            return (
              <li key={o.address} className="py-4 text-sm text-muted">
                An order in cross <span className="font-mono">{shortAddress(o.cross_address)}</span> could not be loaded right now.
              </li>
            );
          }
          const m = marketOf(c);
          const d = describeOrder(o, c, now);
          const phase = c.state === 'Live' ? (now < BigInt(c.window.closeTs) ? ('open' as const) : ('awaiting-settlement' as const)) : undefined;
          return (
            <li key={o.address} className="py-5" data-testid="order-row">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="font-medium">
                    <span className="capitalize">{o.side}</span>
                    {o.quantity ? ` ${formatAtoms(BigInt(o.quantity), m.baseDecimals)} tokens` : ' order'}
                    {o.price ? ` at ${o.side === 'buy' ? 'up to' : 'at least'} ${formatPrice(BigInt(o.price), m)} per token` : o.sealed ? ', price sealed' : ''}
                  </p>
                  <p className="mt-1 text-sm text-muted">
                    <Link href={`/crosses/${c.address}`} className="text-accent-text underline">
                      Cross {shortAddress(c.address)}
                    </Link>{' '}
                    · {d.status}
                  </p>
                </div>
                <StateBadge state={c.state} {...(phase ? { phase } : {})} />
              </div>
              {o.status === 'claimed' ? (
                <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-4">
                  <Fact label="Filled" value={`${formatAtoms(BigInt(o.fill ?? '0'), m.baseDecimals)} tokens`} />
                  {o.side === 'buy' ? (
                    <>
                      <Fact label="Tokens received" value={formatAtoms(BigInt(o.base_out ?? '0'), m.baseDecimals)} />
                      <Fact label="Paid (quote)" value={formatAtoms(BigInt(o.escrow) - BigInt(o.quote_out ?? '0'), m.quoteDecimals)} />
                      <Fact label="Refunded (quote)" value={formatAtoms(BigInt(o.quote_out ?? '0'), m.quoteDecimals)} />
                    </>
                  ) : (
                    <>
                      <Fact label="Received (quote)" value={formatAtoms(BigInt(o.quote_out ?? '0'), m.quoteDecimals)} />
                      <Fact label="Fee (quote)" value={formatAtoms(BigInt(o.fee ?? '0'), m.quoteDecimals)} />
                      <Fact label="Tokens returned" value={formatAtoms(BigInt(o.base_out ?? '0'), m.baseDecimals)} />
                    </>
                  )}
                </dl>
              ) : d.next ? (
                <p className="mt-3 text-sm">{d.next}</p>
              ) : null}
            </li>
          );
        })}
      </ul>
      {data.truncated ? <p className="mt-4 text-xs text-muted">Showing orders from the {MAX_CROSSES} most recent crosses.</p> : null}
    </>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="mt-0.5 font-mono">{value}</dd>
    </div>
  );
}
