'use client';

import type { UiWalletAccount } from '@wallet-standard/ui';
import { useCallback, useEffect, useState } from 'react';
import { StateBadge } from '@/components/state-badge';
import { API_URL } from '@/lib/api';
import type { AuthenticityView, PromiseView } from '@/lib/trust-types';
import type { BookResponse, CrossDetail } from '@/lib/types';
import { type Market, shortAddress } from '@/lib/units';
import { useWallet } from '@/lib/wallet';
import { BookChart } from './book-chart';
import { Hero } from './hero';
import { MyOrders } from './my-orders';
import { OrderTicket } from './order-ticket';
import type { OrderRecord } from './order-record';
import { OrdersTab } from './orders-tab';
import type { OwnMarks } from './own-orders';
import { type Proof, ProofLink, ProofTab } from './proof-tab';
import { ReplayTab } from './replay-tab';
import { SettlePanel } from './settle-panel';
import { SignedBand } from './signed-band';
import { Tabs } from './tabs';
import { TimelineView } from './timeline-view';
import type { Phase } from './timeline';
import { TokenFacts } from './token-facts';
import { useSigner } from './use-signer';

export type { Phase } from './timeline';

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

const NO_MARKS: OwnMarks = { marks: [], unlocated: 0, hidden: 0 };

export function CrossView({ initial, serverNow, initialIdentity, initialBand }: { initial: CrossDetail; serverNow: string; initialIdentity: AuthenticityView | null; initialBand: PromiseView | null }) {
  const [cross, setCross] = useState(initial);
  const [book, setBook] = useState<BookResponse | null>(null);
  const [orders, setOrders] = useState<OrderRecord[] | null>(null);
  const [ordersLoaded, setOrdersLoaded] = useState(false);
  const [proof, setProof] = useState<Proof | null>(null);
  const [proofLoaded, setProofLoaded] = useState(false);
  const [own, setOwn] = useState<OwnMarks>(NO_MARKS);
  // Start from the server's clock so the first client render matches the server HTML exactly.
  const [now, setNow] = useState(() => BigInt(serverNow));
  const [version, setVersion] = useState(0);
  const { account } = useWallet();

  const refresh = useCallback(async () => {
    const [c, b, o] = await Promise.all([
      getJson<CrossDetail>(`/v1/crosses/${initial.address}`),
      getJson<BookResponse>(`/v1/crosses/${initial.address}/book`),
      getJson<{ orders: OrderRecord[] }>(`/v1/crosses/${initial.address}/orders`),
    ]);
    if (c) setCross(c);
    if (b) setBook(b);
    if (o) setOrders(o.orders);
    setOrdersLoaded(true);
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

  // The fairness proof exists once the cross has settled; it is read again if the state changes.
  const settled = cross.state !== 'Live';
  useEffect(() => {
    if (!settled) return;
    let live = true;
    void getJson<Proof>(`/v1/crosses/${initial.address}/proof`).then((p) => {
      if (!live) return;
      setProof(p);
      setProofLoaded(true);
    });
    return () => {
      live = false;
    };
  }, [initial.address, settled, cross.state]);

  const phase = phaseOf(cross, now);
  const m = marketOf(cross);

  const bookTab = (
    <section aria-labelledby="book-h">
      <h2 id="book-h" className="font-mono text-xs uppercase tracking-widest text-muted">
        Order book by price
      </h2>
      <p className="mt-2 text-sm text-muted">
        {cross.disclosure === 'sealed'
          ? 'Only revealed bids appear here. A sealed bid carries no price until its owner reveals it.'
          : 'Every resting order, by price. The price it trades at is where demand and supply meet.'}
      </p>
      <div className="mt-5">
        <BookChart
          book={book}
          market={m}
          clearing={cross.clearing?.price ?? book?.indicative?.price ?? null}
          clearingLabel={cross.clearing ? 'Cleared price' : 'Indicative price'}
          own={own}
          connected={account !== null}
        />
      </div>
    </section>
  );

  return (
    <div className="mx-auto max-w-[1200px] px-4 py-10 sm:px-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-[28px] font-semibold tracking-tight sm:text-[34px]">Cross {shortAddress(cross.address)}</h1>
        <StateBadge state={cross.state} phase={phase === 'settled' ? 'awaiting-settlement' : phase} />
      </div>
      <p className="mt-2 text-sm text-muted">
        {cross.kind} · {cross.disclosure === 'sealed' ? 'sealed bids' : 'open book'} · base {cross.baseMint ? shortAddress(cross.baseMint) : 'minted at settlement'} · quote {shortAddress(cross.quoteMint)}
        {cross.gateMint ? ' · eligibility pass required' : ''}
      </p>

      <div className="mt-8">
        <Hero cross={cross} book={book} orders={orders} phase={phase} now={now} market={m} />
      </div>

      <div className="mt-6 grid items-start gap-6 lg:grid-cols-[1.4fr_1fr]">
        <div className="min-w-0 rounded-[var(--radius-card)] border border-border p-4 sm:p-6">
          <Tabs
            label="Cross details"
            initial="overview"
            tabs={[
              {
                id: 'overview',
                label: 'Overview',
                content: (
                  <div className="space-y-8">
                    <TimelineView cross={cross} book={book} orders={orders} phase={phase} market={m} />
                    <TokenFacts cross={cross} market={m} identity={initialIdentity} />
                  </div>
                ),
              },
              { id: 'book', label: 'Book', content: bookTab },
              { id: 'orders', label: 'Orders', content: <OrdersTab cross={cross} orders={orders} loaded={ordersLoaded} phase={phase} market={m} owner={account?.address ?? null} /> },
              { id: 'proof', label: 'Proof', content: <ProofTab cross={cross} proof={proof} loaded={proofLoaded} market={m} /> },
              { id: 'replay', label: 'Replay', content: <ReplayTab cross={cross} version={version} market={m} /> },
            ]}
          />
        </div>

        {/* What a person can do comes first on a phone, and the panels that load after the page go below it so they never push it down. */}
        <div className="order-first space-y-6 lg:order-none">
          {account ? <Connected account={account} cross={cross} phase={phase} market={m} book={book} version={version} onChanged={refresh} onMarks={setOwn} /> : <ConnectPrompt phase={phase} />}
          {phase === 'awaiting-settlement' && !account ? (
            <p className="rounded-[var(--radius-card)] border border-border p-5 text-sm text-muted">
              This cross is ready to settle. Anyone can settle it; connect a wallet to do so, or wait for a keeper.
            </p>
          ) : null}
          <SignedBand address={cross.address} market={m} version={version} initial={initialBand} />
          {settled ? <ProofLink address={cross.address} proof={proof} /> : null}
        </div>
      </div>
    </div>
  );
}

function Connected({
  account,
  cross,
  phase,
  market,
  book,
  version,
  onChanged,
  onMarks,
}: {
  account: UiWalletAccount;
  cross: CrossDetail;
  phase: Phase;
  market: Market;
  book: BookResponse | null;
  version: number;
  onChanged: () => void;
  onMarks: (marks: OwnMarks) => void;
}) {
  const sign = useSigner(account);
  return (
    <>
      {phase === 'open' ? <OrderTicket cross={cross} market={market} owner={account.address} sign={sign} book={book} onPlaced={onChanged} /> : null}
      {phase === 'awaiting-settlement' ? <SettlePanel cross={cross} payer={account.address} sign={sign} onDone={onChanged} /> : null}
      <MyOrders cross={cross} phase={phase} market={market} owner={account.address} sign={sign} version={version} onChanged={onChanged} onMarks={onMarks} />
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
