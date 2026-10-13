import Link from 'next/link';
import { Suspense } from 'react';
import { CrossingChart } from '@/components/crossing-chart';
import { ExampleTag } from '@/components/example-tag';
import { MeasuredSoFar } from '@/components/metrics/measured-so-far';
import { MetricsSkeleton } from '@/components/metrics/metric-card';
import { type CrossSummary, type Stats, get } from '@/lib/api';

export const revalidate = 15;

export default async function Home() {
  const [stats, live] = await Promise.all([get<Stats>('/v1/stats'), get<{ crosses: CrossSummary[] }>('/v1/crosses?state=Live&limit=50')]);
  // "Live" on chain only means not yet settled; a cross is open to orders only inside its window.
  const now = BigInt(Math.floor(Date.now() / 1000));
  const liveCross = live.ok ? live.data.crosses.find((c) => BigInt(c.open_ts) <= now && now < BigInt(c.close_ts)) : undefined;

  return (
    <>
      {/* Hero */}
      <section className="mx-auto grid max-w-[1200px] gap-12 px-4 pb-16 pt-14 sm:px-6 md:grid-cols-[1.1fr_1fr] md:pt-20">
        <div className="flex flex-col justify-center">
          {liveCross ? (
            <Link href={`/crosses/${liveCross.address}`} className="mb-6 inline-flex w-fit items-center gap-2 rounded-full border border-border px-3 py-1 text-xs text-muted transition-colors hover:border-border-strong hover:text-ink">
              <span className="size-1.5 rounded-full bg-accent" aria-hidden="true" /> A cross is open now: view it
            </Link>
          ) : null}
          <h1 className="text-[44px] font-semibold leading-[1.02] tracking-tight sm:text-[64px]">
            One price for everyone.
            <br />
            <span className="text-subtle">Watch it form.</span>
          </h1>
          <p className="mt-6 max-w-md text-[17px] leading-relaxed text-muted">
            Orders collect while the cross is open. When it closes, one price is found where demand meets supply, and every filled
            order pays that price. Order size buys you quantity, not a better price.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <a href="#how" className="rounded-full bg-accent-fill px-5 py-3 text-sm font-medium text-on-accent transition-opacity hover:opacity-90">
              See how a cross works
            </a>
            <a href="#proof" className="rounded-full border border-border-strong px-5 py-3 text-sm font-medium transition-colors hover:bg-surface">
              Check a result yourself
            </a>
          </div>
          <ul className="mt-8 flex flex-wrap gap-x-6 gap-y-2 text-sm text-muted">
            <li>Orders held in on-chain escrow</li>
            <li>Unfilled money refunded at settlement</li>
            <li>Every result recomputable</li>
          </ul>
        </div>
        <div className="rounded-[var(--radius-card)] border border-border bg-bg p-5 shadow-[0_1px_2px_rgba(0,0,0,0.04),0_8px_32px_rgba(0,0,0,0.06)]">
          <div className="mb-4 flex items-center justify-between">
            <p className="text-sm font-medium">How the price forms</p>
            <ExampleTag>Illustration</ExampleTag>
          </div>
          <CrossingChart />
          <p className="mt-4 text-sm text-muted">
            Demand falls as price rises; supply rises with it. The cross prints where the most can trade, and everyone on the filled side
            pays that one price.
          </p>
        </div>
      </section>

      {/* Live totals */}
      <section aria-labelledby="totals" className="border-y border-border bg-surface">
        <div className="mx-auto max-w-[1200px] px-4 py-12 sm:px-6">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 id="totals" className="text-sm text-muted">
              Opening crosses so far
            </h2>
            {stats.ok ? (
              <p className="font-mono text-xs text-muted">
                Live from the indexer · network: <span className="text-ink">{stats.data.network}</span>
              </p>
            ) : null}
          </div>
          {stats.ok ? (
            <dl className="mt-6 grid grid-cols-2 gap-8 md:grid-cols-4">
              <Stat label="crosses that printed one price" value={stats.data.crosses_printed} />
              <Stat label="buyers filled at the clearing price" value={stats.data.buyers_filled} />
              <Stat label="crosses opened in total" value={stats.data.crosses_total} />
              <Stat label="crosses that did not print and refunded everyone" value={stats.data.crosses_no_print} />
            </dl>
          ) : (
            <p role="status" className="mt-6 text-sm text-muted">
              Live totals are unavailable right now: {stats.error} Nothing is shown in their place.
            </p>
          )}
        </div>
      </section>

      {/* Measured so far: execution quality, fairness and external flow, computed by the API from indexed crosses */}
      <section aria-labelledby="measured" className="border-b border-border">
        <div className="mx-auto max-w-[1200px] px-4 py-12 sm:px-6">
          <Suspense fallback={<MetricsSkeleton />}>
            <MeasuredSoFar />
          </Suspense>
        </div>
      </section>

      {/* How it works */}
      <section id="how" className="mx-auto max-w-[1200px] scroll-mt-20 px-4 py-24 sm:px-6">
        <p className="font-mono text-xs uppercase tracking-widest text-accent-text">The opening cross</p>
        <h2 className="mt-4 max-w-2xl text-[34px] font-semibold leading-tight tracking-tight sm:text-[44px]">
          Everything that happens on the first day, <span className="text-subtle">made fair and visible.</span>
        </h2>
        <div className="mt-12 grid gap-4 md:grid-cols-3">
          <Card title="One price, found in public">
            Orders arrive at the most each buyer would pay and the least each seller would take. At the close, the price that trades the
            most volume is chosen; ties go to the smaller imbalance, then to the reference price.
          </Card>
          <Card title="Fair allocation">
            When demand is larger than supply at the clearing price, every order at that exact price is filled in proportion to its size.
            Orders priced better than the clearing price fill in full.
          </Card>
          <Card title="Refunds that send themselves">
            Unused money is returned when the cross settles. If the cross does not print, everyone is refunded in full. Anyone can trigger
            settlement; funds only ever go back to their owner.
          </Card>
          <Card title="Sealed when it matters">
            Launches can take sealed bids: only a commitment is on chain until the reveal window, so nobody can see a price and jump ahead
            of it.
          </Card>
          <Card title="A receipt for every cross">
            The book, the clearing price and every fill are public. A second, independent implementation recomputes them and publishes a
            fairness proof.
          </Card>
          <Card title="Markets open at the price">
            After a launch, the market can open on Meteora (DBC, DAMM v2 or DLMM) or Raydium at the clearing price, so the first trade starts
            where the cross ended.
          </Card>
        </div>
      </section>

      {/* Proof */}
      <section id="proof" className="scroll-mt-16 bg-inverse-bg text-inverse-ink">
        <div className="mx-auto grid max-w-[1200px] gap-12 px-4 py-24 sm:px-6 md:grid-cols-2">
          <div>
            <p className="font-mono text-xs uppercase tracking-widest text-accent">Built to be checked</p>
            <h2 className="mt-4 text-[34px] font-semibold leading-tight tracking-tight sm:text-[44px]">
              Every result can be checked. <span className="text-inverse-muted">Every cross is public.</span>
            </h2>
            <dl className="mt-10 divide-y divide-white/10 border-y border-white/10 text-sm">
              <ProofRow title="Escrow">Every order sits in a program-owned vault until the cross settles.</ProofRow>
              <ProofRow title="Recompute">
                <code className="font-mono">pnpm --filter @opening-cross/verifier verify &lt;cross&gt;</code> rebuilds the result from chain data alone. See Developers.
              </ProofRow>
              <ProofRow title="Conformance">525 conformance test vectors in the repository; the program and an independent implementation agree on every one the program can represent (523 of 525).</ProofRow>
              <ProofRow title="Audit">No external audit yet. One is required before mainnet, and its findings will be published in full.</ProofRow>
            </dl>
            <p className="mt-6 flex flex-wrap gap-x-6 gap-y-2 text-sm">
              <Link href="/accuracy" className="underline decoration-accent underline-offset-4 hover:text-inverse-muted">Track record of signed price bands</Link>
              <Link href="/premium" className="underline decoration-accent underline-offset-4 hover:text-inverse-muted">Premium monitor</Link>
              <Link href="/status" className="underline decoration-accent underline-offset-4 hover:text-inverse-muted">Live status</Link>
            </p>
          </div>
          <div className="self-center overflow-hidden rounded-[var(--radius-card)] border border-white/10 bg-white/5">
            <div className="flex items-center justify-between border-b border-white/10 px-4 py-3 font-mono text-xs text-inverse-muted">
              <span>Fairness proof for any cross</span>
              <span>REST · illustrative values</span>
            </div>
            <pre tabIndex={0} aria-label="Example fairness proof request and response" className="overflow-x-auto p-4 font-mono text-[13px] leading-6">
              <code>{`curl ${'$'}API/v1/crosses/<address>/proof

{
  "schema": "opening-cross/fairness-proof/v1",
  "state": "Finalized",
  "onchain":    { "price": "…", "matched": "…" },
  "recomputed": { "price": "…", "matched": "…" },
  "verified": true
}`}</code>
            </pre>
          </div>
        </div>
      </section>

      {/* Issuers */}
      <section id="issuers" className="mx-auto grid max-w-[1200px] scroll-mt-20 gap-12 px-4 py-24 sm:px-6 md:grid-cols-2">
        <div className="flex flex-col justify-center">
          <p className="font-mono text-xs uppercase tracking-widest text-accent-text">For issuers</p>
          <h2 className="mt-4 text-[34px] font-semibold leading-tight tracking-tight sm:text-[44px]">
            Open at a price set by demand, <span className="text-subtle">not by insiders.</span>
          </h2>
          <p className="mt-6 max-w-md text-muted">
            Launch a token, a revenue share or a reopen with a cross. Set the price grid and the guards, gate it to verified wallets if you
            need to, and choose where the market opens afterwards.
          </p>
        </div>
        <div className="rounded-[var(--radius-card)] border border-border p-5">
          <div className="mb-4 flex items-center justify-between">
            <p className="text-sm font-medium">Demand by price</p>
            <ExampleTag>Example</ExampleTag>
          </div>
          <DemandBars />
        </div>
      </section>

      {/* Developers */}
      <section id="developers" className="border-t border-border bg-surface">
        <div className="mx-auto grid max-w-[1200px] gap-8 px-4 py-20 sm:px-6 md:grid-cols-3">
          <div>
            <h2 className="text-2xl font-semibold tracking-tight">Build on the protocol</h2>
            <p className="mt-3 text-sm text-muted">Everything the app does is available to any wallet, venue or program.</p>
          </div>
          <DevItem title="TypeScript SDK" code="@opening-cross/sdk">Instruction builders for every step of a cross, on @solana/kit.</DevItem>
          <DevItem title="Rust CPI crate" code="opening-cross-cpi">Route your users&apos; orders into a cross from your own program.</DevItem>
          <DevItem title="REST and WebSocket API" code="/v1/stream">Reads checked against chain, unsigned transactions, live events.</DevItem>
          <DevItem title="Verifier" code="@opening-cross/verifier">Recompute any cross and get a fairness proof.</DevItem>
          <DevItem title="Router" code="@opening-cross/router">Compare a cross with a live DEX route before you place an order.</DevItem>
        </div>
      </section>
    </>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="border-t-2 border-ink pt-3">
      <dd className="text-[34px] font-semibold tracking-tight">{value.toLocaleString('en-US')}</dd>
      <dt className="mt-1 text-sm text-muted">{label}</dt>
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-[var(--radius-card)] border border-border bg-surface p-6">
      <h3 className="font-medium">{title}</h3>
      <p className="mt-2 text-sm leading-relaxed text-muted">{children}</p>
    </div>
  );
}

function ProofRow({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="py-4">
      <dt className="font-medium">{title}</dt>
      <dd className="mt-1 text-inverse-muted">{children}</dd>
    </div>
  );
}

function DevItem({ title, code, children }: { title: string; code: string; children: React.ReactNode }) {
  return (
    <div className="rounded-[var(--radius-card)] border border-border bg-bg p-5">
      <h3 className="font-medium">{title}</h3>
      <p className="mt-1 font-mono text-xs text-accent-text">{code}</p>
      <p className="mt-3 text-sm text-muted">{children}</p>
    </div>
  );
}

function DemandBars() {
  // Illustrative demand curve, clearly tagged "Example" above; no issuer or figure is real.
  const rows = [
    ['1.60', 18],
    ['1.50', 34],
    ['1.40', 52],
    ['1.35', 71],
    ['1.30', 86],
    ['1.20', 100],
  ] as const;
  return (
    <ul className="space-y-2 font-mono text-xs">
      {rows.map(([price, pct]) => (
        <li key={price} className="grid grid-cols-[3rem_1fr] items-center gap-3">
          <span className="text-muted">{price}</span>
          <span className="h-3 rounded-sm bg-surface-2">
            <span className={`block h-3 rounded-sm ${price === '1.35' ? 'bg-accent' : 'bg-ink'}`} style={{ width: `${pct}%` }} />
          </span>
        </li>
      ))}
      <li className="pt-2 text-muted">Clearing price where demand meets the shares offered: 1.35</li>
    </ul>
  );
}
