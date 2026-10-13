'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { FollowButton } from '@/components/alerts/follow-button';
import { API_URL, type CrossSummary } from '@/lib/api';
import { type AssetRow, type StockRow, assetRows, printsOf, stockRows } from '@/lib/holder-markets';
import { cohortIndex, latestPrints, type Mark, markOf } from '@/lib/holder-value';
import { type PremiumObservation, SESSION_LABEL, EXCLUSION_LABEL, isNoMarket, percentOf } from '@/lib/premium';
import type { CrossDetail } from '@/lib/types';
import { formatAtoms, shortAddress } from '@/lib/units';

const CARD = 'rounded-[var(--radius-card)] border border-border p-5';
const utc = (secs: number) => `${new Date(secs * 1000).toISOString().replace('T', ' ').slice(0, 16)} UTC`;

async function getJson<T>(path: string): Promise<T | null> {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await fetch(`${API_URL}${path}`, { cache: 'no-store' });
      if (r.status === 429) {
        await new Promise((res) => setTimeout(res, Math.min(8, Number(r.headers.get('retry-after') ?? 2)) * 1000));
        continue;
      }
      return r.ok ? ((await r.json()) as T) : null;
    } catch {
      return null;
    }
  }
  return null;
}

type Data = { assets: AssetRow[]; marks: Map<string, Mark | null>; index: ReturnType<typeof cohortIndex>; stocks: StockRow[] | null; now: number };

async function load(): Promise<Data | null> {
  const list = await getJson<{ crosses: CrossSummary[] }>('/v1/crosses?limit=200');
  if (!list) return null;
  const now = Math.floor(Date.now() / 1000);
  const printed = list.crosses.filter((c) => c.clearing_price !== null && c.state !== 'Live' && c.state !== 'NoPrint');
  // The detail of a cross gives its decimals and price scale. Only what is shown is read: the latest print of every token, and every print
  // of a token that cleared more than once (the index needs those). Four at a time keeps the API's limiter content.
  const perMint = new Map<string, CrossSummary[]>();
  for (const c of printed) perMint.set(c.base_mint, [...(perMint.get(c.base_mint) ?? []), c]);
  const latest = latestPrints(list.crosses);
  const wanted = new Set<string>([...latest.values()].map((c) => c.address));
  for (const l of perMint.values()) if (l.length > 1) for (const c of l) wanted.add(c.address);
  const need = printed.filter((c) => wanted.has(c.address));
  const details: CrossDetail[] = [];
  for (let i = 0; i < need.length; i += 4) {
    const batch = await Promise.all(need.slice(i, i + 4).map((c) => getJson<CrossDetail>(`/v1/crosses/${c.address}`)));
    for (const d of batch) if (d) details.push(d);
  }
  const marks = new Map<string, Mark | null>(details.map((d) => [d.address, markOf(d)]));
  const premium = await getJson<{ observations: PremiumObservation[] }>('/v1/premium/latest');
  return { assets: assetRows(list.crosses, marks, now), marks, index: cohortIndex(printsOf(details)), stocks: premium ? stockRows(premium.observations) : null, now };
}

export function MarketsPage() {
  const [state, setState] = useState<{ s: 'loading' } | { s: 'error' } | { s: 'ready'; d: Data }>({ s: 'loading' });
  const [all, setAll] = useState(false);
  useEffect(() => {
    let live = true;
    void load().then((d) => live && setState(d ? { s: 'ready', d } : { s: 'error' }));
    return () => {
      live = false;
    };
  }, []);
  if (state.s === 'loading') return <p role="status" className="mt-10 text-sm text-muted">Reading every cross and its clearing price…</p>;
  if (state.s === 'error') return <p role="alert" className="mt-10 text-sm text-accent-text">The Opening Cross API could not be reached, so markets cannot be listed.</p>;
  const { assets, index, stocks, now } = state.d;
  const shown = all ? assets : assets.slice(0, 12);
  return (
    <div className="mt-10 space-y-14">
      <section aria-labelledby="assets-h">
        <h2 id="assets-h" className="text-xl font-semibold tracking-tight">
          Tokens that have cleared
        </h2>
        <p className="mt-1 max-w-2xl text-sm text-muted">
          Every token that has printed in a cross, with the price it last cleared at and when its next cross is. This is not a market price: it is the one price a cross produced, on the day shown. Between crosses a token trades only where a pool or route exists, and on devnet there is none, so the next cross is the way to trade.
        </p>
        {assets.length === 0 ? (
          <p className={`${CARD} mt-4 text-sm text-muted`} data-testid="no-assets">No cross has printed yet.</p>
        ) : (
          <>
            <div className="mt-4 overflow-x-auto" tabIndex={0} role="region" aria-label="Table of tokens that have cleared">
              <table className="w-full min-w-[360px] text-sm" data-testid="assets">
                <caption className="sr-only">Tokens that have cleared, with last price and next cross</caption>
                <thead>
                  <tr className="border-b border-border text-left text-xs text-muted">
                    <th scope="col" className="py-2 pr-4 font-normal">Token</th>
                    <th scope="col" className="py-2 pr-4 text-right font-normal">Last cross price</th>
                    <th scope="col" className="hidden py-2 pr-4 text-right font-normal sm:table-cell">Matched then</th>
                    <th scope="col" className="hidden py-2 pr-4 text-right font-normal sm:table-cell">Prints</th>
                    <th scope="col" className="py-2 font-normal">Next cross</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((a) => (
                    <tr key={a.baseMint} className="border-b border-border last:border-0 align-top">
                      <th scope="row" className="py-3 pr-4 text-left font-mono font-normal" title={a.baseMint}>
                        {shortAddress(a.baseMint)}
                      </th>
                      <td className="py-3 pr-4 text-right font-mono">
                        {a.mark ? (
                          <Link href={`/crosses/${a.lastCross}`} className="underline underline-offset-4">
                            {formatAtoms(a.mark.perToken, a.mark.quoteDecimals)}
                          </Link>
                        ) : (
                          '–'
                        )}
                        <span className="block text-xs text-muted">{utc(a.lastCloseTs).slice(0, 10)}</span>
                      </td>
                      <td className="hidden py-3 pr-4 text-right font-mono sm:table-cell">{a.mark ? formatAtoms(a.mark.matched, a.mark.baseDecimals) : '–'}</td>
                      <td className="hidden py-3 pr-4 text-right font-mono sm:table-cell">{a.prints}</td>
                      <td className="py-3">
                        {a.next ? (
                          <span className="flex flex-wrap items-center gap-2">
                            <Link href={`/crosses/${a.next.address}`} className="underline underline-offset-4">
                              {Number(a.next.open_ts) <= now ? 'Open now' : utc(Number(a.next.open_ts))}
                            </Link>
                            <FollowButton kind="crosses" address={a.next.address} label={`cross ${shortAddress(a.next.address)}`} />
                          </span>
                        ) : (
                          <span className="text-muted">None scheduled</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {assets.length > 12 ? (
              <button type="button" onClick={() => setAll(!all)} className="mt-4 min-h-11 rounded-full border border-border-strong px-4 py-2 text-sm">
                {all ? 'Show fewer' : `Show all ${assets.length} tokens`}
              </button>
            ) : null}
          </>
        )}
      </section>

      <section aria-labelledby="index-h">
        <h2 id="index-h" className="text-xl font-semibold tracking-tight">
          Cohort index
        </h2>
        <p className="mt-1 max-w-2xl text-sm text-muted">
          An index of the tokens that have cleared more than once: each token&apos;s latest clearing price over its first, in the same quote token, averaged with equal weight. A token that has printed once has no return yet and is left out.
        </p>
        {index.constituents.length < 3 ? (
          <p className={`${CARD} mt-4 text-sm text-muted`} data-testid="index-empty">
            An index needs at least three tokens that have cleared more than once in the same quote token, and {index.constituents.length === 0 ? 'none has' : `${index.constituents.length} ${index.constituents.length === 1 ? 'has' : 'have'}`} so far ({index.unpriced} printed once). Until then there is no level to show: one token&apos;s price is not an index.
          </p>
        ) : (
          <p className={`${CARD} mt-4`} data-testid="index-level">
            <span className="font-mono text-2xl">{(Number(index.levelBps ?? 0n) / 100).toFixed(2)}</span>{' '}
            <span className="text-sm text-muted">where 100 is every token at the price of its first cross, across {index.constituents.length} tokens ({index.unpriced} printed once and are left out). Built from clearing prices only.</span>
          </p>
        )}
      </section>

      <section aria-labelledby="stocks-h">
        <h2 id="stocks-h" className="text-xl font-semibold tracking-tight">
          Tokenized stocks
        </h2>
        <p className="mt-1 max-w-2xl text-sm text-muted">
          What the premium monitor sees for tokenized stocks on mainnet: how far the price of buying them through the best route is from the stock&apos;s reference price. They trade on mainnet pools, not in a cross here; weekend reopen crosses for stocks are not live. Read-only. See <Link href="/premium" className="text-accent-text underline">the premium monitor</Link> for method and history.
        </p>
        {stocks === null ? (
          <p className={`${CARD} mt-4 text-sm text-muted`}>The premium monitor could not be read just now.</p>
        ) : stocks.length === 0 ? (
          <p className={`${CARD} mt-4 text-sm text-muted`}>The premium monitor has no observations yet.</p>
        ) : stocks.every((s) => s.premiumBpsX100 === null) ? (
          <p className={`${CARD} mt-4 text-sm text-muted`} data-testid="stocks-none">
            The monitor watches {stocks.length} tickers, and none could be priced in its latest round ({[...new Set(stocks.map((s) => EXCLUSION_LABEL[s.status] ?? s.status))].join(', ')}). No premium is shown rather than a stale one.
          </p>
        ) : (
          <div className="mt-4 overflow-x-auto" tabIndex={0} role="region" aria-label="Table of tokenized stocks">
            <table className="w-full min-w-[520px] text-sm" data-testid="stocks">
              <caption className="sr-only">Tokenized stocks and their premium to the reference price</caption>
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted">
                  <th scope="col" className="py-2 pr-4 font-normal">Stock</th>
                  <th scope="col" className="py-2 pr-4 font-normal">Session</th>
                  <th scope="col" className="py-2 pr-4 text-right font-normal">Premium at $1,000</th>
                  <th scope="col" className="py-2 font-normal">Read</th>
                </tr>
              </thead>
              <tbody>
                {stocks.filter((s) => s.premiumBpsX100 !== null).map((s) => (
                  <tr key={s.ticker} className="border-b border-border last:border-0">
                    <th scope="row" className="py-2 pr-4 text-left font-medium">{s.ticker}</th>
                    <td className="py-2 pr-4">{SESSION_LABEL[s.session]}</td>
                    <td className="py-2 pr-4 text-right font-mono">{s.premiumBpsX100 === null ? '–' : isNoMarket({ status: 'ok', premiumBpsX100: s.premiumBpsX100 }) ? 'No market' : percentOf(s.premiumBpsX100)}</td>
                    <td className="py-2 text-muted">{s.status === 'ok' ? utc(s.at) : (EXCLUSION_LABEL[s.status] ?? s.status)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
