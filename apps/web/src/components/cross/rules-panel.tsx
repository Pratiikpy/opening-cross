'use client';

import { useEffect, useState } from 'react';
import { ReleaseNotice } from './release-notice';
import { type Programs, releaseOf } from '@/lib/holder-programs';
import { type ClassOption, type RulesRead, type Standing, classOptions, clock, describeRules, endingNow } from '@/lib/holder-rules';
import { getJson } from '@/lib/holder-standing';
import type { CrossDetail } from '@/lib/types';
import { type Market, formatDuration, shortAddress } from '@/lib/units';

type SeriesRead = { series: string; active: boolean; next: string; maxCrosses: string | null; callSecs: string; schedule: { startTs?: string; intervalSecs?: string; calendar?: string } };

/** A series is the creator of the crosses it spawns. The list of series is asked first so that a cross made by a person never provokes a 404 for a series that does not exist. */
function useSeries(creator: string): SeriesRead | null {
  const [s, setS] = useState<SeriesRead | null>(null);
  useEffect(() => {
    let live = true;
    void getJson<{ series: { address: string }[] }>('/v1/series').then(async (list) => {
      if (!list || !list.series.some((x) => x.address === creator)) return;
      const one = await getJson<SeriesRead>(`/v1/series/${creator}`);
      if (live && one && one.series) setS(one);
    });
    return () => {
      live = false;
    };
  }, [creator]);
  return s;
}

/** The Rules tab: every rule this cross carries in plain language, what the connected wallet may do under them, and the state of the draw. */
export function RulesPanel({
  cross,
  read,
  market,
  now,
  programs,
  wallet,
  standing,
}: {
  cross: CrossDetail;
  read: RulesRead | null | undefined;
  market: Market;
  now: bigint;
  programs: Programs | null | 'unavailable';
  wallet: string | null;
  standing: Standing | null;
}) {
  const series = useSeries(cross.creator);
  const head = (
    <h2 id="rules-h" className="font-mono text-xs uppercase tracking-widest text-muted">
      Rules of this cross
    </h2>
  );
  if (read === undefined) {
    return (
      <section aria-labelledby="rules-h">
        {head}
        <p role="status" className="mt-3 text-sm text-muted">
          Reading the rules from the chain…
        </p>
      </section>
    );
  }
  if (read === null) {
    return (
      <section aria-labelledby="rules-h">
        {head}
        <p role="alert" className="mt-3 text-sm text-accent-text">
          The rules could not be read just now. They are on chain; reload to try again. Until they load, treat this cross as having limits you cannot see.
        </p>
      </section>
    );
  }
  const closeTs = BigInt(cross.window.closeTs);
  if (read.rules === null) {
    const release = releaseOf(programs !== null && programs !== 'unavailable' ? programs.programs.crossCore : null);
    return (
      <section aria-labelledby="rules-h" className="space-y-4" data-testid="rules-none">
        {head}
        <p className="text-sm">
          <span className="font-medium">This cross has no rules.</span> It is a plain call auction: one clearing price, no ending period, no per-wallet limits, no allocation classes, no lockups, no declared insiders and no print guard beyond the minimum volume, imbalance and oracle band shown on the Overview tab.
        </p>
        <p className="text-sm text-muted">
          {release === 'first-release'
            ? 'It was created by the first release of the cross program, which is the one deployed on this network, and that release has no rules.'
            : release === 'extended'
              ? 'Its creator set none when the cross was created; rules cannot be added afterwards.'
              : 'Either it was created by the first release of the cross program, which has no rules, or its creator set none; rules cannot be added afterwards.'}
        </p>
        <ReleaseNotice programs={programs} program="crossCore" what="Ending periods, per-wallet limits, allocation classes, lockups, insider declarations and the extra print guards" />
      </section>
    );
  }
  const rules = read.rules;
  const sections = describeRules(rules, {
    market,
    closeTs,
    gated: cross.gateMint !== null,
    sealed: cross.disclosure === 'sealed',
    mintsAtSettlement: cross.supplyMode !== 'escrow',
    ...(read.calls ? { calls: read.calls } : {}),
    ...(read.state ? { state: read.state } : {}),
  });
  const ending = endingNow(rules, read.state, closeTs, now);
  const allOptions: ClassOption[] | null = wallet && standing && cross.state === 'Live' ? classOptions(rules, { wallet, now, market, gated: cross.gateMint !== null }, standing) : null;
  const options = allOptions && (allOptions.length > 1 || rules.neutrality.insiders.includes(wallet!)) ? allOptions : null;
  const draw = read.state?.draw;
  return (
    <section aria-labelledby="rules-h" className="space-y-7" data-testid="rules-panel">
      <div>
        {head}
        <p className="mt-3 text-sm text-muted">
          These rules were fixed by the cross’s creator in the slot it was created and cannot change. Everything below is read from the cross account on chain; the program enforces it, this page only explains it.
        </p>
      </div>
      {ending.kind === 'ending' ? (
        <p role="status" className="rounded-[var(--radius-card)] border border-accent px-4 py-3 text-sm" data-testid="ending-live">
          <span className="font-medium">The ending period is open.</span> Window {ending.bucket + 1} of {ending.buckets} ends in {formatDuration(ending.bucketEndsAt - now > 0n ? ending.bucketEndsAt - now : 0n)}.
        </p>
      ) : ending.kind === 'before' ? (
        <p className="text-sm text-muted">
          The ending period starts at {clock(ending.startsAt)}, in {formatDuration(ending.startsAt - now > 0n ? ending.startsAt - now : 0n)}.
        </p>
      ) : ending.kind === 'extension' ? (
        <p role="status" className="rounded-[var(--radius-card)] border border-accent px-4 py-3 text-sm">
          <span className="font-medium">The call was extended.</span> The cross failed a print guard once, a draw set the extra time, and the call is open again until {clock(closeTs)}. Orders placed now cannot be cancelled.
        </p>
      ) : null}
      {sections.map((s) => (
        <div key={s.id} data-testid={`rules-${s.id}`}>
          <h3 className="text-base font-semibold">{s.title}</h3>
          <ul className="mt-2 space-y-2 text-sm">
            {s.lines.map((l) => (
              <li key={l} className="max-w-3xl [overflow-wrap:anywhere]">
                {l}
              </li>
            ))}
          </ul>
        </div>
      ))}
      {series ? (
        <div data-testid="rules-series">
          <h3 className="text-base font-semibold">Recurring series</h3>
          <p className="mt-2 max-w-3xl text-sm">
            This cross was spawned by the series {shortAddress(series.series)}. {series.active ? `The series is active; the next cross in it is number ${series.next}.` : 'The series is paused, so it spawns no further cross.'}{' '}
            {series.schedule.intervalSecs ? `It repeats every ${formatDuration(BigInt(series.schedule.intervalSecs))}.` : series.schedule.calendar ? 'It follows a market calendar.' : ''} Each cross in the series is a separate cross with its own result.
          </p>
        </div>
      ) : null}
      {draw && (draw.endBucket !== null || draw.extensionPending || draw.extensionUsed || draw.pendingSlot) ? (
        <div data-testid="rules-draw">
          <h3 className="text-base font-semibold">The draw</h3>
          <ul className="mt-2 space-y-2 text-sm">
            {draw.endBucket !== null ? <li>The draw picked ending window {draw.endBucket + 1} as the last that counts. Orders in later windows were left out and are refunded in full.</li> : null}
            {draw.pendingSlot ? <li>A draw began at slot {draw.pendingSlot} and has not finished. It finishes a few seconds after it begins; anyone may send that step.</li> : null}
            {draw.extensionPending ? <li>The cross did not print and its rules allow one extension: a draw sets how long the call reopens.</li> : null}
            {draw.extensionUsed ? <li>The extension has been used. The clear after it is final.</li> : null}
          </ul>
        </div>
      ) : null}
      {options ? (
        <div data-testid="rules-wallet">
          <h3 className="text-base font-semibold">What your wallet can do here</h3>
          <p className="mt-1 text-sm text-muted">
            Connected as {shortAddress(wallet!)}. {standing?.gatePass === true ? 'It holds a pass for the cross’s gate. ' : standing?.gatePass === false ? 'It holds no pass for the cross’s gate. ' : ''}
            {rules.neutrality.insiders.includes(wallet!) ? 'It is a declared insider of this cross. ' : ''}
          </p>
          <ul className="mt-3 grid gap-3 md:grid-cols-2">
            {options.map((o) => (
              <li key={o.id} className="rounded-[var(--radius-card)] border border-border p-4 text-sm" data-testid={`class-${o.id}`} data-available={o.available}>
                <p className="font-medium">
                  {o.label} <span className={o.available ? 'text-positive' : 'text-accent-text'}>{o.available ? 'available' : 'not available'}</span>
                </p>
                <p className="mt-1 text-muted">{o.summary}</p>
                {o.why ? <p className="mt-1">{o.why}</p> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
