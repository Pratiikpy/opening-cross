'use client';

import { isAddress } from '@solana/kit';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Text } from '@/components/issue-wizard/fields';
import { Section } from '@/components/issuer/treasury-ui';
import { Failed, Loading, Plain } from '@/components/w4/ui';
import { useMint, useRead } from '@/lib/use-read';
import { shortAddress } from '@/lib/units';
import { amount, priceText } from './format';
import { KindPill, Scroll, StatusPill, TD, TH } from './parts';
import type { PoolSummary, PoolsOfPair, PoolsSummaryResponse } from './types';

/** Find a pool by its address, or by the two tokens it trades; and the pools of the latest crosses. */
export function PoolsIndex() {
  return (
    <div className="space-y-6">
      <Plain testId="pools-promise">
        After a cross prices an asset, it trades in the pools its issuer opens at that price. Every figure on these pages is read from the accounts of the pool on the network at the moment you look, and computed with the venue’s own arithmetic. Nothing is sampled, and a pool that cannot be read says why.
      </Plain>
      <ByAddress />
      <ByPair />
      <Recent />
    </div>
  );
}

function ByAddress() {
  const router = useRouter();
  const [value, setValue] = useState('');
  const ok = isAddress(value.trim());
  return (
    <Section id="by-address" title="Open a pool by its address" intro={<p>A DAMM v2 pool or a DLMM pair, on the network this site follows.</p>}>
      <form
        className="flex flex-col gap-3 sm:flex-row sm:items-end"
        onSubmit={(e) => {
          e.preventDefault();
          if (ok) router.push(`/pools/${value.trim()}`);
        }}
      >
        <div className="min-w-0 flex-1">
          <Text label="Pool address" value={value} onChange={setValue} error={value.trim() !== '' && !ok ? 'This is not a Solana address.' : undefined} />
        </div>
        <button type="submit" disabled={!ok} data-testid="open-pool" className="min-h-11 rounded-full bg-accent-fill px-6 text-sm font-medium text-on-accent disabled:opacity-50">
          Open
        </button>
      </form>
    </Section>
  );
}

function ByPair() {
  const [base, setBase] = useState('');
  const [quote, setQuote] = useState('');
  const [asked, setAsked] = useState<{ base: string; quote: string } | null>(null);
  const baseOk = isAddress(base.trim());
  const quoteOk = isAddress(quote.trim());
  const read = useRead<PoolsOfPair>(asked ? `/v1/pools?base=${asked.base}&quote=${asked.quote}` : null);
  return (
    <Section id="by-pair" title="Find the pools of a pair of tokens" intro={<p>The pools Opening Cross opens for a cross are found at fixed addresses, so the pair is enough. A pool someone else opened for the same tokens is opened by its address above.</p>}>
      <form
        className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
        onSubmit={(e) => {
          e.preventDefault();
          if (baseOk && quoteOk && base.trim() !== quote.trim()) setAsked({ base: base.trim(), quote: quote.trim() });
        }}
      >
        <Text label="Token being traded (base)" value={base} onChange={setBase} error={base.trim() !== '' && !baseOk ? 'This is not a Solana address.' : undefined} />
        <Text label="Token it is priced in (quote)" value={quote} onChange={setQuote} error={quote.trim() !== '' && !quoteOk ? 'This is not a Solana address.' : base.trim() !== '' && base.trim() === quote.trim() ? 'The two tokens must differ.' : undefined} />
        <button type="submit" disabled={!baseOk || !quoteOk || base.trim() === quote.trim()} data-testid="find-pools" className="min-h-11 rounded-full bg-accent-fill px-6 text-sm font-medium text-on-accent disabled:opacity-50">
          Find
        </button>
      </form>
      {read.phase === 'loading' ? <Loading what="the pools of this pair" /> : null}
      {read.phase === 'error' ? <Failed>The pools could not be looked up: {read.error}</Failed> : null}
      {read.phase === 'ok' && read.data.pools.length === 0 ? <Plain testId="no-pools">No pool is open for this pair at the addresses Opening Cross opens them at. {read.data.discovery}</Plain> : null}
      {read.phase === 'ok' && read.data.pools.length > 0 ? <PoolTable pools={read.data.pools} testId="pair-pools" /> : null}
    </Section>
  );
}

function Recent() {
  const read = useRead<PoolsSummaryResponse>('/v1/pools/summary');
  return (
    <Section id="recent" title="Pools of the latest crosses" intro={<p>The markets that cleared crosses opened, newest first, one row per pool.</p>}>
      {read.phase === 'loading' ? <Loading what="the latest crosses’ pools" /> : null}
      {read.phase === 'error' ? <Failed testId="recent-error">{read.status === 404 ? 'The cross index is not available on this deployment, so the latest pools cannot be listed. Open a pool by its address instead.' : `The list could not be read: ${read.error}`}</Failed> : null}
      {read.phase === 'ok' && read.data.pools.length === 0 ? <Plain testId="recent-none">None of the {read.data.pairsScanned} latest cleared crosses has a pool at the addresses Opening Cross opens them at.</Plain> : null}
      {read.phase === 'ok' && read.data.pools.length > 0 ? <PoolTable pools={read.data.pools} testId="recent-pools" /> : null}
    </Section>
  );
}

/** A table of pool summaries, one row each, linking to the pool page. */
export function PoolTable({ pools, testId }: { pools: PoolSummary[]; testId: string }) {
  return (
    <Scroll label="Pools">
      <table className="w-full text-sm" data-testid={testId}>
        <thead>
          <tr>
            <th className={TH}>Pair</th>
            <th className={TH}>Kind</th>
            <th className={TH}>Price</th>
            <th className={TH}>Value held</th>
            <th className={TH}>Sell within 1%</th>
            <th className={TH}>Status</th>
          </tr>
        </thead>
        <tbody>
          {pools.map((p) => (
            <Row key={p.pool} p={p} />
          ))}
        </tbody>
      </table>
    </Scroll>
  );
}

function Row({ p }: { p: PoolSummary }) {
  const base = useMint(p.baseMint).info;
  const quote = useMint(p.quoteMint).info;
  const bd = base?.decimals ?? 0;
  const qd = quote?.decimals ?? 0;
  const bl = base?.symbol ?? shortAddress(p.baseMint);
  const ql = quote?.symbol ?? shortAddress(p.quoteMint);
  return (
    <tr className="border-t border-border" data-testid="pool-row">
      <td className={TD}>
        <Link href={`/pools/${p.pool}`} className="font-medium underline underline-offset-4">
          {bl} / {ql}
        </Link>
      </td>
      <td className={TD}>
        <KindPill kind={p.kind} />
      </td>
      <td className={TD}>{priceText(p.quotePerBase)}</td>
      <td className={TD}>
        {base && quote ? amount(p.tvlInQuote, qd, 2) : '…'} <span className="text-muted">{ql}</span>
      </td>
      <td className={TD}>
        {base && quote ? amount(p.depthAt100bps.sellBase.maxBaseIn, bd, 2) : '…'} <span className="text-muted">{bl}</span>
      </td>
      <td className={TD}>
        <StatusPill status={p.status} />
      </td>
    </tr>
  );
}
