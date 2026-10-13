'use client';

import { useState } from 'react';
import { type Draft } from '@/lib/issuer-draft';
import { type GuardNote, guardNotes, minMatchedFromRaise } from '@/lib/issuer-guards';
import { type Derived, fitGridAction } from '@/lib/issuer-wizard';
import { formatAtoms, parseAtoms } from '@/lib/units';
import { Chip, Fieldset, Num, SmallButton, Text, type ChipTone } from './fields';

const TONE: Record<GuardNote['severity'], ChipTone> = { ok: 'ok', info: 'info', warn: 'warn', block: 'block' };
const WORD: Record<GuardNote['severity'], string> = { ok: 'Set', info: 'Note', warn: 'Check', block: 'Blocked' };

function Note({ n }: { n: GuardNote }) {
  return (
    <li className="flex items-start gap-3 text-sm" data-testid={`guard-${n.id}`} data-severity={n.severity}>
      <Chip tone={TONE[n.severity]}>{WORD[n.severity]}</Chip>
      <div className="min-w-0 flex-1">
        <p className="font-medium">{n.title}</p>
        <p className="mt-0.5 text-muted">{n.text}</p>
      </div>
    </li>
  );
}

/**
 * The guards and the issuer's own rules (W8, B5, B13). Each control sits beside a plain-language statement of what the program will do
 * with it. The raise range is shown before anything is signed, and the float and value rules are turned into parameters the program
 * enforces, with the translation stated.
 */
export function GuardsPanel({ draft, set, derived, rev, errors, onFit }: { draft: Draft; set: <K extends keyof Draft>(k: K, v: Draft[K]) => void; derived: Derived; rev: number; errors: Record<string, string | undefined>; onFit: (ticks: number) => void }) {
  const [raise, setRaise] = useState('');
  const [raiseNote, setRaiseNote] = useState<string | null>(null);
  const bd = derived.baseDecimals;
  const qd = derived.quoteDecimals;
  const notes = guardNotes({ supplyMode: draft.supplyMode, baseDecimals: bd, offered: derived.offered, minMatched: derived.effectiveMinMatched, maxImbalanceBps: derived.maxImbalanceBps === 'invalid' ? null : derived.maxImbalanceBps, oracleEnabled: draft.oracle.enabled });
  const fit = fitGridAction(derived);

  const useRaise = () => {
    setRaiseNote(null);
    if (!derived.market || derived.minPrice === null) return setRaiseNote('Check both tokens and set the lowest price first.');
    const target = parseAtoms(raise, derived.market.quoteDecimals);
    if (target === null || target === 0n) return setRaiseNote(`Enter a raise above zero with at most ${derived.market.quoteDecimals} decimal places.`);
    const m = minMatchedFromRaise(target, derived.minPrice, derived.market.priceScale);
    set('minMatched', formatAtoms(m, derived.market.baseDecimals));
    setRaiseNote(`Minimum volume set to ${formatAtoms(m, derived.market.baseDecimals)} tokens: the smallest amount that raises ${raise} quote if the cross prints at your lowest price. At a higher price the same tokens raise more.`);
  };

  const eff = derived.effectiveMinMatched;
  const scale = derived.market?.priceScale ?? null;
  const rangeLow = eff !== null && derived.minPrice !== null && scale !== null && qd !== null ? (eff * derived.minPrice + scale - 1n) / scale : null;
  const rangeHigh = derived.offered !== null && derived.topPrice !== null && scale !== null ? (derived.offered * derived.topPrice) / scale : null;

  return (
    <Fieldset legend="Guards and rules" id="guards" note="Guards decide when the cross must not print. When one trips, nobody is charged, no tokens are created, and every bidder is refunded in full. They are enforced by the program, not by this page.">
      <div className="rounded-lg border border-border bg-surface p-4 text-sm" data-testid="raise-range">
        <p className="font-medium">Accepted amount</p>
        {eff !== null && bd !== null ? (
          <p className="mt-1 text-muted">
            The cross prints only if between <span className="font-mono text-ink">{formatAtoms(eff, bd)}</span> tokens and{' '}
            <span className="font-mono text-ink">{draft.supplyMode === 'mint' ? (derived.offered !== null ? formatAtoms(derived.offered, bd) : 'what you list') : 'whatever sellers deposit'}</span> tokens trade.
            {rangeLow !== null && qd !== null ? ` At least ${formatAtoms(rangeLow, qd)} quote is raised if it prints at your lowest price` : ''}
            {rangeHigh !== null && qd !== null ? `; at most ${formatAtoms(rangeHigh, qd)} quote if everything you list sells at the top of your grid.` : rangeLow !== null ? '.' : ''}
            {draft.supplyMode === 'mint' ? ' You choose the ceiling with the supply you list: the program never sells more.' : ''}
          </p>
        ) : (
          <p className="mt-1 text-muted">Check the base token and enter the guards to see the range of outcomes the program will accept.</p>
        )}
      </div>

      <div className="grid gap-4 sm:grid-cols-[1fr_auto] sm:items-end">
        <Text label="Raise target, in quote tokens (optional)" value={raise} onChange={setRaise} inputMode="decimal" hint="Turn a raise you need into a minimum volume at your lowest price." />
        <SmallButton testId="use-raise" onClick={useRaise}>
          Set minimum volume from this
        </SmallButton>
      </div>
      {raiseNote ? (
        <p className="text-xs text-muted" role="status" data-testid="raise-note">
          {raiseNote}
        </p>
      ) : null}

      <Text label="Minimum tokens traded to print (optional)" value={draft.minMatched} onChange={(v) => set('minMatched', v)} inputMode="decimal" error={errors.minMatched} />
      <Text label="Maximum imbalance, % (optional)" value={draft.maxImbalancePct} onChange={(v) => set('maxImbalancePct', v)} inputMode="decimal" error={errors.maxImbalancePct} />
      <Num key={`max-${rev}`} label="Maximum orders" value={draft.maxOrders} onChange={(v) => set('maxOrders', v)} error={errors.maxOrders} hint="The call stops accepting orders at this count." />

      <div className="rounded-lg border border-border p-4">
        <label className="flex min-h-11 items-center gap-3 text-sm">
          <input type="checkbox" checked={draft.oracle.enabled} onChange={(e) => set('oracle', { ...draft.oracle, enabled: e.target.checked })} className="size-5" />
          <span className="font-medium">Add an oracle guard (a Pyth price must agree)</span>
        </label>
        {draft.oracle.enabled ? (
          <div className="mt-3 grid gap-4 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <Text label="Pyth feed id (64 hex characters)" value={draft.oracle.feedId} onChange={(v) => set('oracle', { ...draft.oracle, feedId: v })} error={errors['oracle.feedId']} />
            </div>
            <Text label="Largest allowed difference, %" value={draft.oracle.maxDivergencePct} onChange={(v) => set('oracle', { ...draft.oracle, maxDivergencePct: v })} inputMode="decimal" error={errors['oracle.maxDivergencePct']} />
            <Num key={`stale-${rev}`} label="Oldest allowed price, seconds" value={draft.oracle.maxStalenessSecs} onChange={(v) => set('oracle', { ...draft.oracle, maxStalenessSecs: v })} error={errors['oracle.maxStalenessSecs']} />
          </div>
        ) : null}
      </div>

      <ul className="space-y-4" aria-label="What each guard does">
        {notes.map((n) => (
          <Note key={n.id} n={n} />
        ))}
      </ul>

      <div className="border-t border-border pt-4">
        <p className="font-medium">Your own limits on float and value</p>
        <p className="mt-1 text-sm text-muted">
          Float is the share of all tokens that the cross puts in buyers&apos; hands. These two limits are yours, not a protocol rule, and the program enforces both through parameters it already has. A float limit raises the minimum volume. A value ceiling caps the top of your price grid, because the cross cannot clear above it.
        </p>
        <div className="mt-4 grid gap-4 sm:grid-cols-2 sm:items-end">
          <Text label="Minimum float, % (optional)" value={draft.minFloatPct} onChange={(v) => set('minFloatPct', v)} inputMode="decimal" error={errors.minFloatPct} />
          <Text label={`Highest fully diluted value, in quote tokens (optional)`} value={draft.maxFdv} onChange={(v) => set('maxFdv', v)} inputMode="decimal" error={errors.maxFdv} />
        </div>
        {derived.floatMinMatched !== null && bd !== null ? (
          <p className="mt-3 text-sm text-muted" data-testid="float-translation">
            A float of {draft.minFloatPct}% needs at least <span className="font-mono text-ink">{formatAtoms(derived.floatMinMatched, bd)}</span> tokens to trade, so the program is told that minimum
            {derived.typedMinMatched !== null && derived.typedMinMatched > derived.floatMinMatched ? ' (your own larger minimum stays)' : ''}.
          </p>
        ) : null}
        {fit ? (
          <div className="mt-3">
            <SmallButton testId="fit-grid" onClick={() => onFit(fit.ticks)}>
              Shorten the grid to {fit.ticks} levels to fit the ceiling
            </SmallButton>
          </div>
        ) : null}
      </div>
    </Fieldset>
  );
}
