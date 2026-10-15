'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { StateBadge } from '@/components/state-badge';
import { Chip, SmallButton } from '@/components/issue-wizard/fields';
import { type CrossRow, type TreasuryRow, apiRead, crossSummary, treasuries as readTreasuries } from '@/lib/issuer-data';
import { type OrderRow, feesPaid, holderRegister, ownCrosses, registerCsv, tasks } from '@/lib/issuer-dashboard';
import type { QaThread } from '@/lib/issuer-board';
import type { BookResponse, CrossDetail } from '@/lib/types';
import { formatAtoms, formatPrice, shortAddress } from '@/lib/units';
import { useWallet } from '@/lib/wallet';
import { IssuerLiquidityView } from '@/components/pools/issuer-liquidity';
import { liquidityHref } from '@/lib/issuer-nav';
import { ConnectPrompt } from './connect-prompt';

const when = (secs: string) => `${new Date(Number(secs) * 1000).toISOString().replace('T', ' ').slice(0, 16)} UTC`;

export function IssuerOverview() {
  const { account } = useWallet();
  if (!account) return <ConnectPrompt what="your crosses, the holders who took part, the fees you paid and what needs your attention" />;
  return <Overview wallet={account.address} />;
}

function Overview({ wallet }: { wallet: string }) {
  const [crosses, setCrosses] = useState<CrossRow[] | null>(null);
  const [treasuryRows, setTreasuryRows] = useState<TreasuryRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [questions, setQuestions] = useState({ requested: 0, overdue: 0 });
  const [nowSecs, setNowSecs] = useState(() => Math.floor(Date.now() / 1000));

  useEffect(() => {
    let live = true;
    void (async () => {
      const [c, t] = await Promise.all([crossSummary(1000), readTreasuries()]);
      if (!live) return;
      if (!c.ok) return setError(c.error);
      const mine = ownCrosses(c.data.crosses, wallet);
      setCrosses(c.data.crosses);
      setSelected((s) => s ?? mine[0]?.address ?? null);
      const myTreasuries = t.ok ? t.data.treasuries.filter((x) => x.authority === wallet) : [];
      setTreasuryRows(t.ok ? t.data.treasuries : []);
      // Questions about the issuer's most recent crosses and all its treasuries. A subject the API has not indexed answers 404 and counts as none.
      const subjects = [...mine.slice(0, 6).map((x) => x.address), ...myTreasuries.map((x) => x.address)];
      let requested = 0;
      let overdue = 0;
      await Promise.all(
        subjects.map(async (s) => {
          const r = await apiRead<QaThread>(`/v1/issuer/qa?subject=${s}`);
          if (!r.ok) return;
          for (const q of r.data.questions) {
            if (q.state === 'requested') requested += 1;
            if (q.state === 'overdue') overdue += 1;
          }
        }),
      );
      if (live) setQuestions({ requested, overdue });
    })();
    const t = setInterval(() => setNowSecs(Math.floor(Date.now() / 1000)), 15_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [wallet]);

  const mine = useMemo(() => (crosses ? ownCrosses(crosses, wallet) : []), [crosses, wallet]);
  const myTreasuries = useMemo(() => (treasuryRows ?? []).filter((t) => t.authority === wallet), [treasuryRows, wallet]);
  const todo = useMemo(() => tasks({ wallet, crosses: crosses ?? [], treasuries: treasuryRows ?? [], questions, nowSecs }), [wallet, crosses, treasuryRows, questions, nowSecs]);

  if (error) return <p role="alert" className="mt-8 text-sm text-accent-text">{error}</p>;
  if (!crosses) return <p role="status" className="mt-8 text-sm text-muted">Reading your crosses…</p>;

  return (
    <div className="mt-8 space-y-10">
      <section aria-labelledby="tasks-h">
        <h2 id="tasks-h" className="text-xl font-semibold tracking-tight">
          Needs you
        </h2>
        {todo.length === 0 ? (
          <p className="mt-3 text-sm text-muted" data-testid="no-tasks">
            Nothing needs you right now.
          </p>
        ) : (
          <ul className="mt-3 space-y-3" data-testid="tasks">
            {todo.map((t) => (
              <li key={t.id} className="flex flex-wrap items-start gap-3 rounded-lg border border-border p-4 text-sm">
                <Chip tone={t.tone === 'now' ? 'block' : t.tone === 'soon' ? 'warn' : 'info'}>{t.tone === 'now' ? 'Now' : t.tone === 'soon' ? 'Soon' : 'FYI'}</Chip>
                <div className="min-w-0 flex-1 basis-60">
                  <Link href={t.href} className="font-medium underline-offset-4 hover:underline">
                    {t.title}
                  </Link>
                  <p className="mt-0.5 text-muted">{t.detail}</p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="crosses-h">
        <h2 id="crosses-h" className="text-xl font-semibold tracking-tight">
          Your crosses
        </h2>
        {mine.length === 0 ? (
          <p className="mt-3 text-sm text-muted" data-testid="no-crosses">
            This wallet has not created a cross on this network. <Link href="/issue" className="underline underline-offset-4">Open one</Link>.
          </p>
        ) : (
          <ul className="mt-3 grid gap-3 md:grid-cols-2" data-testid="own-crosses">
            {mine.slice(0, 12).map((c) => (
              <li key={c.address}>
                <button
                  type="button"
                  onClick={() => setSelected(c.address)}
                  aria-pressed={selected === c.address}
                  data-testid={`pick-${c.address}`}
                  className={`block min-h-11 w-full rounded-[var(--radius-card)] border p-4 text-left transition-colors hover:bg-surface ${selected === c.address ? 'border-ink bg-surface' : 'border-border'}`}
                >
                  <span className="flex flex-wrap items-center gap-2">
                    <StateBadge state={c.state} phase={nowSecs < Number(c.openTs) ? 'upcoming' : nowSecs < Number(c.closeTs) ? 'open' : nowSecs < Number(c.revealEndTs) ? 'reveal' : 'awaiting-settlement'} />
                    <span className="font-mono text-xs text-muted">{shortAddress(c.address)}</span>
                  </span>
                  <span className="mt-2 block text-sm text-muted">
                    {c.orders} {c.orders === 1 ? 'order' : 'orders'} · opens {when(c.openTs)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {selected && mine.some((c) => c.address === selected) ? <SelectedCross key={selected} address={selected} nowSecs={nowSecs} /> : null}

      <section aria-labelledby="treasury-h">
        <h2 id="treasury-h" className="text-xl font-semibold tracking-tight">
          Treasury
        </h2>
        {myTreasuries.length === 0 ? (
          <p className="mt-3 text-sm text-muted" data-testid="no-treasury">
            You have no treasury. It is optional, and can only be created for a coin whose supply is fixed. <Link href="/issuer/treasury/new" className="underline underline-offset-4">Create one</Link>.
          </p>
        ) : (
          <ul className="mt-3 grid gap-3 md:grid-cols-2" data-testid="own-treasuries">
            {myTreasuries.map((t) => {
              const d = t.quoteDecimals ?? 6;
              return (
                <li key={t.address} className="rounded-[var(--radius-card)] border border-border p-4 text-sm">
                  <p className="font-mono text-xs text-muted">{shortAddress(t.address)}</p>
                  <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1">
                    <dt className="text-muted">In the vault</dt>
                    <dd className="text-right font-mono">{t.vaultBalance ? formatAtoms(BigInt(t.vaultBalance), d) : 'unavailable'}</dd>
                    <dt className="text-muted">Left this period</dt>
                    <dd className="text-right font-mono">{t.spend ? formatAtoms(BigInt(t.spend.allowanceRemaining), d) : 'unavailable'}</dd>
                    <dt className="text-muted">Disclosure</dt>
                    <dd className="text-right">{t.disclosure.state}</dd>
                  </dl>
                  <Link href={`/treasury/${t.address}`} className="mt-3 inline-block underline underline-offset-4">
                    How holders see it
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

function SelectedCross({ address, nowSecs }: { address: string; nowSecs: number }) {
  const [detail, setDetail] = useState<CrossDetail | null>(null);
  const [orders, setOrders] = useState<OrderRow[] | null>(null);
  const [book, setBook] = useState<BookResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    let live = true;
    void (async () => {
      const [d, o] = await Promise.all([apiRead<CrossDetail>(`/v1/crosses/${address}`), apiRead<{ orders: OrderRow[] }>(`/v1/crosses/${address}/orders`)]);
      if (!live) return;
      if (!d.ok) return setErr(d.error);
      setDetail(d.data);
      setOrders(o.ok ? o.data.orders : []);
      if (d.data.state === 'Live') {
        const b = await apiRead<BookResponse>(`/v1/crosses/${address}/book`);
        if (live && b.ok) setBook(b.data);
      }
    })();
    return () => {
      live = false;
    };
  }, [address]);

  if (err) return <p role="alert" className="text-sm text-accent-text">{err}</p>;
  if (!detail || !orders) return <p role="status" className="text-sm text-muted">Reading this cross…</p>;

  const market = { priceScale: BigInt(detail.grid.priceScale), baseDecimals: detail.decimals.base, quoteDecimals: detail.decimals.quote };
  const settled = detail.state === 'Finalized' || detail.state === 'Cleared';
  const holders = holderRegister(orders, detail.state === 'Finalized');
  const fees = feesPaid(detail);
  const indicative = book?.indicative ?? null;
  const shown = showAll ? holders : holders.slice(0, 25);
  const q = (a: bigint) => formatAtoms(a, market.quoteDecimals);
  const t = (a: bigint) => formatAtoms(a, market.baseDecimals);

  return (
    <section aria-labelledby="sel-h" className="space-y-6 rounded-[var(--radius-card)] border border-border p-5" data-testid="selected-cross">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="sel-h" className="text-xl font-semibold tracking-tight">
          This cross
        </h2>
        <Link href={`/crosses/${address}`} className="min-h-11 py-2 text-sm underline underline-offset-4">
          Open its page
        </Link>
      </div>

      <dl className="grid gap-3 sm:grid-cols-3" data-testid="raise-status">
        <div className="rounded-lg bg-surface p-3">
          <dt className="text-xs text-muted">Orders</dt>
          <dd className="text-xl font-semibold">{detail.orders.total}</dd>
        </div>
        <div className="rounded-lg bg-surface p-3">
          <dt className="text-xs text-muted">{detail.clearing ? 'Cleared at' : detail.state === 'Live' ? 'Indicative price' : 'Price'}</dt>
          <dd className="text-xl font-semibold">{detail.clearing ? formatPrice(BigInt(detail.clearing.price), market) : indicative ? formatPrice(BigInt(indicative.price), market) : '—'}</dd>
          <dd className="text-xs text-muted">{detail.clearing ? 'quote per token' : indicative ? 'if it cleared now' : detail.noPrintReason ? `did not print: ${detail.noPrintReason}` : detail.disclosure === 'sealed' && detail.state === 'Live' ? 'sealed until reveal' : 'no price yet'}</dd>
        </div>
        <div className="rounded-lg bg-surface p-3">
          <dt className="text-xs text-muted">Tokens {detail.clearing ? 'sold' : 'that would trade'}</dt>
          <dd className="text-xl font-semibold">{detail.clearing ? t(BigInt(detail.clearing.matched)) : indicative ? t(BigInt(indicative.matched)) : '—'}</dd>
        </div>
      </dl>
      <p className="text-xs text-muted">
        Window {when(detail.window.openTs)} to {when(detail.window.closeTs)}
        {nowSecs < Number(detail.window.openTs) ? ', not open yet' : nowSecs < Number(detail.window.closeTs) ? ', open now' : ', closed'}. Nothing here can change the price or end the call early.
      </p>

      <div>
        <h3 className="font-medium">Fees</h3>
        {fees ? (
          <dl className="mt-2 grid max-w-md grid-cols-[1fr_auto] gap-x-6 gap-y-1 text-sm" data-testid="fees-paid">
            <dt className="text-muted">Tokens sold, in quote</dt>
            <dd className="text-right font-mono">{q(fees.notional)}</dd>
            <dt className="text-muted">Protocol ({detail.fees.protocolBps} bps)</dt>
            <dd className="text-right font-mono">{q(fees.protocol)}</dd>
            <dt className="text-muted">Integrator ({detail.fees.integratorBps} bps)</dt>
            <dd className="text-right font-mono">{q(fees.integrator)}</dd>
            <dt className="font-medium">Total taken from the sale</dt>
            <dd className="text-right font-mono font-medium">{q(fees.total)}</dd>
          </dl>
        ) : (
          <p className="mt-2 text-sm text-muted" data-testid="no-fees">
            {detail.state === 'Live' ? `Fixed at creation: ${detail.fees.protocolBps} bps to the protocol and ${detail.fees.integratorBps} bps to the integrator, taken from the sale if it prints.` : 'It did not print, so no fee was taken.'}
          </p>
        )}
        <p className="mt-2 text-xs text-muted">Computed from the clearing price and the tokens sold with the program’s own formula, so it can differ from the transferred amount by a few atoms of rounding.</p>
      </div>

      <div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="font-medium">Holder register</h3>
          {holders.length > 0 ? (
            <SmallButton
              testId="download-register"
              onClick={() => {
                const blob = new Blob([registerCsv(holders, market.baseDecimals, market.quoteDecimals)], { type: 'text/csv' });
                const a = document.createElement('a');
                a.href = URL.createObjectURL(blob);
                a.download = `holders-${address.slice(0, 8)}.csv`;
                a.click();
                URL.revokeObjectURL(a.href);
              }}
            >
              Download CSV
            </SmallButton>
          ) : null}
        </div>
        {holders.length === 0 ? (
          <p className="mt-2 text-sm text-muted" data-testid="no-holders">
            {detail.disclosure === 'sealed' && detail.state === 'Live' ? 'Bids are sealed until the reveal, so the API serves no wallets yet.' : 'No bids have been placed.'}
          </p>
        ) : (
          <>
            <ul className="mt-2 divide-y divide-border border-y border-border text-sm" data-testid="register">
              {shown.map((h) => (
                <li key={h.owner} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-2">
                  <span className="font-mono text-xs">{shortAddress(h.owner)}</span>
                  <span className="text-muted">
                    {h.orders} {h.orders === 1 ? 'order' : 'orders'} · {q(h.escrow)} quote escrowed
                  </span>
                  <span className="font-mono">{settled ? `${t(h.filled)} tokens` : 'pending'}</span>
                </li>
              ))}
            </ul>
            {holders.length > shown.length ? (
              <div className="mt-2">
                <SmallButton onClick={() => setShowAll(true)}>Show all {holders.length}</SmallButton>
              </div>
            ) : null}
          </>
        )}
        <p className="mt-2 text-xs text-muted">The wallets that bid and what each received in this cross. It is not a list of current holders: tokens move after settlement, and the chain, not this page, is the record of who holds them.</p>
      </div>

      <div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="font-medium">Liquidity after the cross</h3>
          <Link className="min-h-11 py-2 text-sm underline underline-offset-4" href={liquidityHref(address)} data-testid="liquidity-link">
            Open the liquidity page
          </Link>
        </div>
        {settled ? (
          <div className="mt-3" data-testid="liquidity-health">
            <IssuerLiquidityView cross={address} />
          </div>
        ) : (
          <p className="mt-2 text-sm text-muted" data-testid="liquidity-note">
            No pool exists yet: the market opens at the clearing price, so this section reads the pools from chain once the cross has cleared.
          </p>
        )}
      </div>
      <div className="flex flex-wrap gap-4 text-sm">
        <Link className="underline underline-offset-4" href="/issuer/disclosures">Questions from holders</Link>
        <Link className="underline underline-offset-4" href="/issuer/growth">Contacts and referrals</Link>
      </div>
    </section>
  );
}
