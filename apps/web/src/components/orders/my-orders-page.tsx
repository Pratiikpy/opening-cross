'use client';

import type { UiWalletAccount } from '@wallet-standard/ui';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSigner } from '@/components/cross/use-signer';
import { ClaimCenter } from '@/components/portfolio/claim-center';
import { PortfolioView } from '@/components/portfolio/portfolio-view';
import { StateBadge } from '@/components/state-badge';
import { describeOrder } from '@/lib/orders';
import { buildPortfolio } from '@/lib/portfolio';
import { type Loaded, MAX_CROSSES, loadChain, loadPortfolio } from '@/lib/portfolio-load';
import type { CrossDetail } from '@/lib/types';
import { type Market, formatAtoms, formatPrice, shortAddress } from '@/lib/units';
import { useWallet } from '@/lib/wallet';

type Load = { state: 'loading'; progress?: string } | { state: 'error'; message: string } | { state: 'ready'; data: Loaded };

const marketOf = (c: CrossDetail): Market => ({ priceScale: BigInt(c.grid.priceScale), baseDecimals: c.decimals.base, quoteDecimals: c.decimals.quote });

export function MyOrdersPage() {
  const { account } = useWallet();
  if (!account) {
    return (
      <p role="status" className="mt-10 rounded-[var(--radius-card)] border border-border p-5 text-sm text-muted">
        Connect a wallet with Connect wallet at the top right to see its orders. Orders are read from the chain index by wallet address; nothing is stored about you.
      </p>
    );
  }
  return <Orders account={account} />;
}

function Orders({ account }: { account: UiWalletAccount }) {
  const owner = account.address;
  const sign = useSigner(account);
  const [data, setData] = useState<Load>({ state: 'loading' });
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let live = true;
    // A reload after a claim keeps the old figures on screen until the new ones arrive.
    if (version === 0) setData({ state: 'loading' });
    void loadPortfolio(owner, (done, total) => live && version === 0 && total > 0 && setData({ state: 'loading', progress: `${done} of ${total} crosses` })).then(async (d) => {
      if (!live) return;
      if (!d) return setData({ state: 'error', message: 'The Opening Cross API could not be reached, so your orders cannot be listed. Nothing is lost: they are on chain.' });
      // Show everything the records say now; the chain's live view of open orders (what can be claimed) follows.
      setData((prev) => (prev.state === 'ready' && version > 0 ? prev : { state: 'ready', data: d }));
      const withChain = await loadChain(d);
      if (live) setData({ state: 'ready', data: withChain });
    });
    return () => {
      live = false;
    };
  }, [owner, version]);

  const reload = useCallback(() => setVersion((v) => v + 1), []);
  const ready = data.state === 'ready' ? data.data : null;
  const portfolio = useMemo(() => (ready ? buildPortfolio(ready.orders, ready.crosses, ready.chain) : null), [ready]);

  if (data.state === 'loading') {
    return (
      <p role="status" className="mt-10 text-sm text-muted">
        Loading your orders…{data.progress ? ` ${data.progress}` : ''}
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
  if (!ready || !portfolio) return null;
  if (ready.orders.length === 0) {
    return (
      <div className="mt-10 rounded-[var(--radius-card)] border border-border p-5 text-sm text-muted" data-testid="no-orders">
        <p className="font-medium text-ink">No activity yet</p>
        <p className="mt-2">
          This wallet has no orders the index has seen. There is nothing to hold, nothing in escrow and nothing to claim. New orders appear here once their block is finalized, usually within a minute.
        </p>
        {ready.missing.length > 0 ? <p className="mt-2">{ready.missing.length} cross records could not be loaded just now.</p> : null}
        <Link href="/crosses" className="mt-3 inline-block py-1 text-accent-text underline">
          Browse crosses
        </Link>
      </div>
    );
  }
  return (
    <div className="mt-10 space-y-10">
      <ClaimCenter claimable={portfolio.claimable} owner={owner} sign={sign} onChanged={reload} chainUnread={ready.chainUnread} checking={ready.chainState === 'pending'} />
      <PortfolioView portfolio={portfolio} />
      <OrderList data={ready} />
    </div>
  );
}

function OrderList({ data }: { data: Loaded }) {
  const [now, setNow] = useState<bigint>(() => BigInt(Math.floor(Date.now() / 1000)));
  const [all, setAll] = useState(false);
  useEffect(() => {
    const tick = setInterval(() => setNow(BigInt(Math.floor(Date.now() / 1000))), 1000);
    return () => clearInterval(tick);
  }, []);
  return (
    <section aria-labelledby="all-orders">
      <h2 id="all-orders" className="text-xl font-semibold tracking-tight">
        All orders
      </h2>
      <ul className="mt-3 divide-y divide-border border-y border-border" data-testid="orders-list">
        {(all ? data.orders : data.orders.slice(0, 20)).map((o) => {
          const c = data.details.get(o.cross_address);
          if (!c) return null;
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
      {data.orders.length > 20 ? (
        <button type="button" onClick={() => setAll(!all)} className="mt-4 min-h-11 rounded-full border border-border-strong px-4 py-2 text-sm">
          {all ? 'Show fewer orders' : `Show all ${data.orders.length} orders`}
        </button>
      ) : null}
      {data.missing.length > 0 ? <p className="mt-4 text-xs text-muted">{data.missing.length} crosses could not be loaded just now; their orders are left out of this page.</p> : null}
      {data.truncated ? <p className="mt-4 text-xs text-muted">Showing orders from the {MAX_CROSSES} most recent crosses.</p> : null}
    </section>
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
