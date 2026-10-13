'use client';

import Link from 'next/link';
import { useState } from 'react';
import { StateBadge } from '@/components/state-badge';
import { type CrossPosition, type MintTotal, type Portfolio } from '@/lib/portfolio';
import { formatAtoms, formatPrice, shortAddress } from '@/lib/units';

const DASH = '–';

function Fact({ label, value, hint, testId }: { label: string; value: string; hint?: string; testId?: string }) {
  return (
    <div>
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="mt-0.5 font-mono text-sm" {...(testId ? { 'data-testid': testId } : {})}>
        {value}
      </dd>
      {hint ? <dd className="mt-0.5 text-xs text-muted">{hint}</dd> : null}
    </div>
  );
}

const mintLabel = (mint: string) => shortAddress(mint);

/** What the connected wallet holds and has done, in total and per cross. Every figure is from an order record or the chain; none is a market price. */
export function PortfolioView({ portfolio }: { portfolio: Portfolio }) {
  const [all, setAll] = useState(false);
  if (portfolio.orders === 0) return null;
  const shown = all ? portfolio.positions : portfolio.positions.slice(0, 8);
  return (
    <section aria-labelledby="portfolio" data-testid="portfolio">
      <h2 id="portfolio" className="text-xl font-semibold tracking-tight">
        Portfolio
      </h2>
      <p className="mt-1 max-w-2xl text-sm text-muted">
        {portfolio.orders} {portfolio.orders === 1 ? 'order' : 'orders'} in {portfolio.crosses} {portfolio.crosses === 1 ? 'cross' : 'crosses'}, {portfolio.filledOrders} filled. Totals are kept per token, because amounts in different tokens are never added
        together. This is a record of what the crosses did, not a profit or loss: there is no market price here, and the only price used as a reference is each cross&apos;s own clearing price.
      </p>

      <div className="mt-5 space-y-4">
        {portfolio.quote.map((q) => (
          <QuoteTotals key={q.mint} t={q} />
        ))}
        {portfolio.base.length > 0 ? <Holdings rows={portfolio.base} /> : null}
      </div>

      <h3 className="mt-8 font-medium">By cross</h3>
      <ul className="mt-3 space-y-4" data-testid="positions">
        {shown.map((p) => (
          <li key={p.cross.address}>
            <Position p={p} />
          </li>
        ))}
      </ul>
      {portfolio.positions.length > 8 ? (
        <button type="button" onClick={() => setAll(!all)} className="mt-4 min-h-11 rounded-full border border-border-strong px-4 py-2 text-sm">
          {all ? 'Show fewer crosses' : `Show all ${portfolio.positions.length} crosses`}
        </button>
      ) : null}
    </section>
  );
}

function QuoteTotals({ t }: { t: MintTotal }) {
  const f = (v: bigint) => formatAtoms(v, t.decimals);
  return (
    <div className="rounded-[var(--radius-card)] border border-border p-5" data-testid="quote-total">
      <h3 className="text-sm font-medium">
        Paid in <span className="font-mono" title={t.mint}>{mintLabel(t.mint)}</span>
      </h3>
      <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3 lg:grid-cols-6">
        <Fact label="Paid for fills" value={f(t.quotePaid)} testId="total-paid" />
        <Fact label="Refunds received" value={f(t.quoteRefunded)} testId="total-refunded" />
        <Fact label="Received from sales" value={f(t.quoteReceived)} hint={t.fees > 0n ? `after ${f(t.fees)} in fees` : undefined} />
        <Fact label="Still in escrow" value={f(t.lockedQuote)} testId="total-locked" />
        <Fact label="Better than your limits" value={f(t.improvement)} hint="over orders whose limit is on record" testId="total-improvement" />
      </dl>
    </div>
  );
}

function Holdings({ rows }: { rows: MintTotal[] }) {
  const shown = rows.filter((r) => r.tokensReceived > 0n || r.tokensSold > 0n || r.lockedBase > 0n);
  if (shown.length === 0) return null;
  return (
    <div className="rounded-[var(--radius-card)] border border-border p-5" data-testid="holdings">
      <h3 className="text-sm font-medium">Tokens received through crosses</h3>
      <p className="mt-1 text-xs text-muted">From fills. What your wallet holds now also depends on anything you did with the tokens afterwards, which this page cannot see.</p>
      <div className="mt-3 overflow-x-auto" tabIndex={0} role="region" aria-label="Tokens received, sold and held in escrow, by token">
        <table className="w-full min-w-[420px] text-sm">
          <caption className="sr-only">Tokens received, sold and held in escrow, by token</caption>
          <thead>
            <tr className="border-b border-border text-left text-xs text-muted">
              <th scope="col" className="py-2 pr-4 font-normal">
                Token
              </th>
              <th scope="col" className="py-2 pr-4 text-right font-normal">
                Received
              </th>
              <th scope="col" className="py-2 pr-4 text-right font-normal">
                Sold
              </th>
              <th scope="col" className="py-2 text-right font-normal">
                In escrow
              </th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.mint} className="border-b border-border last:border-0">
                <th scope="row" className="py-2 pr-4 text-left font-mono font-normal" title={r.mint}>
                  {mintLabel(r.mint)}
                </th>
                <td className="py-2 pr-4 text-right font-mono">{formatAtoms(r.tokensReceived, r.decimals)}</td>
                <td className="py-2 pr-4 text-right font-mono">{formatAtoms(r.tokensSold, r.decimals)}</td>
                <td className="py-2 text-right font-mono">{formatAtoms(r.lockedBase, r.decimals)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Position({ p }: { p: CrossPosition }) {
  const c = p.cross;
  const m = { priceScale: BigInt(c.grid.priceScale), baseDecimals: c.decimals.base, quoteDecimals: c.decimals.quote };
  const q = (v: bigint) => formatAtoms(v, m.quoteDecimals);
  const t = (v: bigint) => formatAtoms(v, m.baseDecimals);
  const waiting = p.results.filter((r) => r.kind === 'locked' || r.kind === 'claimable' || r.kind === 'settling').length;
  const cancelled = p.results.filter((r) => r.kind === 'cancelled').length;
  const unfilled = p.results.filter((r) => r.kind === 'settled' && r.filled === 0n).length;
  const phase = c.state === 'Live' ? ('awaiting-settlement' as const) : undefined;
  return (
    <div className="rounded-[var(--radius-card)] border border-border p-5" data-testid="position">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link href={`/crosses/${c.address}`} className="font-medium text-accent-text underline">
            Cross {shortAddress(c.address)}
          </Link>
          <p className="mt-1 text-xs text-muted">
            {p.results.length} {p.results.length === 1 ? 'order' : 'orders'}: {p.filledOrders} filled
            {unfilled ? `, ${unfilled} not filled` : ''}
            {cancelled ? `, ${cancelled} cancelled` : ''}
            {waiting ? `, ${waiting} waiting` : ''}
          </p>
        </div>
        <StateBadge state={c.state} {...(phase ? { phase } : {})} />
      </div>
      <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3 lg:grid-cols-4">
        {p.tokensReceived > 0n || p.quotePaid > 0n ? (
          <>
            <Fact label="Tokens received" value={t(p.tokensReceived)} />
            <Fact label="Average price paid" value={p.averagePaid !== null ? `${formatAtoms(p.averagePaid, m.quoteDecimals)} per token` : DASH} />
            <Fact label="Clearing price" value={c.clearing ? `${formatPrice(BigInt(c.clearing.price), m)} per token` : DASH} hint={c.clearing ? 'what every filled buyer paid' : 'this cross did not print'} />
            <Fact label="Paid" value={`${q(p.quotePaid)} quote`} />
            <Fact label="Refunds received" value={`${q(p.quoteRefunded)} quote`} />
          </>
        ) : null}
        {p.tokensSold > 0n || p.quoteReceived > 0n ? (
          <>
            <Fact label="Tokens sold" value={t(p.tokensSold)} />
            <Fact label="Received" value={`${q(p.quoteReceived)} quote`} hint={p.fees > 0n ? `after ${q(p.fees)} in fees` : undefined} />
          </>
        ) : null}
        <Fact
          label="Still in escrow"
          value={[p.lockedQuote > 0n ? `${q(p.lockedQuote)} quote` : null, p.lockedBase > 0n ? `${t(p.lockedBase)} tokens` : null].filter(Boolean).join(' and ') || 'Nothing'}
          {...(p.claimable > 0 ? { hint: `${p.claimable} ready to claim` } : {})}
        />
        {p.filledOrders > 0 ? (
          <Fact
            label="Better than your limits"
            value={p.improvedOrders > 0 ? `${q(p.improvement)} quote` : DASH}
            hint={p.improvedOrders > 0 ? `against the limits of ${p.improvedOrders} of ${p.filledOrders} filled orders` : 'no limit on record for these orders'}
          />
        ) : null}
      </dl>
    </div>
  );
}
