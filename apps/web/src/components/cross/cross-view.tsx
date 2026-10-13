'use client';

import type { UiWalletAccount } from '@wallet-standard/ui';
import { useCallback, useEffect, useState } from 'react';
import { FollowButton } from '@/components/alerts/follow-button';
import { StateBadge } from '@/components/state-badge';
import { API_URL } from '@/lib/api';
import { HOLDER_API_URL } from '@/lib/holder-api';
import { type Programs, usePrograms } from '@/lib/holder-programs';
import { type RulesRead, type Standing, endingNow } from '@/lib/holder-rules';
import type { AuthenticityView, PromiseView } from '@/lib/trust-types';
import type { BookResponse, CrossDetail } from '@/lib/types';
import { type Market, shortAddress } from '@/lib/units';
import { useWallet } from '@/lib/wallet';
import { BookChart } from './book-chart';
import { CommentsTab } from './comments-tab';
import { Readiness, ShareAsBlink } from './holder-readiness';
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
import { RulesPanel } from './rules-panel';
import { TokenFacts } from './token-facts';
import { useIndicative, useRules } from './use-rules';
import { useSigner } from './use-signer';
import { useStanding } from './use-standing';

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
  const programs = usePrograms();

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
  // The rules the cross carries, and from them the ending period: while it is open the page shows the coarse figures of /indicative, not the book's.
  const rules = useRules(initial.address, version);
  const ending = endingNow(rules?.rules ?? null, rules?.state, BigInt(cross.window.closeTs), now);
  const indicative = useIndicative(initial.address, ending.kind === 'ending' && cross.state === 'Live', version);
  const standing = useStanding(cross, rules, account?.address ?? null, version);

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
      {ending.kind === 'ending' ? (
        <p className="mt-5 rounded-[var(--radius-card)] border border-border bg-surface p-4 text-sm" data-testid="book-coarse">
          The ending period is open, so this page does not draw the exact book. The price and the balance of demand are shown to the nearest band on the Overview. The order accounts are public on chain, so this is the display rule of this app and not secrecy; the exact book appears here again once the call closes.
        </p>
      ) : (
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
      )}
    </section>
  );

  return (
    <div className="mx-auto max-w-[1200px] px-4 py-10 sm:px-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-[28px] font-semibold tracking-tight sm:text-[34px]">Cross {shortAddress(cross.address)}</h1>
        <StateBadge state={cross.state} phase={phase === 'settled' ? 'awaiting-settlement' : phase} />
        {cross.state === 'Live' ? <FollowButton kind="crosses" address={cross.address} label={`cross ${shortAddress(cross.address)}`} /> : null}
      </div>
      <p className="mt-2 text-sm text-muted">
        {cross.kind} · {cross.disclosure === 'sealed' ? 'sealed bids' : 'open book'} · base {cross.baseMint ? shortAddress(cross.baseMint) : 'minted at settlement'} · quote {shortAddress(cross.quoteMint)}
        {cross.gateMint ? ' · eligibility pass required' : ''}
        {rules?.rules ? ' · has rules (see the Rules tab)' : ''}
      </p>

      <div className="mt-8">
        <Hero cross={cross} book={book} orders={orders} phase={phase} now={now} market={m} ending={ending} indicative={indicative} />
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
                    <TimelineView cross={cross} book={book} orders={orders} phase={phase} market={m} coarse={ending.kind === 'ending'} />
                    <TokenFacts cross={cross} market={m} identity={initialIdentity} />
                  </div>
                ),
              },
              { id: 'rules', label: 'Rules', content: <RulesPanel cross={cross} read={rules} market={m} now={now} programs={programs} wallet={account?.address ?? null} standing={standing} /> },
              { id: 'book', label: 'Book', content: bookTab },
              { id: 'orders', label: 'Orders', content: <OrdersTab cross={cross} orders={orders} loaded={ordersLoaded} phase={phase} market={m} owner={account?.address ?? null} coarse={ending.kind === 'ending'} /> },
              { id: 'proof', label: 'Proof', content: <ProofTab cross={cross} proof={proof} loaded={proofLoaded} market={m} /> },
              { id: 'replay', label: 'Replay', content: <ReplayTab cross={cross} version={version} market={m} coarse={ending.kind === 'ending'} /> },
              { id: 'comments', label: 'Comments', content: <CommentsTab cross={cross.address} account={account} /> },
            ]}
          />
        </div>

        {/* What a person can do comes first on a phone, and the panels that load after the page go below it so they never push it down. */}
        <div className="order-first space-y-6 lg:order-none">
          {account ? <Connected account={account} cross={cross} phase={phase} market={m} book={book} version={version} onChanged={refresh} onMarks={setOwn} rules={rules} standing={standing} now={now} programs={programs} /> : <ConnectPrompt phase={phase} />}
          {phase === 'awaiting-settlement' && !account ? (
            <p className="rounded-[var(--radius-card)] border border-border p-5 text-sm text-muted">
              This cross is ready to settle. Anyone can settle it; connect a wallet to do so, or wait for a keeper.
            </p>
          ) : null}
          {account && cross.state === 'Live' && (phase === 'upcoming' || phase === 'open') ? <Readiness cross={cross} owner={account.address} decimals={m.quoteDecimals} /> : null}
          <SignedBand address={cross.address} market={m} version={version} initial={initialBand} />
          {cross.disclosure === 'open' && cross.state === 'Live' ? <ShareAsBlink cross={cross.address} apiUrl={HOLDER_API_URL} /> : null}
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
  rules,
  standing,
  now,
  programs,
}: {
  rules: RulesRead | null | undefined;
  standing: Standing | null;
  now: bigint;
  programs: Programs | null | 'unavailable';
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
      {phase === 'open' ? <OrderTicket cross={cross} market={market} owner={account.address} sign={sign} book={book} onPlaced={onChanged} rules={rules} standing={standing} now={now} /> : null}
      {phase === 'awaiting-settlement' ? <SettlePanel cross={cross} payer={account.address} sign={sign} onDone={onChanged} rules={rules} /> : null}
      <MyOrders cross={cross} phase={phase} market={market} owner={account.address} sign={sign} version={version} onChanged={onChanged} onMarks={onMarks} rules={rules} now={now} programs={programs} />
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
