'use client';

import { API_URL } from '@/lib/api';
import type { CrossDetail } from '@/lib/types';
import { type Market, formatAtoms, formatPrice } from '@/lib/units';
import { explainNoPrint } from './no-print';

type Result = { printed: boolean; price: string | null; matched: string | null; rationed: 'buy' | 'sell' | null; noPrintReason: string | number | null };

/** GET /v1/crosses/:address/proof: the on-chain result next to a second implementation's recomputation. */
export type Proof = {
  schema: string;
  program: string;
  cross: string;
  state: string;
  params: { minPrice: string; tick: string; ticks: number; priceScale: string; referencePrice: string | null; minMatched: string; maxImbalanceBps: number | null; oracleGuard: boolean };
  book: { price: string; buy: string; sell: string; buyOrders: number; sellOrders: number }[];
  onchain: Result;
  recomputed: Result;
  verified: boolean;
  notes: string[];
};

// The program stores the reason as an enum index; the recomputation reports its name.
const REASON_BY_INDEX = ['NoCross', 'BelowMinimumVolume', 'ImbalanceTooHigh', 'SettlementExpired', 'OracleDivergence', 'OracleUnavailable', 'BelowMinimumRaise', 'FloatTooLow', 'FdvTooHigh', 'PriceMoved', 'Halted', 'CorporateAction', 'IssuerPaused', 'OracleDisagreement'];
const reasonName = (r: string | number | null): string | null => (typeof r === 'number' ? (REASON_BY_INDEX[r] ?? `reason ${r}`) : r);

/** The short verdict beside the order ticket. */
export function ProofLink({ address, proof }: { address: string; proof: Proof | null }) {
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
      <a className="mt-3 inline-flex min-h-6 items-center text-accent-text underline" href={`${API_URL}/v1/crosses/${address}/proof`}>
        Download the fairness proof
      </a>
      <a className="mt-1 flex min-h-6 items-center text-accent-text underline" href={`/receipt/${address}`}>
        Open the shareable receipt
      </a>
    </div>
  );
}

function Cell({ r, m }: { r: Result; m: Market }) {
  if (!r.printed) return <>No print: {explainNoPrint(reasonName(r.noPrintReason))}</>;
  return (
    <>
      {r.price !== null ? formatPrice(BigInt(r.price), m) : '—'} for {r.matched !== null ? formatAtoms(BigInt(r.matched), m.baseDecimals) : '—'} tokens{r.rationed ? `, ${r.rationed} side pro rata` : ''}
    </>
  );
}

/** The Proof tab: what was recomputed, from what, and how to get the file. */
export function ProofTab({ cross, proof, loaded, market: m }: { cross: CrossDetail; proof: Proof | null; loaded: boolean; market: Market }) {
  const head = (
    <h2 id="proof-h" className="font-mono text-xs uppercase tracking-widest text-muted">
      Fairness proof
    </h2>
  );
  if (cross.state === 'Live') {
    return (
      <section aria-labelledby="proof-h">
        {head}
        <p className="mt-3 text-sm text-muted">
          There is nothing to prove yet: the cross has not settled. Once it has, a second implementation of the clearing rule recomputes the result from the on-chain book, and this tab shows both side by side with the data it used.
        </p>
      </section>
    );
  }
  if (!proof) {
    return (
      <section aria-labelledby="proof-h">
        {head}
        <p role="status" className="mt-3 text-sm text-muted">
          {loaded ? 'The proof could not be loaded right now.' : 'Loading the proof…'}
        </p>
      </section>
    );
  }
  const p = proof.params;
  return (
    <section aria-labelledby="proof-h" className="space-y-6" data-testid="proof-tab">
      <div>
        {head}
        <p className={`mt-3 text-lg font-semibold ${proof.verified ? 'text-positive' : 'text-accent-text'}`}>{proof.verified ? 'The recomputed result matches the chain' : 'The recomputed result does not match the chain'}</p>
        {proof.notes.map((n) => (
          <p key={n} className="mt-1 text-sm text-muted">
            {n}
          </p>
        ))}
      </div>
      <dl className="grid gap-x-6 gap-y-4 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-xs text-muted">Recorded on chain</dt>
          <dd className="mt-1 font-mono">
            <Cell r={proof.onchain} m={m} />
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted">Recomputed from the book</dt>
          <dd className="mt-1 font-mono">
            <Cell r={proof.recomputed} m={m} />
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted">Rule inputs</dt>
          <dd className="mt-1 font-mono">
            {p.ticks} prices from {formatPrice(BigInt(p.minPrice), m)} in steps of {formatPrice(BigInt(p.tick), m)}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted">Print guards</dt>
          <dd className="mt-1 font-mono">
            minimum volume {formatAtoms(BigInt(p.minMatched), m.baseDecimals)} tokens
            {p.maxImbalanceBps !== null ? `; imbalance at most ${p.maxImbalanceBps / 100}%` : ''}
            {p.oracleGuard ? '; oracle guard on' : ''}
          </dd>
        </div>
      </dl>
      <div>
        <h3 className="text-xs text-muted">The book it was computed from</h3>
        <div role="region" aria-label="Book the proof was computed from" tabIndex={0} className="mt-2 overflow-x-auto">
          <table className="w-full min-w-[420px] text-left font-mono text-xs">
            <thead className="text-muted">
              <tr>
                <th scope="col" className="py-1 pr-4 font-normal">
                  Price
                </th>
                <th scope="col" className="py-1 pr-4 text-right font-normal">
                  Buy
                </th>
                <th scope="col" className="py-1 pr-4 text-right font-normal">
                  Sell
                </th>
                <th scope="col" className="py-1 text-right font-normal">
                  Orders
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {proof.book.map((l) => (
                <tr key={l.price}>
                  <td className="py-1.5 pr-4">{formatPrice(BigInt(l.price), m)}</td>
                  <td className="py-1.5 pr-4 text-right">{formatAtoms(BigInt(l.buy), m.baseDecimals)}</td>
                  <td className="py-1.5 pr-4 text-right">{formatAtoms(BigInt(l.sell), m.baseDecimals)}</td>
                  <td className="py-1.5 text-right">
                    {l.buyOrders} buy, {l.sellOrders} sell
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <p className="text-sm text-muted">
        The file lists the program, the inputs and both results, so anyone can rerun the check.{' '}
        <a className="text-accent-text underline" href={`${API_URL}/v1/crosses/${cross.address}/proof`}>
          Download the proof (JSON)
        </a>
      </p>
    </section>
  );
}
