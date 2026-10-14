'use client';

import { isAddress } from '@solana/kit';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { Select, SmallButton, Text } from '@/components/issue-wizard/fields';
import { SeriesDetail } from '@/components/series/series-detail';
import { readMintFull } from '@/lib/issuer-chain';
import type { MintRead } from '@/lib/issuer-readiness';
import { EMPTY_SERIES_FORM, type SeriesForm, buildSeries, seriesSummary } from '@/lib/series';
import { type SeriesListRow } from '@/lib/series';
import { loadSeriesList } from '@/lib/series-load';
import { shortAddress } from '@/lib/units';
import { useWallet } from '@/lib/wallet';
import { WalletAction } from './issuer-action';
import { ProgramNotice } from './program-notice';
import { Pill, Section } from './treasury-ui';

/** A mint read from the network a moment after the person stops typing; null while the box is empty or not an address. */
function useMint(text: string): MintRead | null | 'reading' {
  const [state, setState] = useState<MintRead | null | 'reading'>(null);
  useEffect(() => {
    const t = text.trim();
    if (!isAddress(t)) {
      setState(null);
      return;
    }
    setState('reading');
    let live = true;
    const timer = setTimeout(() => void readMintFull(t).then((m) => live && setState(m)), 250);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [text]);
  return state;
}

export function SeriesConsole() {
  const { account } = useWallet();
  const wallet = account?.address ?? null;
  const [list, setList] = useState<SeriesListRow[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [selected, setSelected] = useState('');
  const [typed, setTyped] = useState('');
  const [rev, setRev] = useState(0);

  useEffect(() => {
    const q = new URLSearchParams(window.location.search).get('series');
    if (q && isAddress(q)) setSelected(q);
  }, []);
  useEffect(() => {
    if (!wallet) {
      setList(null);
      return;
    }
    let live = true;
    void loadSeriesList(wallet).then((r) => {
      if (!live) return;
      if (r.ok) {
        setList(r.data.series);
        setListError(null);
      } else setListError(r.error);
    });
    return () => {
      live = false;
    };
  }, [wallet, rev]);

  const typedOk = isAddress(typed.trim());
  return (
    <div className="mt-8 space-y-6">
      <ProgramNotice which="crossCore" what="Recurring series" />
      <Section id="mine" title="Your series" intro="A series spawns a cross on a schedule with a template that never changes: the same grid rules, the same guards, the same fees. Anyone can start the next cross when it is due; you can pause the series and withdraw what it holds, and nothing else.">
        {!wallet ? (
          <p className="text-sm text-muted" data-testid="connect-for-series">
            Connect the wallet that created a series to list it, or paste a series address below.
          </p>
        ) : null}
        {listError ? (
          <p role="alert" className="text-sm text-accent-text">
            {listError}
          </p>
        ) : null}
        {wallet && list && list.length === 0 ? (
          <p className="text-sm text-muted" data-testid="no-series">
            This wallet has created no series on this network.
          </p>
        ) : null}
        {list && list.length > 0 ? (
          <ul className="grid gap-2" data-testid="my-series">
            {list.map((s) => (
              <li key={s.address}>
                <button type="button" aria-pressed={selected === s.address} onClick={() => setSelected(s.address)} data-testid={`pick-${s.address}`} className={`flex min-h-11 w-full flex-wrap items-center justify-between gap-2 rounded-lg border px-4 py-2 text-left text-sm ${selected === s.address ? 'border-ink' : 'border-border'}`}>
                  <span className="font-mono">{shortAddress(s.address)}</span>
                  <Pill>{s.crosses} cross{s.crosses === 1 ? '' : 'es'} spawned</Pill>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        <div className="grid grid-cols-[1fr_auto] items-end gap-3">
          <Text label="Or a series address" value={typed} onChange={setTyped} error={typed.trim() !== '' && !typedOk ? 'This is not a Solana address.' : undefined} />
          <SmallButton testId="use-typed" disabled={!typedOk} onClick={() => setSelected(typed.trim())}>
            Open
          </SmallButton>
        </div>
      </Section>

      {selected ? (
        <div className="space-y-3" data-testid="selected-series">
          <p className="text-sm text-muted">
            Public page of this series:{' '}
            <Link href={`/series/${selected}`} className="font-mono underline underline-offset-4">
              /series/{shortAddress(selected)}
            </Link>
          </p>
          <SeriesDetail key={selected} address={selected} />
        </div>
      ) : null}

      <Create wallet={wallet} account={account ?? null} onCreated={(address) => {
        setRev((r) => r + 1);
        setSelected(address);
      }} />
    </div>
  );
}

const ERR = (e: string | undefined) => e;

function Create({ wallet, account, onCreated }: { wallet: string | null; account: ReturnType<typeof useWallet>['account']; onCreated: (series: string) => void }) {
  const [f, setF] = useState<SeriesForm>(EMPTY_SERIES_FORM);
  const set = <K extends keyof SeriesForm>(k: K) => (v: SeriesForm[K]) => setF((x) => ({ ...x, [k]: v }));
  // The connected wallet fills the three addresses that are almost always its own, until the person types something else.
  const [touched, setTouched] = useState<{ integrator: boolean; proceedsTo: boolean }>({ integrator: false, proceedsTo: false });
  useEffect(() => {
    if (!wallet) return;
    setF((x) => ({ ...x, integrator: touched.integrator ? x.integrator : wallet, proceedsTo: touched.proceedsTo ? x.proceedsTo : wallet }));
  }, [wallet, touched]);
  const base = useMint(f.baseMint);
  const quote = useMint(f.quoteMint);
  const baseInfo = base && base !== 'reading' && base.ok ? { decimals: base.decimals, program: base.program } : null;
  const quoteInfo = quote && quote !== 'reading' && quote.ok ? { decimals: quote.decimals, program: quote.program } : null;
  const built = useMemo(() => buildSeries(f, { authority: wallet, base: baseInfo, quote: quoteInfo }), [f, wallet, baseInfo?.decimals, baseInfo?.program, quoteInfo?.decimals, quoteInfo?.program]); // eslint-disable-line react-hooks/exhaustive-deps
  const e = built.errors;
  const reading = base === 'reading' || quote === 'reading';
  // Errors about a token appear only after it has been read, so a half-typed address is not scolded.
  const mintNote = (m: typeof base, text: string) => (text.trim() === '' || m === 'reading' || m === null ? undefined : m.ok ? undefined : m.reason);
  const summary = built.body && baseInfo && quoteInfo ? seriesSummary(built.body, { base: baseInfo, quote: quoteInfo }) : null;
  const [created, setCreated] = useState<string | null>(null);

  return (
    <Section id="create" title="Create a series" intro="Choose what recurs and how often. The template you sign here is the template of every cross the series ever spawns; it cannot be edited afterwards, only paused.">
      <div className="space-y-6" data-testid="series-form">
        <fieldset className="space-y-4">
          <legend className="font-medium">What trades</legend>
          <div className="grid gap-4 sm:grid-cols-2">
            <Text label="Token" value={f.baseMint} onChange={set('baseMint')} error={ERR(mintNote(base, f.baseMint) ?? e.baseMint)} hint="The mint of the token that trades in each cross." />
            <Text label="Quote token" value={f.quoteMint} onChange={set('quoteMint')} error={ERR(mintNote(quote, f.quoteMint) ?? e.quoteMint)} hint="What buyers pay with, for example USDC." />
            <Text label="Series number" value={f.seriesId} onChange={set('seriesId')} inputMode="numeric" error={e.seriesId} hint="Your wallet can use each number once." />
            <Select label="Kind" value={f.kind} onChange={(v) => set('kind')(v as SeriesForm['kind'])} options={[['recurring', 'Recurring: a market that reopens on a schedule'], ['reopen', 'Reopen: an exchange-style opening']]} />
          </div>
        </fieldset>

        <fieldset className="space-y-4">
          <legend className="font-medium">When</legend>
          <div className="grid gap-4 sm:grid-cols-2">
            <Select label="Schedule" value={f.schedule} onChange={(v) => set('schedule')(v as SeriesForm['schedule'])} options={[['interval', 'Every fixed interval'], ['calendar', 'At each session of a market calendar']]} />
            {f.schedule === 'interval' ? (
              <>
                <Text label="First slot closes" type="datetime-local" mono={false} value={f.startAt} onChange={set('startAt')} error={e.startAt} hint="In your time zone. Later slots follow at the interval below; a missed slot is skipped." />
                <Text label="Interval, hours" value={f.intervalHours} onChange={set('intervalHours')} inputMode="numeric" error={e.intervalHours} hint="168 is weekly, 24 is daily." />
              </>
            ) : (
              <Text label="Calendar address" value={f.calendar} onChange={set('calendar')} error={e.calendar} hint="A cross_calendar account. Each cross closes at the start of the next session." />
            )}
            <Text label="The call lasts, minutes" value={f.callMins} onChange={set('callMins')} inputMode="numeric" error={e.callMins} hint="How long orders are taken before the close." />
            <Select label="Orders are" value={f.disclosure} onChange={(v) => set('disclosure')(v as SeriesForm['disclosure'])} options={[['open', 'Open: the book is visible'], ['sealed', 'Sealed: committed, then revealed']]} />
            {f.disclosure === 'sealed' ? <Text label="Reveal window, minutes" value={f.revealMins} onChange={set('revealMins')} inputMode="numeric" error={e.revealMins} /> : null}
            <Text label="Stop after, crosses" value={f.maxCrosses} onChange={set('maxCrosses')} inputMode="numeric" error={e.maxCrosses} hint="Empty: it runs until paused." />
          </div>
        </fieldset>

        <fieldset className="space-y-4">
          <legend className="font-medium">The price grid</legend>
          <div className="grid gap-4 sm:grid-cols-2">
            <Select label="Grid" value={f.gridMode} onChange={(v) => set('gridMode')(v as SeriesForm['gridMode'])} options={[['relative', 'Re-centred on the last printed price'], ['fixed', 'The same prices every time']]} />
            <Text label="Price steps" value={f.ticks} onChange={set('ticks')} inputMode="numeric" error={e.ticks} />
            {f.gridMode === 'relative' ? (
              <>
                <Text label="First centre price, per token" value={f.centerPrice} onChange={set('centerPrice')} inputMode="decimal" error={e.centerPrice} hint="Used for the first cross. After a print, the next grid centres on the price that printed." />
                <Text label="Step size, % of the centre" value={f.tickPct} onChange={set('tickPct')} inputMode="decimal" error={e.tickPct} />
              </>
            ) : (
              <>
                <Text label="Lowest price, per token" value={f.minPrice} onChange={set('minPrice')} inputMode="decimal" error={e.minPrice} />
                <Text label="Step, per token" value={f.tick} onChange={set('tick')} inputMode="decimal" error={e.tick} />
              </>
            )}
          </div>
        </fieldset>

        <fieldset className="space-y-4">
          <legend className="font-medium">Guards, fees and where the money goes</legend>
          <div className="grid gap-4 sm:grid-cols-2">
            <Text label="Minimum volume, in tokens" value={f.minMatched} onChange={set('minMatched')} inputMode="decimal" error={e.minMatched} hint="Below this a cross does not print. Empty: none." />
            <Text label="Largest imbalance, %" value={f.maxImbalancePct} onChange={set('maxImbalancePct')} inputMode="decimal" error={e.maxImbalancePct} hint="Empty: no limit." />
            <Select label="Rules for every cross" value={f.rules} onChange={(v) => set('rules')(v as SeriesForm['rules'])} options={[['none', 'None: a plain call auction'], ['ending', 'Hard-to-game ending (last 30 minutes in 6 buckets, drawn end)']]} hint="Bonded insiders and a resume flag are not available to a series." />
            <Text label="Gate mint (optional)" value={f.gateMint} onChange={set('gateMint')} error={e.gateMint} hint="Limits every cross to holders of a gate pass." />
            <Text label="Integrator fee, %" value={f.integratorFeePct} onChange={set('integratorFeePct')} inputMode="decimal" error={e.integratorFeePct} hint="0 to 3." />
            <Text label="Integrator address" value={f.integrator} onChange={(v) => { setTouched((t) => ({ ...t, integrator: true })); set('integrator')(v); }} error={e.integrator} />
            <Text label="Proceeds go to" value={f.proceedsTo} onChange={(v) => { setTouched((t) => ({ ...t, proceedsTo: true })); set('proceedsTo')(v); }} error={e.proceedsTo} hint="Where sellers’ proceeds from each cross are sent." />
            <Text label="Shards" value={f.shards} onChange={set('shards')} inputMode="numeric" error={e.shards} />
            <Text label="Most orders in one cross" value={f.maxOrders} onChange={set('maxOrders')} inputMode="numeric" error={e.maxOrders} />
          </div>
        </fieldset>

        {summary ? (
          <div className="rounded-lg border border-border p-4" data-testid="series-summary">
            <p className="font-medium">What you are about to commit</p>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-muted">
              {summary.map((l) => (
                <li key={l}>{l}</li>
              ))}
            </ul>
          </div>
        ) : null}

        <div className="max-w-sm">
          <WalletAction
            account={account}
            label="Create the series"
            path="/v1/tx/create-series"
            needs="crossCore"
            what="Recurring series"
            testId="create-series"
            disabled={!built.body || reading}
            disabledReason={reading ? 'Reading the tokens…' : !wallet ? 'Connect the wallet that will own the series.' : 'Fill in the fields marked above.'}
            body={() => built.body}
            onBuilt={(x) => setCreated(typeof x.series === 'string' ? x.series : null)}
            onDone={() => {
              if (created) onCreated(created);
            }}
          />
          {created ? (
            <p className="mt-2 text-xs text-muted" role="status" data-testid="created-series">
              Series address: <span className="break-all font-mono">{created}</span>
            </p>
          ) : null}
        </div>
      </div>
    </Section>
  );
}
