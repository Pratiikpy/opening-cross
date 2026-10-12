'use client';

import type { UiWalletAccount } from '@wallet-standard/ui';
import { useCallback, useEffect, useState } from 'react';
import { StateBadge } from '@/components/state-badge';
import { API_URL } from '@/lib/api';
import type { AuthenticityView, PromiseView } from '@/lib/trust-types';
import type { BookResponse, CrossDetail } from '@/lib/types';
import { type Market, formatAtoms, formatDuration, formatPrice, shortAddress } from '@/lib/units';
import { useWallet } from '@/lib/wallet';
import { BookChart } from './book-chart';
import { IdentityPanel } from './identity-panel';
import { MyOrders } from './my-orders';
import { OrderTicket } from './order-ticket';
import { SettlePanel } from './settle-panel';
import { SignedBand } from './signed-band';
import { useSigner } from './use-signer';

export type Phase = 'upcoming' | 'open' | 'reveal' | 'awaiting-settlement' | 'settled';

export function phaseOf(c: CrossDetail, now: bigint): Phase {
  if (c.state !== 'Live') return 'settled';
  if (now < BigInt(c.window.openTs)) return 'upcoming';
  if (now < BigInt(c.window.closeTs)) return 'open';
  if (c.disclosure === 'sealed' && now < BigInt(c.window.revealEndTs)) return 'reveal';
  return 'awaiting-settlement';
}

export function marketOf(c: CrossDetail): Market {
  return { priceScale: BigInt(c.grid.priceScale), baseDecimals: c.decimals.base, quoteDecimals: c.decimals.quote };
}

async function getJson<T>(path: string): Promise<T | null> {
  try {
    const r = await fetch(`${API_URL}${path}`, { cache: 'no-store' });
    return r.ok ? ((await r.json()) as T) : null;
  } catch {
    return null;
  }
}

export function CrossView({ initial, serverNow, initialIdentity, initialBand }: { initial: CrossDetail; serverNow: string; initialIdentity: AuthenticityView | null; initialBand: PromiseView | null }) {
  const [cross, setCross] = useState(initial);
  const [book, setBook] = useState<BookResponse | null>(null);
  // Start from the server's clock so the first client render matches the server HTML exactly.
  const [now, setNow] = useState(() => BigInt(serverNow));
  const [version, setVersion] = useState(0);
  const { account } = useWallet();

  const refresh = useCallback(async () => {
    const [c, b] = await Promise.all([getJson<CrossDetail>(`/v1/crosses/${initial.address}`), getJson<BookResponse>(`/v1/crosses/${initial.address}/book`)]);
    if (c) setCross(c);
    if (b) setBook(b);
    setVersion((v) => v + 1);
  }, [initial.address]);

  // Live updates: the API's event stream for this cross, with a slow poll as a fallback.
  useEffect(() => {
    void refresh();
    const tick = setInterval(() => setNow(BigInt(Math.floor(Date.now() / 1000))), 1000);
    const poll = setInterval(() => void refresh(), 15_000);
    let ws: WebSocket | null = null;
    try {
      ws = new WebSocket(`${API_URL.replace(/^http/, 'ws')}/v1/stream?cross=${initial.address}`);
      ws.onmessage = (m) => {
        if (String(m.data).includes('"type":"event"')) void refresh();
      };
    } catch {
      ws = null;
    }
    return () => {
      clearInterval(tick);
      clearInterval(poll);
      ws?.close();
    };
  }, [initial.address, refresh]);

  const phase = phaseOf(cross, now);
  const m = marketOf(cross);
  const nextTs = phase === 'upcoming' ? cross.window.openTs : phase === 'open' ? cross.window.closeTs : phase === 'reveal' ? cross.window.revealEndTs : null;

  return (
    <div className="mx-auto max-w-[1200px] px-4 py-10 sm:px-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-[28px] font-semibold tracking-tight sm:text-[34px]">Cross {shortAddress(cross.address)}</h1>
        <StateBadge state={cross.state} phase={phase === 'settled' ? 'awaiting-settlement' : phase} />
      </div>
      <p className="mt-2 text-sm text-muted">
        {cross.kind} · {cross.disclosure === 'sealed' ? 'sealed bids' : 'open book'} · base {cross.baseMint ? shortAddress(cross.baseMint) : 'minted at settlement'} · quote{' '}
        {shortAddress(cross.quoteMint)}
        {cross.gateMint ? ' · eligibility pass required' : ''}
      </p>

      <div className="mt-8 grid items-start gap-6 lg:grid-cols-[1.4fr_1fr]">
        <section aria-labelledby="price" className="rounded-[var(--radius-card)] border border-border p-6">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <h2 id="price" className="font-mono text-xs uppercase tracking-widest text-muted">
                {cross.clearing ? 'Clearing price' : phase === 'settled' ? 'Result' : phase === 'upcoming' || phase === 'open' ? 'Price if it closed now' : 'Price once it settles'}
              </h2>
              <p className="mt-2 text-[44px] font-semibold leading-none tracking-tight" data-testid="price">
                {cross.clearing
                  ? formatPrice(BigInt(cross.clearing.price), m)
                  : cross.state === 'NoPrint' || cross.state === 'Finalized'
                    ? 'No print'
                    : book?.indicative
                      ? formatPrice(BigInt(book.indicative.price), m)
                      : cross.disclosure === 'sealed' && phase !== 'settled'
                        ? 'Sealed'
                        : 'No price yet'}
              </p>
              <p className="mt-2 text-sm text-muted">
                {cross.clearing
                  ? `${formatAtoms(BigInt(cross.clearing.matched), m.baseDecimals)} tokens traded at this one price`
                  : cross.noPrintReason
                    ? `Did not print (${cross.noPrintReason}); every order is refunded in full.`
                    : book?.indicative
                      ? `${formatAtoms(BigInt(book.indicative.matched), m.baseDecimals)} tokens would trade. ${phase === 'upcoming' || phase === 'open' ? 'Indicative until the call closes.' : 'Indicative: settling the cross fixes the final price.'}`
                      : cross.disclosure === 'sealed'
                        ? 'Sealed: prices stay hidden until bids are revealed.'
                        : 'No crossing orders yet.'}
              </p>
            </div>
            {nextTs ? (
              <div className="text-right">
                <p className="text-xs text-muted">{phase === 'upcoming' ? 'Opens in' : phase === 'open' ? 'Closes in' : 'Reveals close in'}</p>
                <p className="font-mono text-lg" data-testid="countdown">
                  {formatDuration(BigInt(nextTs) - now)}
                </p>
              </div>
            ) : null}
          </div>
          <div className="mt-6">
            <BookChart book={book} market={m} clearing={cross.clearing?.price ?? book?.indicative?.price ?? null} />
          </div>
          <dl className="mt-6 grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
            <Fact label="Orders" value={`${cross.orders.total}`} />
            <Fact label="Open orders" value={`${cross.orders.open}`} />
            <Fact label="Seller fee" value={`${(cross.fees.protocolBps + cross.fees.integratorBps) / 100}%`} />
            <Fact label="Closes (UTC)" value={new Date(Number(cross.window.closeTs) * 1000).toISOString().replace('T', ' ').slice(0, 16)} />
          </dl>
        </section>

        <div className="space-y-6">
          {/* What a person can do comes first; the panels that load after the page (band, identity, proof) go below it so they never push it down. */}
          {account ? <Connected account={account} cross={cross} phase={phase} market={m} version={version} onChanged={refresh} /> : <ConnectPrompt phase={phase} />}
          {phase === 'awaiting-settlement' && !account ? (
            <p className="rounded-[var(--radius-card)] border border-border p-5 text-sm text-muted">
              This cross is ready to settle. Anyone can settle it; connect a wallet to do so, or wait for a keeper.
            </p>
          ) : null}
          <SignedBand address={cross.address} market={m} version={version} initial={initialBand} />
          <IdentityPanel address={cross.address} initial={initialIdentity} />
          {cross.state !== 'Live' ? <ProofLink address={cross.address} /> : null}
        </div>
      </div>
    </div>
  );
}

function Connected({ account, cross, phase, market, version, onChanged }: { account: UiWalletAccount; cross: CrossDetail; phase: Phase; market: Market; version: number; onChanged: () => void }) {
  const sign = useSigner(account);
  return (
    <>
      {phase === 'open' ? <OrderTicket cross={cross} market={market} owner={account.address} sign={sign} onPlaced={onChanged} /> : null}
      {phase === 'awaiting-settlement' ? <SettlePanel cross={cross} payer={account.address} sign={sign} onDone={onChanged} /> : null}
      <MyOrders cross={cross} phase={phase} market={market} owner={account.address} sign={sign} version={version} onChanged={onChanged} />
    </>
  );
}

function ConnectPrompt({ phase }: { phase: Phase }) {
  return (
    <div className="rounded-[var(--radius-card)] border border-border p-5 text-sm text-muted">
      {phase === 'open' ? 'Connect a wallet to place an order in this cross.' : 'Connect a wallet to see your orders, fills and refunds in this cross.'}
    </div>
  );
}

function ProofLink({ address }: { address: string }) {
  const [proof, setProof] = useState<{ verified: boolean; notes: string[] } | null>(null);
  useEffect(() => {
    void getJson<{ verified: boolean; notes: string[] }>(`/v1/crosses/${address}/proof`).then(setProof);
  }, [address]);
  if (!proof) return null;
  return (
    <div className="rounded-[var(--radius-card)] border border-border p-5 text-sm">
      <p className="font-medium">{proof.verified ? 'Result independently verified' : 'Result did not verify'}</p>
      <p className="mt-1 text-muted">
        A second implementation recomputed this cross from its on-chain book and {proof.verified ? 'matched' : 'did not match'} the recorded result.
      </p>
      {proof.notes.map((n) => (
        <p key={n} className="mt-1 text-muted">
          {n}
        </p>
      ))}
      <a className="mt-3 inline-block text-accent-text underline" href={`${API_URL}/v1/crosses/${address}/proof`}>
        Download the fairness proof
      </a>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="mt-1 font-mono">{value}</dd>
    </div>
  );
}
