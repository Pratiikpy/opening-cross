'use client';

import { useMemo, useState } from 'react';
import { type FeeSchedule } from '@/lib/issuer-data';
import { type Printed, type Scenario, type SimInput, bidderFill, ladder, scenarios } from '@/lib/issuer-sim';
import { type Draft } from '@/lib/issuer-draft';
import { type Derived, type Row, parseRows, simInputFrom } from '@/lib/issuer-wizard';
import { formatAtoms, formatPrice } from '@/lib/units';
import { SmallButton, Text } from './fields';

const pct = (bps: bigint) => `${(Number(bps) / 100).toFixed(2).replace(/\.00$/, '')}%`;
const REASON: Record<string, string> = {
  NoCross: 'No price exists where anyone trades: no bid reaches your lowest offered price.',
  BelowMinimumVolume: 'The cross would not print: fewer tokens would trade than your minimum volume. Everyone is refunded.',
  ImbalanceTooHigh: 'The cross would not print: the gap between demand and supply is larger than your maximum imbalance allows. Everyone is refunded.',
};

export function RowsEditor({ title, hint, rows, setRows, errors, priceLabel, qtyLabel, testId }: { title: string; hint: string; rows: Row[]; setRows: (r: Row[]) => void; errors: Record<number, string>; priceLabel: string; qtyLabel: string; testId: string }) {
  return (
    <div data-testid={testId}>
      <p className="text-sm font-medium">{title}</p>
      <p className="text-xs text-muted">{hint}</p>
      <div className="mt-3 space-y-3">
        {rows.map((r, i) => (
          <div key={i} className="grid grid-cols-[1fr_1fr_auto] items-end gap-3">
            <Text label={`${priceLabel} ${i + 1}`} value={r.price} onChange={(v) => setRows(rows.map((x, j) => (j === i ? { ...x, price: v } : x)))} inputMode="decimal" error={errors[i]} />
            <Text label={`${qtyLabel} ${i + 1}`} value={r.quantity} onChange={(v) => setRows(rows.map((x, j) => (j === i ? { ...x, quantity: v } : x)))} inputMode="decimal" />
            <button type="button" className="mb-1 min-h-11 min-w-11 px-1 text-sm text-muted underline" onClick={() => setRows(rows.filter((_, j) => j !== i))} aria-label={`Remove ${priceLabel.toLowerCase()} ${i + 1}`}>
              Remove
            </button>
          </div>
        ))}
      </div>
      <div className="mt-2">
        <SmallButton onClick={() => setRows([...rows, { price: '', quantity: '' }])}>Add a row</SmallButton>
      </div>
    </div>
  );
}

function ScenarioCard({ s, d, input }: { s: Scenario; d: { base: number; quote: number }; input: SimInput }) {
  const r = s.result;
  const q = (a: bigint) => formatAtoms(a, d.quote);
  const t = (a: bigint) => formatAtoms(a, d.base);
  return (
    <div className="rounded-lg border border-border bg-surface p-4 text-sm" data-testid={`scenario-${s.id}`} data-printed={r.printed}>
      <p className="font-medium">{s.label}</p>
      {r.printed ? (
        <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
          <dt className="text-muted">Clears at</dt>
          <dd className="text-right font-mono">{formatPrice(r.price, input.grid)} quote</dd>
          <dt className="text-muted">Tokens sold</dt>
          <dd className="text-right font-mono">{t(r.matched)}</dd>
          <dt className="text-muted">Raise</dt>
          <dd className="text-right font-mono">{q(r.raise)} quote</dd>
          <dt className="text-muted">Fees you pay</dt>
          <dd className="text-right font-mono">{q(r.fees)} quote</dd>
          <dt className="text-muted">You keep</dt>
          <dd className="text-right font-mono">{q(r.net)} quote</dd>
          <dt className="text-muted">Float</dt>
          <dd className="text-right font-mono">{pct(r.floatBps)}</dd>
          <dt className="text-muted">Value at this price</dt>
          <dd className="text-right font-mono">{q(r.fdv)} quote</dd>
          <dt className="text-muted">Left unsold</dt>
          <dd className="text-right font-mono">{t(r.unsold)}</dd>
          <dt className="text-muted">Demand over supply</dt>
          <dd className="text-right font-mono">{pct(r.demandOverSupplyBps)}</dd>
        </dl>
      ) : (
        <div className="mt-3 text-muted">
          <p data-testid="not-printed">{REASON[r.reason]}</p>
          {r.wouldClearAt ? (
            <p className="mt-2 text-xs">
              Without the guard it would have cleared at {formatPrice(r.wouldClearAt.price, input.grid)} quote for {t(r.wouldClearAt.matched)} tokens.
            </p>
          ) : null}
        </div>
      )}
    </div>
  );
}

function Ladder({ input, printed }: { input: SimInput; printed: Printed | null }) {
  const rows = ladder(input, printed ? printed.price : null);
  if (rows.length === 0) return null;
  const max = rows.reduce((m, r) => (r.demand > m ? r.demand : r.supply > m ? r.supply : m), 1n);
  const w = (v: bigint) => `${Math.max(2, Number((v * 1000n) / max) / 10)}%`;
  return (
    <div data-testid="ladder" className="mt-6">
      <p className="font-mono text-[11px] uppercase tracking-wider text-muted">Demand and supply by price</p>
      <p className="mt-1 text-xs text-muted">At each price: the tokens wanted at or above it (orange) and the tokens offered at or below it (grey). The cross clears at the price that trades the most.</p>
      <div className="mt-3 grid gap-2">
        {rows.map((r) => (
          <div key={r.index} className="grid grid-cols-[56px_minmax(0,1fr)_72px] items-center gap-3 text-[13px] tabular-nums">
            <span className={`font-mono ${r.clearing ? 'font-semibold text-accent-text' : 'text-muted'}`}>{formatPrice(r.price, input.grid)}</span>
            <span className="grid gap-1" aria-hidden="true">
              <span className="block h-2.5 overflow-hidden rounded bg-surface-2">
                <span className="block h-2.5 rounded bg-accent" style={{ width: w(r.demand) }} />
              </span>
              <span className="block h-2.5 overflow-hidden rounded bg-surface-2">
                <span className="block h-2.5 rounded bg-border-strong" style={{ width: w(r.supply) }} />
              </span>
            </span>
            <span className="text-right text-xs text-muted">
              {formatAtoms(r.demand, input.grid.baseDecimals, 0)} / {formatAtoms(r.supply, input.grid.baseDecimals, 0)}
              <span className="sr-only">{` tokens wanted / offered${r.clearing ? ', clearing price' : ''}`}</span>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * The simulator (A8): the clearing rule, the guards and the fees run on the issuer's supply and a demand the issuer supplies.
 * Controlled by the wizard: the demand rows, and the escrow supply rows, live in its state so they are saved with the draft.
 */
export function SimulatorPanel({
  draft,
  derived,
  fees,
  demandRows,
  setDemandRows,
  escrowRows,
  setEscrowRows,
  sources,
}: {
  draft: Draft;
  derived: Derived;
  fees: FeeSchedule | null;
  demandRows: Row[];
  setDemandRows: (r: Row[]) => void;
  escrowRows: Row[];
  setEscrowRows: (r: Row[]) => void;
  sources?: React.ReactNode;
}) {
  const [limit, setLimit] = useState('');
  const demand = useMemo(() => parseRows(demandRows, derived.market), [demandRows, derived.market]);
  const supply = useMemo(() => parseRows(escrowRows, derived.market), [escrowRows, derived.market]);
  const input = useMemo(() => (fees ? simInputFrom(draft, derived, demand.steps, supply.steps, fees) : null), [draft, derived, demand.steps, supply.steps, fees]);
  const result = useMemo(() => (input && demand.steps.length > 0 ? scenarios(input) : null), [input, demand.steps.length]);
  const decimals = derived.market ? { base: derived.market.baseDecimals, quote: derived.market.quoteDecimals } : null;
  const base = result?.find((s) => s.id === 'base')?.result;
  const printed = base && base.printed ? base : null;

  // What a bidder with a given limit gets in the base scenario.
  const bidder = useMemo(() => {
    if (!input || !printed || !derived.market) return null;
    const qty = 1_000n * 10n ** BigInt(derived.market.baseDecimals);
    const at = (p: bigint) => ({ price: p, fill: bidderFill(input, p, qty).fill });
    const rows = [input.grid.tick ? at(printed.price + input.grid.tick) : null, at(printed.price), printed.price > input.grid.minPrice ? at(printed.price - input.grid.tick) : null].filter(Boolean) as { price: bigint; fill: bigint }[];
    return rows;
  }, [input, printed, derived.market]);

  return (
    <section id="simulator" aria-labelledby="sim-h" className="scroll-mt-24 rounded-[var(--radius-card)] border border-border p-5" data-testid="simulator">
      <div className="flex flex-wrap items-center gap-3">
        <h2 id="sim-h" className="font-medium">
          Simulator
        </h2>
        <span className="rounded-full border border-border-strong px-2 py-0.5 font-mono text-[11px] uppercase tracking-wider text-muted">Model estimate</span>
      </div>
      <p className="mt-2 text-sm text-muted">
        Runs the same clearing rule, print guards and fees as the program on your supply and on a demand you enter. It does not know how much demand will arrive: the three columns show half, once and twice the demand you enter, as scenarios and not as a forecast.
      </p>
      {!derived.market ? (
        <p role="status" className="mt-4 text-sm text-muted" data-testid="sim-wait">
          Check both tokens above so prices and amounts can be read exactly.
        </p>
      ) : (
        <div className="mt-5 space-y-6">
          {draft.supplyMode === 'escrow' ? (
            <RowsEditor testId="sim-supply" title="Tokens you would sell" hint="In an escrow cross, sellers deposit tokens and name the lowest price they accept. Enter what you would sell, as price and tokens." rows={escrowRows} setRows={setEscrowRows} errors={supply.errors} priceLabel="Lowest price" qtyLabel="Tokens offered" />
          ) : (
            <p className="text-sm text-muted">
              Supply: your schedule above ({derived.steps.length} {derived.steps.length === 1 ? 'step' : 'steps'}, {derived.offered !== null && decimals ? formatAtoms(derived.offered, decimals.base) : '0'} tokens).
            </p>
          )}
          <RowsEditor testId="sim-demand" title="Demand" hint="Bids as a limit price and a number of tokens. Enter what you think buyers would bid, or load real interest below." rows={demandRows} setRows={setDemandRows} errors={demand.errors} priceLabel="Limit price" qtyLabel="Tokens wanted" />
          {sources}
          {!input ? (
            <p role="status" className="text-sm text-muted">
              The simulator waits for a valid price grid and valid guards. The fields that need attention are marked above.
            </p>
          ) : !result ? (
            <p role="status" className="text-sm text-muted" data-testid="sim-empty">
              Add at least one demand row to see what the cross would do.
            </p>
          ) : (
            <>
              <div className="grid gap-3 lg:grid-cols-3">
                {result.map((s) => (
                  <ScenarioCard key={s.id} s={s} d={decimals!} input={input} />
                ))}
              </div>
              <Ladder input={input} printed={printed} />
              {bidder ? (
                <div data-testid="bidder-outcome">
                  <p className="font-mono text-[11px] uppercase tracking-wider text-muted">What one more bid of 1,000 tokens would get (base scenario)</p>
                  <ul className="mt-2 space-y-1 text-sm">
                    {bidder.map((b) => (
                      <li key={String(b.price)}>
                        A limit of <span className="font-mono">{formatPrice(b.price, input.grid)}</span>:{' '}
                        {b.fill === 0n ? 'priced out, refunded in full' : b.fill === 1_000n * 10n ** BigInt(decimals!.base) ? 'filled completely, paying the clearing price' : `filled ${formatAtoms(b.fill, decimals!.base)} of 1,000, the rest refunded`}.
                      </li>
                    ))}
                  </ul>
                  <div className="mt-3 max-w-xs">
                    <Text label="Try another limit price" value={limit} onChange={setLimit} inputMode="decimal" />
                  </div>
                  {limit.trim() !== '' && derived.market ? <TryLimit limit={limit} input={input} /> : null}
                </div>
              ) : null}
            </>
          )}
          <p className="text-xs text-muted">
            Method: the clearing rule of ADR-0003 over integers, then the minimum-volume and maximum-imbalance guards (OCIP-1 section 7.7), then fees as cross_core takes them from the sell side (section 7.6). The oracle guard is not simulated: its verdict depends on a price update that does not exist yet. Fees are within a few atoms of the program&apos;s, which rounds per order.
            {fees ? ` Protocol fee schedule: ${fees.source === 'chain' ? 'read from the chain' : 'the schedule proposed in ADR-0010 (the live one could not be read)'}.` : ''}
          </p>
        </div>
      )}
    </section>
  );
}

function TryLimit({ limit, input }: { limit: string; input: SimInput }) {
  const p = (() => {
    const per = limit.trim();
    const m = /^(\d+)(?:\.(\d*))?$/.exec(per);
    if (!m) return null;
    const frac = m[2] ?? '';
    if (frac.length > input.grid.quoteDecimals) return null;
    const perToken = BigInt(m[1]!) * 10n ** BigInt(input.grid.quoteDecimals) + BigInt(frac.padEnd(input.grid.quoteDecimals, '0') || '0');
    const num = perToken * input.grid.priceScale;
    const den = 10n ** BigInt(input.grid.baseDecimals);
    return num % den === 0n ? num / den : null;
  })();
  if (p === null) return <p className="mt-2 text-xs text-accent-text">That is not a price with at most {input.grid.quoteDecimals} decimal places.</p>;
  if (p < input.grid.minPrice || (p - input.grid.minPrice) % input.grid.tick !== 0n || (p - input.grid.minPrice) / input.grid.tick >= BigInt(input.grid.ticks)) return <p className="mt-2 text-xs text-accent-text">That price is not on your grid.</p>;
  const qty = 1_000n * 10n ** BigInt(input.grid.baseDecimals);
  const { fill } = bidderFill(input, p, qty);
  return (
    <p className="mt-2 text-sm" data-testid="try-limit">
      A limit of {limit}: {fill === 0n ? 'priced out, refunded in full' : fill === qty ? 'filled completely' : `filled ${formatAtoms(fill, input.grid.baseDecimals)} of 1,000`}.
    </p>
  );
}
