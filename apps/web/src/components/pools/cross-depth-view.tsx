'use client';

import { isAddress } from '@solana/kit';
import Link from 'next/link';
import { useState } from 'react';
import { Text } from '@/components/issue-wizard/fields';
import { Section } from '@/components/issuer/treasury-ui';
import { Failed, Loading, Plain, when } from '@/components/w4/ui';
import { useMint, useRead } from '@/lib/use-read';
import { formatPrice, parseAtoms, shortAddress } from '@/lib/units';
import { amount, bpsText, depthSteps, movedText } from './format';
import { Pill } from '@/components/issuer/treasury-ui';
import { Scroll, TD, TH } from './parts';
import type { CrossDepthResponse } from './types';

/** A cross’s own depth: the resting book, the price impact of orders of set sizes, and the pools’ slippage for the same sizes beside it. */
export function CrossDepthView({ cross }: { cross: string }) {
  const valid = isAddress(cross);
  const [sizesText, setSizesText] = useState('');
  const [sizes, setSizes] = useState<string | null>(null);
  const read = useRead<CrossDepthResponse>(valid ? `/v1/depth/cross/${cross}${sizes ? `?sizes=${sizes}` : ''}` : null);
  const base = useMint(read.phase === 'ok' ? read.data.market.baseMint : null).info;
  if (!valid) return <Failed testId="bad-address">“{cross}” is not a Solana address.</Failed>;
  if (read.phase === 'idle' || read.phase === 'loading') return <Loading what="the cross’s book from chain" />;
  if (read.phase === 'error') return <Failed testId="depth-error">{read.status === 404 ? 'There is no Opening Cross account at this address.' : `The depth could not be read: ${read.error}`}</Failed>;
  const d = read.data;
  const bd = d.market.baseDecimals;
  const qd = d.market.quoteDecimals;
  const market = { priceScale: BigInt(d.priceScale), baseDecimals: bd, quoteDecimals: qd };
  const price = (p: string | null) => (p === null ? 'no price' : formatPrice(BigInt(p), market));
  const symbol = base?.symbol ?? (d.market.baseMint ? shortAddress(d.market.baseMint) : 'base');
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const parts = sizesText.split(',').map((s) => s.trim()).filter(Boolean);
    const atoms = parts.map((p) => parseAtoms(p, bd));
    if (parts.length === 0) return setSizes(null);
    if (atoms.some((a) => a === null || a === 0n) || parts.length > 12) return;
    setSizes(atoms.map(String).join(','));
  };
  const badSizes = sizesText.trim() !== '' && (sizesText.split(',').some((p) => p.trim() === '' || parseAtoms(p, bd) === null || parseAtoms(p, bd) === 0n) || sizesText.split(',').length > 12);
  return (
    <div className="space-y-6" data-testid="cross-depth" data-visible={d.bookVisible}>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Pill tone="info">{d.state}</Pill>
        <Pill tone="info">{d.disclosure === 'sealed' ? 'Sealed book' : 'Open book'}</Pill>
        <span className="text-muted">
          Call period {when(d.openTs)} to {when(d.closeTs)}. Fees on this cross: {bpsText(d.feeBps)}.
        </span>
      </div>

      {!d.bookVisible ? (
        <Plain testId="hidden">
          {d.hiddenBecause}.{d.settled ? (d.settled.price !== null ? ` It cleared at ${price(d.settled.price)} with ${amount(d.settled.matched, bd, 4)} ${symbol} matched.` : ' It did not print a price.') : ''}
        </Plain>
      ) : (
        <>
          <Section id="book" title="Resting book" intro={<p>Each price with orders on it, and the running totals a depth chart shows: everything bid at or above a price, and everything offered at or below it. The cross would clear {d.baseline?.prints ? `at ${price(d.baseline.price)} with ${amount(d.baseline.matched, bd, 4)} ${symbol} matched` : 'nowhere yet: the book does not cross'} if the call closed now.</p>}>
            {d.levels && d.levels.length > 0 ? (
              <>
                <DepthChart levels={d.levels} clearing={d.baseline?.price ?? null} market={market} />
                <details className="rounded-lg border border-border">
                  <summary className="cursor-pointer px-3 py-2 text-sm font-medium">Every price with orders</summary>
                  <Scroll label="Resting orders by price">
                    <table className="w-full text-sm" data-testid="levels-table">
                      <thead>
                        <tr>
                          <th className={TH}>Price</th>
                          <th className={TH}>Bids</th>
                          <th className={TH}>Offers</th>
                          <th className={TH}>Bid at or above</th>
                          <th className={TH}>Offered at or below</th>
                        </tr>
                      </thead>
                      <tbody>
                        {d.levels.map((l) => (
                          <tr key={l.price} className="border-t border-border">
                            <td className={TD}>{price(l.price)}</td>
                            <td className={TD}>{BigInt(l.buyQuantity) === 0n ? '—' : `${amount(l.buyQuantity, bd, 4)} (${l.buyOrders})`}</td>
                            <td className={TD}>{BigInt(l.sellQuantity) === 0n ? '—' : `${amount(l.sellQuantity, bd, 4)} (${l.sellOrders})`}</td>
                            <td className={TD}>{amount(l.cumulativeBuy, bd, 4)}</td>
                            <td className={TD}>{amount(l.cumulativeSell, bd, 4)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </Scroll>
                </details>
              </>
            ) : (
              <Plain testId="empty-book">The book is empty: no order rests on this cross yet.</Plain>
            )}
          </Section>

          <Section id="impact" title="What an order of a given size does to the price" intro={<p>The clearing rule is run on the live book with and without a market order of the size. Positive means the order moves the price against itself. Sizes are in {symbol}.</p>}>
            <form onSubmit={submit} className="flex flex-col gap-3 sm:flex-row sm:items-end">
              <div className="min-w-0 flex-1">
                <Text label={`Sizes in ${symbol}, comma separated (up to 12)`} value={sizesText} onChange={setSizesText} mono={false} error={badSizes ? `Use whole ${symbol} amounts with at most ${bd} decimals, for example 10, 50, 250.` : undefined} />
              </div>
              <button type="submit" disabled={badSizes} data-testid="sizes-apply" className="min-h-11 rounded-full border border-border-strong px-6 text-sm font-medium disabled:opacity-50">
                Price these sizes
              </button>
            </form>
            {d.impact.length === 0 ? (
              <Plain testId="no-impact">The book is empty, so there is nothing to size an order against. Enter sizes above to see what they would do to an empty book.</Plain>
            ) : (
              <Scroll label="Price impact by order size">
                <table className="w-full text-sm" data-testid="impact-table">
                  <thead>
                    <tr>
                      <th className={TH}>Order</th>
                      <th className={TH}>Size</th>
                      <th className={TH}>Cross would clear at</th>
                      <th className={TH}>Order’s fill</th>
                      <th className={TH}>Moves the price</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.impact.map((r) => (
                      <tr key={`${r.side}-${r.size}`} className="border-t border-border" data-side={r.side}>
                        <td className={TD}>{r.side === 'buy' ? 'Buy' : 'Sell'}</td>
                        <td className={TD}>{amount(r.size, bd, 4)} {symbol}</td>
                        <td className={TD}>{r.prints ? price(r.price) : 'does not clear'}</td>
                        <td className={TD}>{r.prints ? amount(r.fill, bd, 4) : '—'}</td>
                        <td className={TD}>{movedText(r.impactBps)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Scroll>
            )}
          </Section>
        </>
      )}

      <Section id="pools" title="The same sizes in the pools" intro={<p>What a trade of each size costs in the pools of this pair, against each pool’s mid price, fee included. It is a different quantity from the cross’s price impact, shown beside it rather than merged with it.</p>}>
        {d.pools.length === 0 ? <Plain testId="no-pools">{d.poolNote ?? 'No pool was found for this pair.'}</Plain> : null}
        {d.pools.map((p) => (
          <div key={p.pool} className="space-y-2" data-testid="pool-comparison">
            <h3 className="text-sm font-medium">
              <Link href={`/pools/${p.pool}`} className="underline underline-offset-4">
                {p.kind === 'dlmm' ? 'DLMM pair' : 'DAMM v2 pool'} {shortAddress(p.pool)}
              </Link>
            </h3>
            {!p.status.open ? <p className="text-sm text-muted">{p.status.reason ?? 'The pool is closed.'}</p> : null}
            {p.rows.length === 0 ? (
              <p className="text-sm text-muted">There are no sizes to price: the book is empty and none were given.</p>
            ) : (
              <Scroll label="Pool slippage by order size">
                <table className="w-full text-sm">
                  <thead>
                    <tr>
                      <th className={TH}>Order</th>
                      <th className={TH}>Size</th>
                      <th className={TH}>Price</th>
                      <th className={TH}>Worse than mid by</th>
                    </tr>
                  </thead>
                  <tbody>
                    {p.rows.map((r) => (
                      <tr key={`${r.side}-${r.size}`} className="border-t border-border">
                        <td className={TD}>{r.side === 'buy' ? 'Buy' : 'Sell'}</td>
                        <td className={TD}>{amount(r.size, bd, 4)} {symbol}</td>
                        {'unavailable' in r ? (
                          <td className={`${TD} text-muted`} colSpan={2}>{r.unavailable}</td>
                        ) : (
                          <>
                            <td className={TD}>{amount(r.pricePerBase, qd, 6)}{r.partial ? ' (partial fill)' : ''}</td>
                            <td className={TD}>{bpsText(r.slippageBps)}</td>
                          </>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Scroll>
            )}
          </div>
        ))}
      </Section>
      <ul className="list-disc space-y-1 pl-5 text-sm text-muted">
        {d.notes.map((n) => (
          <li key={n}>{n}</li>
        ))}
      </ul>
    </div>
  );
}

const W = 640;
const H = 240;

function DepthChart({ levels, clearing, market }: { levels: NonNullable<CrossDepthResponse['levels']>; clearing: string | null; market: { priceScale: bigint; baseDecimals: number; quoteDecimals: number } }) {
  const steps = depthSteps(levels.map((l) => ({ price: BigInt(l.price), cumulativeBuy: BigInt(l.cumulativeBuy), cumulativeSell: BigInt(l.cumulativeSell) })));
  const pad = 28;
  const x = (v: number) => pad + v * (W - 2 * pad);
  const y = (v: number) => H - 30 - v * (H - 60);
  const line = (key: 'buy' | 'sell') => steps.map((s, i) => `${i === 0 ? 'M' : 'L'}${x(s.x)} ${y(s[key])}`).join(' ');
  const lo = BigInt(levels[0]!.price);
  const hi = BigInt(levels.at(-1)!.price);
  const clearX = clearing !== null && hi > lo ? x(Number(((BigInt(clearing) - lo) * 10_000n) / (hi - lo)) / 10_000) : null;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={`Depth of the book from ${formatPrice(lo, market)} to ${formatPrice(hi, market)}: bids accumulate from the highest price down, offers from the lowest up${clearing ? `; it would clear at ${formatPrice(BigInt(clearing), market)}` : ''}.`} data-testid="depth-chart">
      <line x1={pad} x2={W - pad} y1={H - 30} y2={H - 30} stroke="var(--border)" />
      <path d={line('buy')} fill="none" stroke="var(--positive)" strokeWidth="2.5" />
      <path d={line('sell')} fill="none" stroke="var(--ink)" strokeWidth="2.5" />
      {clearX !== null ? <line x1={clearX} x2={clearX} y1={16} y2={H - 30} stroke="var(--accent)" strokeWidth="1.5" strokeDasharray="4 3" /> : null}
      {clearX !== null ? <text x={clearX + 6} y={26} className="fill-[var(--accent-text)] font-mono text-[11px]">clears here</text> : null}
      <text x={pad} y={H - 10} className="fill-[var(--muted)] font-mono text-[11px]">{formatPrice(lo, market)}</text>
      <text x={W - pad} y={H - 10} textAnchor="end" className="fill-[var(--muted)] font-mono text-[11px]">{formatPrice(hi, market)}</text>
      <text x={pad + 4} y={y(1) - 6} className="fill-[var(--positive)] font-mono text-[11px]">bids</text>
      <text x={W - pad} y={y(1) - 6} textAnchor="end" className="fill-[var(--ink)] font-mono text-[11px]">offers</text>
    </svg>
  );
}
