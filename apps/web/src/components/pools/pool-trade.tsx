'use client';

import { useEffect, useState } from 'react';
import { WalletAction } from '@/components/issuer/issuer-action';
import { Failed, Loading } from '@/components/w4/ui';
import { useRead } from '@/lib/use-read';
import { readHeld } from '@/lib/series-load';
import { parseAtoms, shortAddress } from '@/lib/units';
import { useWallet } from '@/lib/wallet';
import { TOLERANCES, amount, bpsText, explorerAddress, minimumOutOf, priceText } from './format';
import { Scroll, TD, TH } from './parts';
import type { PoolHealth, PoolVenueRow, RouteQuote, SwapBuilt } from './types';

const VENUE_LABEL: Record<string, string> = { cross: 'Next cross', jupiter: 'Jupiter', 'meteora-dlmm': 'DLMM pair', 'meteora-damm-v2': 'DAMM v2 pool' };

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/**
 * Buy or sell the base token of this pool. The order is priced against the pool, the next cross and Jupiter in one request (GET /v1/pools/route), the venues are
 * shown ranked, and the swap goes to this pool: built by the API, simulated on the cluster, signed by the connected wallet. A better venue is said, not hidden.
 */
export function TradePanel({ health, baseLabel, quoteLabel, onTraded }: { health: PoolHealth; baseLabel: string; quoteLabel: string; onTraded: () => void }) {
  const { account } = useWallet();
  const wallet = account?.address ?? null;
  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [text, setText] = useState('');
  const [tolerance, setTolerance] = useState<number>(50);
  const [landed, setLanded] = useState<{ signatures: string[]; built: SwapBuilt | null } | null>(null);
  const debounced = useDebounced(text, 400);
  const baseAtoms = parseAtoms(debounced, health.base.decimals);
  const typed = parseAtoms(text, health.base.decimals);
  const askable = baseAtoms !== null && baseAtoms > 0n;
  const path = askable ? `/v1/pools/route?base=${health.base.mint}&quote=${health.quote.mint}&side=${side}&amount=${baseAtoms}&pool=${health.pool}` : null;
  const route = useRead<RouteQuote>(path);

  const row: PoolVenueRow | null = route.phase === 'ok' ? (route.data.venues.find((v) => v.pool === health.pool) ?? null) : null;
  const whyNot = route.phase === 'ok' && !row ? (route.data.excluded.find((e) => e.pool === health.pool)?.reason ?? 'The pool gave no price for this order.') : null;
  const inputMint = row?.route?.inputMint ?? null;
  const inputToken = inputMint === health.base.mint ? health.base : health.quote;
  const [held, setHeld] = useState<bigint | null>(null);
  useEffect(() => {
    setHeld(null);
    if (!wallet || !inputMint) return;
    let live = true;
    void readHeld(wallet, inputMint, inputToken.tokenProgram).then((r) => live && setHeld(r.ok ? r.amount : null));
    return () => {
      live = false;
    };
  }, [wallet, inputMint, inputToken.tokenProgram, landed]);

  const amountIn = row?.route ? BigInt(row.route.amountIn) : null;
  const expectedOut = row?.route ? BigInt(row.route.expectedOut) : null;
  const minOut = expectedOut === null ? null : minimumOutOf(expectedOut, tolerance);
  const outToken = inputMint === health.base.mint ? health.quote : health.base;
  const outLabel = outToken.mint === health.base.mint ? baseLabel : quoteLabel;
  const inLabel = inputMint === health.base.mint ? baseLabel : quoteLabel;
  const short = held !== null && amountIn !== null && held < amountIn;
  const better = route.phase === 'ok' && row && route.data.best && route.data.best.pool !== health.pool ? route.data.venues[0] : null;
  const pending = text.trim() !== '' && (typed === null || typed === 0n) ? 'Enter an amount with at most ' + health.base.decimals + ' decimals.' : null;

  const disabledReason = !health.status.open
    ? (health.status.reason ?? 'The pool is closed.')
    : !health.swapTx.supported
      ? (health.swapTx.reason ?? 'This swap cannot be built here.')
      : !row?.route
        ? 'Enter an amount to get a price.'
        : short
          ? `This wallet holds ${amount(held, inputToken.decimals)} ${inLabel}; the swap sells ${amount(amountIn, inputToken.decimals)}.`
          : undefined;

  return (
    <section aria-labelledby="trade-h" className="space-y-4 rounded-[var(--radius-card)] border border-border p-5 lg:sticky lg:top-24" data-testid="trade-panel">
      <div>
        <h2 id="trade-h" className="text-lg font-semibold tracking-tight">
          Trade {baseLabel}
        </h2>
        <p className="mt-1 text-sm text-muted">Priced against this pool, the next cross and Jupiter; the swap goes to this pool.</p>
      </div>
      <div role="group" aria-label="Side" className="grid grid-cols-2 gap-1 rounded-full border border-border p-1">
        {(['buy', 'sell'] as const).map((s) => (
          <button
            key={s}
            type="button"
            aria-pressed={side === s}
            data-testid={`side-${s}`}
            onClick={() => {
              setSide(s);
              setLanded(null);
            }}
            className={`min-h-10 rounded-full px-4 text-sm font-medium transition-colors ${side === s ? 'bg-ink text-bg' : 'text-muted hover:text-ink'}`}
          >
            {s === 'buy' ? 'Buy' : 'Sell'}
          </button>
        ))}
      </div>
      <div>
        <label htmlFor="trade-amount" className="text-sm font-medium">
          {side === 'buy' ? `${baseLabel} to receive` : `${baseLabel} to sell`}
        </label>
        <input
          id="trade-amount"
          data-testid="trade-amount"
          inputMode="decimal"
          autoComplete="off"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setLanded(null);
          }}
          placeholder="0.0"
          aria-invalid={pending !== null}
          aria-describedby="trade-amount-hint"
          className="mt-1 min-h-11 w-full rounded-lg border border-border-strong bg-transparent px-3 text-base tabular-nums"
        />
        <p id="trade-amount-hint" className="mt-1 text-xs text-muted" data-testid="trade-amount-hint">
          {pending ?? `Whole ${baseLabel}; up to ${health.base.decimals} decimals.`}
        </p>
      </div>
      <div>
        <p className="text-sm font-medium" id="tol-h">
          Slippage tolerance
        </p>
        <div role="group" aria-labelledby="tol-h" className="mt-1 flex flex-wrap gap-2">
          {TOLERANCES.map((t) => (
            <button
              key={t}
              type="button"
              aria-pressed={tolerance === t}
              data-testid={`tolerance-${t}`}
              onClick={() => setTolerance(t)}
              className={`min-h-10 rounded-full border px-3 text-sm ${tolerance === t ? 'border-ink bg-ink text-bg' : 'border-border text-muted hover:text-ink'}`}
            >
              {bpsText(t)}
            </button>
          ))}
        </div>
        <p className="mt-1 text-xs text-muted">The swap fails on chain rather than fill below this.</p>
      </div>

      {route.phase === 'loading' ? <Loading what="the pool, the next cross and Jupiter" /> : null}
      {route.phase === 'error' ? <Failed testId="route-error">{route.error}</Failed> : null}
      {whyNot ? (
        <p role="status" className="rounded-lg border border-border p-3 text-sm text-muted" data-testid="route-pool-excluded">
          {whyNot}
        </p>
      ) : null}
      {row?.route && amountIn !== null && expectedOut !== null && minOut !== null ? (
        <div className="space-y-3" data-testid="route-quote">
          <dl className="space-y-1.5 text-sm">
            <Line k={side === 'buy' ? 'You pay' : 'You sell'} v={`${amount(amountIn, inputToken.decimals)} ${inLabel}`} testId="quote-in" />
            <Line k="You receive about" v={`${amount(expectedOut, outToken.decimals)} ${outLabel}`} testId="quote-out" />
            <Line k={`At least (${bpsText(tolerance)} tolerance)`} v={`${amount(minOut, outToken.decimals)} ${outLabel}`} testId="quote-min" />
            <Line k="Price" v={`${amount(row.pricePerBase, health.quote.decimals)} ${quoteLabel} per ${baseLabel}`} testId="quote-price" />
            <Line k="Worse than the pool’s mid price by" v={bpsText(row.slippageVsPoolMidBps ?? '0')} testId="quote-slippage" />
          </dl>
          {row.fill === 'partial' ? (
            <p role="alert" className="rounded-lg border border-accent p-3 text-sm" data-testid="quote-partial">
              The pool can give {amount(row.baseAtoms, health.base.decimals)} {baseLabel} of the amount asked for within a 10% price move, not all of it.
            </p>
          ) : null}
          {better ? (
            <p role="status" className="rounded-lg border border-border-strong p-3 text-sm" data-testid="quote-better">
              <span className="font-medium">{VENUE_LABEL[better.venue] ?? better.venue} prices this order better</span>: {amount(better.pricePerBase, health.quote.decimals)} {quoteLabel} per {baseLabel}.{' '}
              {better.venue === 'cross' ? 'A cross price is indicative and settles after its call closes.' : null}
            </p>
          ) : null}
          <WalletAction
            account={account}
            label={side === 'buy' ? `Buy ${baseLabel}` : `Sell ${baseLabel}`}
            testId="swap"
            path="/v1/pools/swap-tx"
            body={() => ({ pool: health.pool, owner: wallet, inputMint: row.route!.inputMint, amountIn: row.route!.amountIn, maxSlippageBps: tolerance })}
            disabled={disabledReason !== undefined}
            disabledReason={disabledReason}
            connectHint="Connect a wallet to swap."
            onBuilt={(extra) => setLanded({ signatures: [], built: extra as unknown as SwapBuilt })}
            onDone={(signatures, extra) => {
              setLanded({ signatures, built: extra as unknown as SwapBuilt });
              onTraded();
            }}
          />
          {wallet && held !== null ? (
            <p className="text-xs text-muted" data-testid="held">
              You hold {amount(held, inputToken.decimals)} {inLabel}.
            </p>
          ) : null}
        </div>
      ) : null}
      {landed && landed.signatures.length > 0 ? (
        <p role="status" className="rounded-lg border border-positive p-3 text-sm text-positive" data-testid="swap-confirmed">
          Swap confirmed on chain:{' '}
          <a className="font-mono underline underline-offset-4" href={`https://explorer.solana.com/tx/${landed.signatures[0]}${health.network === 'mainnet-beta' ? '' : `?cluster=${health.network}`}`} target="_blank" rel="noreferrer">
            {shortAddress(landed.signatures[0]!)}
          </a>
          . {landed.built ? `Sold ${amount(landed.built.swap.amountIn, inputToken.decimals)} ${inLabel}; at least ${amount(landed.built.swap.minimumAmountOut, outToken.decimals)} ${outLabel} was guaranteed.` : ''}
        </p>
      ) : null}

      {route.phase === 'ok' && route.data.venues.length > 0 ? (
        <div className="space-y-2" data-testid="venues">
          <h3 className="text-sm font-medium">Every venue, ranked for this order</h3>
          <Scroll label="Venues ranked for this order">
            <table className="w-full text-sm">
              <thead>
                <tr>
                  <th className={TH}>#</th>
                  <th className={TH}>Venue</th>
                  <th className={TH}>Price</th>
                  <th className={TH}>Fill</th>
                  <th className={TH}>Now?</th>
                </tr>
              </thead>
              <tbody>
                {route.data.venues.map((v) => (
                  <tr key={`${v.venue}:${v.pool ?? v.cross ?? ''}`} className={`border-t border-border ${v.pool === health.pool ? 'bg-surface font-medium' : ''}`} data-testid={`venue-${v.venue}`} data-this-pool={v.pool === health.pool}>
                    <td className={TD}>{v.rank}</td>
                    <td className={TD}>
                      {VENUE_LABEL[v.venue] ?? v.venue}
                      {v.pool === health.pool ? ' (this pool)' : v.pool ? ` ${shortAddress(v.pool)}` : v.cross ? ` ${shortAddress(v.cross)}` : ''}
                    </td>
                    <td className={TD}>{priceText(amount(v.pricePerBase, health.quote.decimals, 9))}</td>
                    <td className={TD}>{v.fill}</td>
                    <td className={TD}>{v.executableNow ? 'yes' : 'indicative'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Scroll>
          {route.data.excluded.filter((e) => e.venue !== 'meteora-dlmm' && e.venue !== 'meteora-damm-v2').length > 0 ? (
            <ul className="space-y-1 text-xs text-muted">
              {route.data.excluded
                .filter((e) => e.venue !== 'meteora-dlmm' && e.venue !== 'meteora-damm-v2')
                .map((e, i) => (
                  <li key={i}>
                    {VENUE_LABEL[e.venue] ?? e.venue}: {e.reason}
                  </li>
                ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      <p className="text-xs text-muted">
        Pool <a className="font-mono underline underline-offset-4" href={explorerAddress(health.pool, health.network)} target="_blank" rel="noreferrer">{shortAddress(health.pool)}</a>. The quote is the pool as it is now; a trade ahead of yours moves it.
      </p>
    </section>
  );
}

function Line({ k, v, testId }: { k: string; v: string; testId: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-muted">{k}</dt>
      <dd className="text-right font-medium tabular-nums" data-testid={testId}>
        {v}
      </dd>
    </div>
  );
}

