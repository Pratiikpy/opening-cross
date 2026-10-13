'use client';

import { clock } from '@/lib/holder-rules';
import { type Market, formatAtoms, formatPrice } from '@/lib/units';

/** The `rules` block of `opening-cross/fairness-proof/v2` (packages/verifier/schema/fairness-proof.v2.schema.json). */
export type ProofRules = {
  ending: { endingSecs: number; buckets: number; cancelCutoffSecs: number; randomEnd: boolean; startsAt: string | null; lastCountedBucket: number | null; extension: { minSecs: number; maxSecs: number; used: boolean; epoch: number } | null } | null;
  checks: { name: string; ok: boolean | null; detail: string }[];
  limits: string[];
  supplyCap: string | null;
  minRaiseQuote: string;
  totalSupply: string;
  minFloatBps: number;
  maxFdvX100: number;
  anchorPrice: string;
  moveBps: number;
  reserveBps: number[];
  lotteryUnit: string;
  insiders: number;
  draw: { epoch: number; seed: string | null; endBucket: number | null };
  allocation: { classQty: string[]; tickets: number; rho: number; insiderUpperBound: string; counted: string } | null;
};

export const PROOF_V2 = 'opening-cross/fairness-proof/v2';

const VERDICT = { true: 'Reproduced', false: 'Did not reproduce', null: 'Not checked' } as const;
const bps = (n: number) => `${Number((n / 100).toFixed(2))}%`;

/** What a version-2 proof adds to the recomputed result: the checks on the rules, the draw, the allocation figures, and what it cannot establish. */
export function RulesProof({ rules, market: m }: { rules: ProofRules; market: Market }) {
  const guards: string[] = [];
  if (BigInt(rules.minRaiseQuote) > 0n) guards.push(`minimum raise ${formatAtoms(BigInt(rules.minRaiseQuote), m.quoteDecimals)} quote`);
  if (rules.supplyCap !== null) guards.push(`hard cap ${formatAtoms(BigInt(rules.supplyCap), m.baseDecimals)} tokens`);
  if (rules.minFloatBps > 0) guards.push(`minimum float ${bps(rules.minFloatBps)} of ${formatAtoms(BigInt(rules.totalSupply), m.baseDecimals)} tokens`);
  if (rules.maxFdvX100 > 0) guards.push(`valuation ceiling ${Number((rules.maxFdvX100 / 100).toFixed(2))} times the amount sold`);
  if (rules.moveBps > 0 && BigInt(rules.anchorPrice) > 0n) guards.push(`price within ${bps(rules.moveBps)} of ${formatPrice(BigInt(rules.anchorPrice), m)}`);
  const e = rules.ending;
  return (
    <div className="space-y-6" data-testid="proof-rules">
      <div>
        <h3 className="text-xs text-muted">Checks on this cross’s rules</h3>
        {rules.checks.length === 0 ? (
          <p className="mt-2 text-sm text-muted">The proof ran no check beyond the clearing itself.</p>
        ) : (
          <ul className="mt-2 divide-y divide-border border-y border-border text-sm">
            {rules.checks.map((c) => (
              <li key={c.name} className="py-2.5" data-testid="proof-check" data-ok={String(c.ok)}>
                <p className="flex flex-wrap items-baseline gap-2">
                  <span className="font-medium">{c.name}</span>
                  <span className={c.ok === true ? 'text-positive' : c.ok === false ? 'text-accent-text' : 'text-muted'}>{VERDICT[String(c.ok) as keyof typeof VERDICT]}</span>
                </p>
                <p className="mt-0.5 text-xs text-muted">{c.detail}</p>
              </li>
            ))}
          </ul>
        )}
      </div>
      <dl className="grid gap-x-6 gap-y-4 text-sm sm:grid-cols-2">
        {e ? (
          <div>
            <dt className="text-xs text-muted">Ending period</dt>
            <dd className="mt-1 font-mono text-xs">
              {e.endingSecs} s in {e.buckets} windows{e.randomEnd ? ', last counted window drawn' : ''}; cancel cutoff {e.cancelCutoffSecs} s before it{e.startsAt ? `; started ${clock(e.startsAt)}` : ''}
              {e.lastCountedBucket !== null ? `; last counted window ${e.lastCountedBucket + 1}` : ''}
              {e.extension ? `; extension ${e.extension.minSecs} to ${e.extension.maxSecs} s, ${e.extension.used ? 'used' : 'not used'}` : ''}
            </dd>
          </div>
        ) : null}
        <div>
          <dt className="text-xs text-muted">Draw</dt>
          <dd className="mt-1 break-all font-mono text-xs">
            {rules.draw.seed ? `epoch ${rules.draw.epoch}, seed ${rules.draw.seed}${rules.draw.endBucket !== null ? `, window ${rules.draw.endBucket + 1} drawn` : ''}` : 'No draw recorded (none was needed, or the seed was replaced by a later draw).'}
          </dd>
        </div>
        {guards.length > 0 ? (
          <div>
            <dt className="text-xs text-muted">Print guards in the rules</dt>
            <dd className="mt-1 font-mono text-xs">{guards.join('; ')}</dd>
          </div>
        ) : null}
        {rules.reserveBps.some((x) => x > 0) || BigInt(rules.lotteryUnit) > 0n ? (
          <div>
            <dt className="text-xs text-muted">Reserved shares of the contested volume</dt>
            <dd className="mt-1 font-mono text-xs">
              class 1 {bps(rules.reserveBps[0] ?? 0)}, class 2 {bps(rules.reserveBps[1] ?? 0)}, class 3 {bps(rules.reserveBps[2] ?? 0)}
              {BigInt(rules.lotteryUnit) > 0n ? `; class 1 lottery lot ${formatAtoms(BigInt(rules.lotteryUnit), m.baseDecimals)} tokens` : ''}
            </dd>
          </div>
        ) : null}
        {rules.allocation ? (
          <div>
            <dt className="text-xs text-muted">Allocation recorded at the clear</dt>
            <dd className="mt-1 font-mono text-xs">
              class quantities {rules.allocation.classQty.map((q) => formatAtoms(BigInt(q), m.baseDecimals)).join(' / ')} tokens; {rules.allocation.tickets} lottery ticket{rules.allocation.tickets === 1 ? '' : 's'}; counted volume {formatAtoms(BigInt(rules.allocation.counted), m.baseDecimals)} tokens
              {rules.insiders > 0 ? `; insiders’ allocation at most ${formatAtoms(BigInt(rules.allocation.insiderUpperBound), m.baseDecimals)} tokens, left out of the count` : ''}
            </dd>
          </div>
        ) : null}
      </dl>
      {rules.limits.length > 0 ? (
        <div>
          <h3 className="text-xs text-muted">What this proof does not establish</h3>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-muted" data-testid="proof-limits">
            {rules.limits.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
