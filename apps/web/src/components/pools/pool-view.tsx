'use client';

import { isAddress } from '@solana/kit';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { Section } from '@/components/issuer/treasury-ui';
import { Failed, Loading, Plain } from '@/components/w4/ui';
import { useMint, useRead } from '@/lib/use-read';
import { shortAddress } from '@/lib/units';
import { LadderChart } from './ladder-chart';
import { amount, bpsText, feePercent, priceText, shareText } from './format';
import { Address, KindPill, Scroll, StatusPill, TD, TH, Tile } from './parts';
import { TradePanel } from './pool-trade';
import type { FeeInfo, PoolHealth } from './types';

const REFRESH_MS = 15_000;

/** One pool: what it holds, what it costs to trade in it, how deep it is, and a trade panel. Read from chain by the API each time. */
export function PoolView({ address }: { address: string }) {
  const valid = isAddress(address);
  const [swapped, setSwapped] = useState(false);
  const [tokenB, setTokenB] = useState<string | null>(null);
  const path = valid ? `/v1/pools/${address}${swapped && tokenB ? `?base=${tokenB}` : ''}` : null;
  const read = useRead<PoolHealth>(path);
  // Token B is only known after the first read in the pool's own orientation; it is what "show it the other way" asks the API for.
  useEffect(() => {
    if (read.phase === 'ok' && !swapped) setTokenB(read.data.quote.mint);
  }, [read, swapped]);
  const reloadRef = useRef(read.reload);
  reloadRef.current = read.reload;
  useEffect(() => {
    const t = setInterval(() => reloadRef.current(), REFRESH_MS);
    return () => clearInterval(t);
  }, []);

  if (!valid) return <Failed testId="bad-address">“{address}” is not a Solana address.</Failed>;
  if (read.phase === 'idle' || read.phase === 'loading') return <Loading what="the pool from chain" />;
  if (read.phase === 'error') {
    return (
      <Failed testId="pool-error">
        {read.status === 404 ? 'There is no account at this address on the network the API follows.' : read.status === 422 ? 'This account is not a Meteora DAMM v2 pool or DLMM pair.' : `The pool could not be read: ${read.error}`}
      </Failed>
    );
  }
  return <Loaded h={read.data} swapped={swapped} onFlip={() => setSwapped((s) => !s)} reload={read.reload} />;
}

function Loaded({ h, swapped, onFlip, reload }: { h: PoolHealth; swapped: boolean; onFlip: () => void; reload: () => void }) {
  const baseMint = useMint(h.base.mint).info;
  const quoteMint = useMint(h.quote.mint).info;
  const baseLabel = baseMint?.symbol ?? shortAddress(h.base.mint);
  const quoteLabel = quoteMint?.symbol ?? shortAddress(h.quote.mint);
  const d100 = h.depth.find((r) => r.maxSlippageBps === '100');
  return (
    <div className="space-y-6" data-testid="pool-view" data-kind={h.kind} data-open={h.status.open}>
      <div className="flex flex-wrap items-center gap-2">
        <KindPill kind={h.kind} />
        <StatusPill status={h.status} />
        <button type="button" onClick={onFlip} data-testid="flip" className="min-h-9 rounded-full border border-border px-3 text-xs text-muted hover:text-ink">
          {swapped ? `Price in ${baseLabel} instead` : `Price in ${quoteLabel} instead`}
        </button>
        <span className="text-xs text-muted">Read from chain {new Date(Number(h.chain.unixTimestamp) * 1000).toISOString().slice(11, 19)} UTC · refreshes every 15 s</span>
      </div>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
        <div className="min-w-0 space-y-6">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Tile label="Price" value={`${priceText(h.price.quotePerBase)}`} note={`${quoteLabel} per ${baseLabel}`} testId="tile-price" />
            <Tile label="Value held" value={amount(h.liquidity.tvlInQuote, h.quote.decimals, 2)} note={`${quoteLabel}, at the pool’s price`} testId="tile-tvl" />
            <Tile label="Fee" value={feeHeadline(h.fee)} note={feeNote(h.fee)} testId="tile-fee" />
            <Tile label="Depth within 1%" value={d100 ? `${amount(d100.sellBase.maxBaseIn, h.base.decimals, 2)} ${baseLabel}` : 'not read'} note={d100 ? `to sell; ${amount(d100.buyBase.maxQuoteIn, h.quote.decimals, 2)} ${quoteLabel} to buy` : undefined} testId="tile-depth" />
          </div>

          <Section id="holdings" title="What the pool holds" intro={<p>The reserves that trades are priced from. {h.liquidity.counted === 'the whole price range of the pool' ? 'The pool quotes across its whole price range.' : `Only ${h.liquidity.counted} were read; liquidity in bins outside them is not counted.`}</p>}>
            <dl className="grid gap-x-8 gap-y-2 text-sm sm:grid-cols-2">
              <Holding label={baseLabel} mint={h.base.mint} reserve={amount(h.liquidity.baseReserve, h.base.decimals)} fee={h.base.transferFee} network={h.network} />
              <Holding label={quoteLabel} mint={h.quote.mint} reserve={amount(h.liquidity.quoteReserve, h.quote.decimals)} fee={h.quote.transferFee} network={h.network} />
            </dl>
          </Section>

          <Section id="depth" title="How much can be traded within a price limit" intro={<p>The largest single trade that costs no more than the limit against the pool’s mid price, fee included. Nothing is sampled: each row is the pool’s own arithmetic run on its accounts.</p>}>
            <Scroll label="Depth by price limit">
              <table className="w-full text-sm" data-testid="depth-table">
                <thead>
                  <tr>
                    <th className={TH}>Limit</th>
                    <th className={TH}>Sell up to</th>
                    <th className={TH}>Receiving</th>
                    <th className={TH}>Buy with up to</th>
                    <th className={TH}>Receiving</th>
                  </tr>
                </thead>
                <tbody>
                  {h.depth.map((r) => (
                    <tr key={r.maxSlippageBps} className="border-t border-border" data-limit={r.maxSlippageBps}>
                      <td className={TD}>{bpsText(r.maxSlippageBps)}</td>
                      <Cell atoms={r.sellBase.maxBaseIn} decimals={h.base.decimals} unit={baseLabel} />
                      <Cell atoms={r.sellBase.quoteOut} decimals={h.quote.decimals} unit={quoteLabel} />
                      <Cell atoms={r.buyBase.maxQuoteIn} decimals={h.quote.decimals} unit={quoteLabel} />
                      <Cell atoms={r.buyBase.baseOut} decimals={h.base.decimals} unit={baseLabel} />
                    </tr>
                  ))}
                </tbody>
              </table>
            </Scroll>
            <p className="text-xs text-muted">A dash means no trade, however small, stays within that limit: the pool’s fee alone is above it.</p>
          </Section>

          <Section id="impact" title="What a trade of a given size costs" intro={<p>Sizes are shares of what the pool holds of the token being sold. Slippage is the shortfall against the mid price, fee included.</p>}>
            <div className="grid gap-6">
              <ImpactTable title={`Sell ${baseLabel}`} rows={h.impact.sellBase} inDecimals={h.base.decimals} outDecimals={h.quote.decimals} inUnit={baseLabel} outUnit={quoteLabel} testId="impact-sell" />
              <ImpactTable title={`Buy ${baseLabel}`} rows={h.impact.buyBase} inDecimals={h.quote.decimals} outDecimals={h.base.decimals} inUnit={quoteLabel} outUnit={baseLabel} testId="impact-buy" />
            </div>
          </Section>

          {h.ladder ? (
            <Section id="ladder" title="Bins" intro={<p>A DLMM pair keeps its liquidity in price bins of {h.fee.kind === 'dlmm' ? bpsText(h.fee.binStepBps) : ''} each. A trade spends the active bin and walks into the next. The conviction ladder of an issuer shows here as a run of offers above the clearing price.</p>}>
              <LadderChart
                bins={h.ladder}
                xDecimals={h.baseIsA ? h.base.decimals : h.quote.decimals}
                yDecimals={h.baseIsA ? h.quote.decimals : h.base.decimals}
                xMint={h.baseIsA ? h.base.mint : h.quote.mint}
                yMint={h.baseIsA ? h.quote.mint : h.base.mint}
                baseIsX={h.baseIsA}
              />
            </Section>
          ) : null}

          <Section id="persistence" title="Does the depth last?" intro={<p>The share of the time this API has watched the pool in which it could absorb a trade of a fixed size within 1%.</p>}>
            {'sellBaseShare' in h.persistence ? (
              <p className="text-sm" data-testid="persistence">
                Over {Math.round(h.persistence.observedSeconds / 60)} minutes and {h.persistence.samples} reads: it could take a sell of one percent of its holdings {shareText(h.persistence.sellBaseShare)} of the time, and a buy of the same size {shareText(h.persistence.buyBaseShare)} of the time. <span className="text-muted">{h.persistence.window}.</span>
              </p>
            ) : (
              <Plain testId="persistence">{h.persistence.window}. {h.persistence.samples} read{h.persistence.samples === 1 ? '' : 's'} so far.</Plain>
            )}
          </Section>

          <Section id="how" title="How this was read" intro={<p>Every figure above comes from these accounts, read from the network at the time shown. Nothing is estimated.</p>}>
            <ul className="space-y-1 text-sm">
              {h.sources.map((s, i) => (
                <li key={s}>
                  <span className="text-muted">{i === 0 ? 'The pool: ' : 'Bin array: '}</span>
                  <Address value={s} network={h.network} short />
                </li>
              ))}
            </ul>
            <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-muted" data-testid="caveats">
              {h.caveats.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
            <p className="mt-3 text-sm">
              Looking for the market of a cross? See its <Link href="/crosses" className="underline underline-offset-4">crosses</Link> and the issuer’s <Link href="/pools" className="underline underline-offset-4">pool finder</Link>.
            </p>
          </Section>
        </div>
        <aside className="min-w-0">
          <TradePanel health={h} baseLabel={baseLabel} quoteLabel={quoteLabel} onTraded={reload} />
        </aside>
      </div>
    </div>
  );
}

function feeHeadline(f: FeeInfo): string {
  return f.kind === 'dlmm' ? feePercent(f.baseFeeBps) : feePercent(f.cliffFeeBps);
}
function feeNote(f: FeeInfo): string {
  return f.kind === 'dlmm' ? `${f.collects}; ${f.variableFee.startsWith('yes') ? 'plus a fee that rises with volatility' : 'no variable fee'}` : `${f.collects}${f.dynamicFee ? '; plus a dynamic fee' : ''}`;
}

function Holding({ label, mint, reserve, fee, network }: { label: string; mint: string; reserve: string; fee: { bps: number; maxFee: string } | null; network: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-muted">{label}</dt>
      <dd className="font-medium tabular-nums">{reserve}</dd>
      <dd className="text-xs text-muted">
        <Address value={mint} network={network} short />
        {fee ? ` · transfer fee ${bpsText(fee.bps)}` : ''}
      </dd>
    </div>
  );
}

function Cell({ atoms, decimals, unit }: { atoms: string; decimals: number; unit: string }) {
  if (BigInt(atoms) === 0n) return <td className={`${TD} text-muted`}>—</td>;
  return (
    <td className={TD} title={`${atoms} atoms`}>
      {amount(atoms, decimals, 4)} <span className="text-muted">{unit}</span>
    </td>
  );
}

function ImpactTable({ title, rows, inDecimals, outDecimals, inUnit, outUnit, testId }: { title: string; rows: PoolHealth['impact']['sellBase']; inDecimals: number; outDecimals: number; inUnit: string; outUnit: string; testId: string }) {
  return (
    <div className="min-w-0" data-testid={testId}>
      <h3 className="mb-1 text-sm font-medium">{title}</h3>
      {rows.length === 0 ? (
        <p className="text-sm text-muted">The pool holds none of the token this trade would sell into it.</p>
      ) : (
        <Scroll label={title}>
          <table className="w-full text-sm">
            <thead>
              <tr>
                <th className={TH}>Share</th>
                <th className={TH}>Trade</th>
                <th className={TH}>Receives</th>
                <th className={TH}>Slippage</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.percentOfReserve} className="border-t border-border">
                  <td className={TD}>{r.percentOfReserve}%</td>
                  <td className={TD} title={`${r.amountIn} atoms`}>
                    {amount(r.amountIn, inDecimals, 4)} <span className="text-muted">{inUnit}</span>
                  </td>
                  <td className={TD} title={`${r.out} atoms`}>
                    {amount(r.out, outDecimals, 4)} <span className="text-muted">{outUnit}</span>
                  </td>
                  <td className={TD}>{r.partial ? 'cannot fill' : bpsText(r.slippageBps)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Scroll>
      )}
    </div>
  );
}
