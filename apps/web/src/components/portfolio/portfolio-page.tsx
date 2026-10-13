'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { FollowButton } from '@/components/alerts/follow-button';
import { useFeed, useWatchList } from '@/components/alerts/use-alerts';
import { API_URL } from '@/lib/api';
import { allWatched } from '@/lib/holder-alerts';
import { type HoldingRow, type HoldingsData, loadHoldings } from '@/lib/holder-portfolio-load';
import { signed } from '@/lib/holder-value';
import { formatAtoms, shortAddress } from '@/lib/units';
import { useWallet } from '@/lib/wallet';
import { IdentityStatus } from './identity-status';
import { PasskeyCard } from './passkey-wallet';

const CARD = 'rounded-[var(--radius-card)] border border-border p-5';
const DASH = '–';

type Load = { state: 'loading'; text: string } | { state: 'error' } | { state: 'ready'; data: HoldingsData };

export function PortfolioPage() {
  const { account } = useWallet();
  if (!account) {
    return (
      <div className="mt-10 space-y-6">
        <p role="status" className="rounded-[var(--radius-card)] border border-border p-5 text-sm text-muted">
          Connect a wallet with Connect wallet at the top right to see what it holds from crosses, what the tokens last cleared at, and the rights that come with them. Nothing is stored about you.{' '}
          <Link href="/crosses" className="text-accent-text underline">Browse crosses</Link>
        </p>
        <PasskeyCard />
      </div>
    );
  }
  return <Holdings owner={account.address} />;
}

function Holdings({ owner }: { owner: string }) {
  const [load, setLoad] = useState<Load>({ state: 'loading', text: 'Reading your orders…' });
  useEffect(() => {
    let live = true;
    setLoad({ state: 'loading', text: 'Reading your orders…' });
    void loadHoldings(owner, (text) => live && setLoad({ state: 'loading', text })).then((d) => live && setLoad(d ? { state: 'ready', data: d } : { state: 'error' }));
    return () => {
      live = false;
    };
  }, [owner]);

  const { watch } = useWatchList();
  const { feed } = useFeed(owner, allWatched(watch));
  const needs = (feed?.items ?? []).filter((i) => i.kind === 'claimable' || i.kind === 'closing');

  if (load.state === 'loading') {
    return (
      <p role="status" className="mt-10 text-sm text-muted">
        {load.text}
      </p>
    );
  }
  if (load.state === 'error') {
    return (
      <p role="alert" className="mt-10 rounded-[var(--radius-card)] border border-border p-5 text-sm text-muted">
        The Opening Cross API could not be reached, so your portfolio cannot be listed. Nothing is lost: your tokens and orders are on chain.
      </p>
    );
  }
  const { rows, unread, orders, crosses, asOf } = load.data;
  return (
    <div className="mt-10 space-y-12">
      <section aria-labelledby="needs-h">
        <h2 id="needs-h" className="text-xl font-semibold tracking-tight">
          {needs.length === 0 ? 'Nothing needs you' : needs.length === 1 ? '1 thing needs you' : `${needs.length} things need you`}
        </h2>
        {needs.length === 0 ? (
          <p className="mt-2 text-sm text-muted" data-testid="needs-empty">
            No order of yours can be claimed and none is about to close. <Link href="/alerts" className="underline underline-offset-4 hover:text-ink">Set up alerts</Link> to be told when that changes.
          </p>
        ) : (
          <ul className="mt-3 space-y-3" data-testid="needs">
            {needs.map((i) => (
              <li key={i.key} className={`${CARD} flex flex-wrap items-center justify-between gap-3`}>
                <div className="min-w-0">
                  <p className="font-medium">{i.title}</p>
                  <p className="mt-1 text-sm text-muted">{i.body}</p>
                </div>
                <Link href={i.href} className="inline-flex min-h-11 items-center rounded-full bg-accent-fill px-5 text-sm font-medium text-on-accent hover:opacity-90">
                  {i.kind === 'claimable' ? 'Open the claim center' : 'Open the cross'}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="hold-h">
        <h2 id="hold-h" className="text-xl font-semibold tracking-tight">
          Holdings
        </h2>
        <p className="mt-1 max-w-2xl text-sm text-muted">
          Tokens you bought or sold through crosses ({orders} {orders === 1 ? 'order' : 'orders'} in {crosses} {crosses === 1 ? 'cross' : 'crosses'}), as your wallet holds them now. A token&apos;s only price here is the price its last cross cleared at: there is no market price, so a
          result is a comparison with what you paid, not a quote you can sell at. Amounts in different quote tokens are never added together.
        </p>
        {rows.length === 0 ? (
          <div className={`${CARD} mt-4 text-sm text-muted`} data-testid="no-holdings">
            <p className="font-medium text-ink">Nothing yet</p>
            <p className="mt-1">You have not bought or sold a token through a cross with this wallet. Find the next one in the calendar.</p>
            <div className="mt-3 flex flex-wrap gap-3">
              <Link href="/calendar" className="inline-flex min-h-11 items-center rounded-full border border-border-strong px-4 hover:bg-surface">Open the calendar</Link>
              <Link href="/crosses" className="inline-flex min-h-11 items-center rounded-full border border-border-strong px-4 hover:bg-surface">Browse crosses</Link>
            </div>
          </div>
        ) : (
          <ul className="mt-4 space-y-4" data-testid="holdings">
            {rows.map((r) => (
              <li key={r.mint}>
                <HoldingCard row={r} now={asOf} />
              </li>
            ))}
          </ul>
        )}
        {unread.length > 0 ? (
          <ul className="mt-4 space-y-1 text-xs text-muted" data-testid="unread">
            {unread.map((u) => (
              <li key={u}>{u}</li>
            ))}
          </ul>
        ) : null}
      </section>
      <div className="grid gap-5 lg:grid-cols-2">
        <IdentityStatus />
        <PasskeyCard />
      </div>
      <p className="text-sm text-muted">
        Orders, fills and refunds: <Link href="/orders" className="text-accent-text underline">My orders</Link>. What each token&apos;s holders are owed: <Link href="/rights" className="text-accent-text underline">Rights</Link>. Per-order records for tax:{' '}
        <Link href="/export" className="text-accent-text underline">Export</Link>.
      </p>
    </div>
  );
}

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

function HoldingCard({ row: r, now }: { row: HoldingRow; now: number }) {
  const qd = r.mark?.quoteDecimals ?? 6;
  const amount = (v: bigint) => formatAtoms(v, qd);
  const result = r.result;
  return (
    <article className={CARD} aria-label={`Holding ${shortAddress(r.mint)}`} data-testid="holding">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="font-mono text-base font-medium" title={r.mint}>
            Token {shortAddress(r.mint)}
          </h3>
          <p className="mt-1 text-xs text-muted">
            Received {formatAtoms(r.received, r.decimals)} · sold {formatAtoms(r.sold, r.decimals)} through crosses
          </p>
        </div>
        {r.markCross ? (
          <Link href={`/crosses/${r.markCross}`} className="inline-flex min-h-11 items-center text-sm text-accent-text underline">
            Last cross {shortAddress(r.markCross)}
          </Link>
        ) : null}
      </div>
      <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3 lg:grid-cols-5">
        <Fact label="You hold" value={r.held === null ? 'Unavailable' : formatAtoms(r.held, r.decimals)} {...(r.held === null ? { hint: 'The network could not be read' } : {})} testId="held" />
        <Fact label="Last cross price" value={r.mark ? `${amount(r.mark.perToken)} per token` : DASH} hint={r.mark ? `cleared ${new Date(r.mark.closeTs * 1000).toISOString().slice(0, 10)}` : 'no cross of this token has printed'} testId="mark" />
        <Fact label="Worth at that price" value={r.value === null ? DASH : `${amount(r.value)} quote`} testId="value" />
        <Fact label="You paid on average" value={r.averagePaid === null ? DASH : `${amount(r.averagePaid)} per token`} hint={r.averagePaid === null ? 'nothing bought in this quote token' : undefined} testId="avg" />
        <Fact
          label="Compared with what you paid"
          value={result === null ? DASH : `${result > 0n ? '▲' : result < 0n ? '▼' : '='} ${signed(result, qd, formatAtoms)} quote`}
          hint={result === null ? 'needs a last price and a like-for-like cost' : `on ${formatAtoms(r.resultTokens, r.decimals)} tokens bought through crosses`}
          testId="result"
        />
      </dl>
      {r.holdsOther ? <p className="mt-3 text-xs text-muted">You hold more than you bought through crosses. Tokens that arrived another way have no cost here, so the comparison leaves them out.</p> : null}

      <div className="mt-5 grid gap-5 border-t border-border pt-4 lg:grid-cols-2">
        <SellNext row={r} now={now} />
        {r.treasury ? <TreasuryRights row={r} /> : <p className="text-sm text-muted">No treasury is behind this token, so it carries no rights beyond holding it.</p>}
      </div>
    </article>
  );
}

function SellNext({ row: r, now }: { row: HoldingRow; now: number }) {
  const [quote, setQuote] = useState<{ state: 'idle' } | { state: 'loading' } | { state: 'done'; text: string; lines: string[] } | { state: 'error'; text: string }>({ state: 'idle' });
  const next = r.next;
  const isOpen = next !== null && Number(next.open_ts) <= now;
  async function compare() {
    if (!next || r.held === null || r.held === 0n || !r.mark) return;
    setQuote({ state: 'loading' });
    try {
      const res = await fetch(`${API_URL}/v1/router/quote?base=${r.mint}&quote=${r.mark.quoteMint}&side=sell&amount=${r.held}`, { cache: 'no-store' });
      const j = (await res.json()) as { best?: { venue?: string; pricePerBase?: string } | null; venues?: { venue: string; pricePerBase?: string; fill?: string }[]; excluded?: { venue: string; reason: string }[]; error?: string };
      if (!res.ok) return setQuote({ state: 'error', text: j.error ?? `HTTP ${res.status}` });
      const lines = [
        ...(j.venues ?? []).map((v) => `${v.venue}: ${v.pricePerBase ? `${formatAtoms(BigInt(v.pricePerBase), r.mark!.quoteDecimals)} per token` : 'priced'}${v.fill ? `, ${v.fill}` : ''}`),
        ...(j.excluded ?? []).map((e) => `${e.venue}: ${e.reason}`),
      ];
      setQuote({ state: 'done', text: j.best ? `Best route now: ${j.best.venue}.` : 'No route can fill this amount right now.', lines });
    } catch {
      setQuote({ state: 'error', text: 'The router could not be reached.' });
    }
  }
  return (
    <div>
      <h4 className="text-sm font-medium">Sell in the next cross</h4>
      {next ? (
        <>
          <p className="mt-1 text-sm text-muted">
            {isOpen ? `Open now, taking orders until ${utc(Number(next.close_ts))}` : `Opens ${utc(Number(next.open_ts))}`}. One clearing price for everyone who trades, and you can cancel until it closes.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <Link href={`/crosses/${next.address}`} className="inline-flex min-h-11 items-center rounded-full bg-accent-fill px-5 text-sm font-medium text-on-accent hover:opacity-90">
              Open cross {shortAddress(next.address)}
            </Link>
            <FollowButton kind="crosses" address={next.address} label={`cross ${shortAddress(next.address)}`} />
            <button type="button" onClick={() => void compare()} disabled={quote.state === 'loading' || !r.held || !r.mark} className="min-h-11 rounded-full border border-border-strong px-4 text-sm hover:bg-surface disabled:opacity-50">
              {quote.state === 'loading' ? 'Comparing…' : 'Compare with selling now'}
            </button>
          </div>
        </>
      ) : (
        <p className="mt-1 text-sm text-muted" data-testid="no-next">
          No cross of this token is scheduled. When one is, it appears in the <Link href="/calendar" className="underline underline-offset-4 hover:text-ink">calendar</Link>. Selling now needs a market for the token, and there is none on devnet.
        </p>
      )}
      {quote.state === 'done' ? (
        <div role="status" className="mt-3 rounded-lg bg-surface p-3 text-sm" data-testid="route-compare">
          <p className="font-medium">{quote.text}</p>
          <ul className="mt-2 space-y-1 text-xs text-muted">
            {quote.lines.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-muted">A comparison only: nothing is signed or sent.</p>
        </div>
      ) : null}
      {quote.state === 'error' ? (
        <p role="alert" className="mt-3 text-sm text-accent-text">
          {quote.text}
        </p>
      ) : null}
    </div>
  );
}

function TreasuryRights({ row: r }: { row: HoldingRow }) {
  const t = r.treasury!;
  const q = (v: bigint | string) => formatAtoms(BigInt(v), t.quoteDecimals);
  const entitles = t.rights.filter((c) => c.kind === 'entitles').length;
  const notProvided = t.rights.filter((c) => c.kind === 'not-provided').length;
  return (
    <div data-testid="treasury-rights">
      <h4 className="text-sm font-medium">Rights and distributions</h4>
      <p className="mt-1 text-sm text-muted">
        This is an ownership coin with a treasury ({t.state}). Holding it gives {entitles} rights the program enforces and does not give {notProvided} things holders often assume. <Link href={`/rights#${t.address}`} className="text-accent-text underline">Read them</Link> ·{' '}
        <Link href={`/treasury/${t.address}`} className="text-accent-text underline">Open the treasury</Link>.
      </p>
      {t.state === 'Liquidating' && t.entitlement !== null ? (
        <p className="mt-2 rounded-lg bg-surface p-3 text-sm" data-testid="entitlement">
          The treasury is liquidating. Your {r.held === null ? '' : formatAtoms(r.held, r.decimals)} coins redeem for <span className="font-mono">{q(t.entitlement)}</span> quote: your share of the snapshot ({q(t.snapshot!.vault)} over {formatAtoms(BigInt(t.snapshot!.supply), r.decimals)} coins), rounded down.
        </p>
      ) : null}
      {t.received.length > 0 ? (
        <ul className="mt-2 space-y-1 text-sm" data-testid="received">
          {t.received.map((x) => (
            <li key={x.signature}>
              Redeemed {formatAtoms(BigInt(x.burned), r.decimals)} coins for <span className="font-mono">{q(x.paid)}</span> quote{x.time ? ` on ${new Date(x.time * 1000).toISOString().slice(0, 10)}` : ''}.
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-sm text-muted">No distribution or redemption has reached this wallet from this treasury.</p>
      )}
    </div>
  );
}

const utc = (secs: number) => `${new Date(secs * 1000).toISOString().replace('T', ' ').slice(0, 16)} UTC`;
