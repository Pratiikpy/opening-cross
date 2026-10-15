'use client';

import { isAddress } from '@solana/kit';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { BadgeBox } from '@/components/backing/backing-view';
import { SmallButton, Text } from '@/components/issue-wizard/fields';
import { Failed, FeatureAction, FeatureNotice, Loading, Plain } from '@/components/w4/ui';
import { type BackingRead, EMPTY_POLICY, type PolicyForm, badgeOf, bpsPct, buildAttest, buildPolicy, ageText, stamp } from '@/lib/backing';
import { crossSummary } from '@/lib/issuer-data';
import { loadHalt } from '@/lib/series-load';
import type { HaltRead } from '@/lib/halts';
import { useMint, useRead } from '@/lib/use-read';
import { formatAtoms, shortAddress } from '@/lib/units';
import { useWallet } from '@/lib/wallet';
import { Facts, Section } from './treasury-ui';

const WHAT = 'Automatic pause on missing backing';

/** Where an issuer opts a token in to the backing watchdog and an attester posts statements. */
export function BackingConsole() {
  const { account } = useWallet();
  const wallet = account?.address ?? null;
  const [mints, setMints] = useState<string[] | null>(null);
  const [selected, setSelected] = useState('');
  const [typed, setTyped] = useState('');
  useEffect(() => {
    const q = new URLSearchParams(window.location.search).get('mint');
    if (q && isAddress(q)) setSelected(q);
  }, []);
  useEffect(() => {
    let live = true;
    void crossSummary(1000).then((r) => live && setMints(r.ok ? [...new Set(r.data.crosses.filter((c) => c.creator === wallet).map((c) => c.baseMint))] : []));
    return () => {
      live = false;
    };
  }, [wallet]);
  const typedOk = isAddress(typed.trim());
  return (
    <div className="mt-8 space-y-6">
      <FeatureNotice feature="backing" what={WHAT} />
      <Section id="pick" title="Choose a token" intro={<p>The token whose backing the watchdog should watch. You must be the authority of its halt state, which you are if you created it.</p>}>
        {mints && mints.length > 0 ? (
          <ul className="grid gap-2 sm:grid-cols-2" data-testid="my-tokens">
            {mints.map((m) => (
              <li key={m}>
                <SmallButton testId={`pick-${m}`} pressed={selected === m} onClick={() => setSelected(m)}>
                  {shortAddress(m)}
                </SmallButton>
              </li>
            ))}
          </ul>
        ) : null}
        <div className="grid grid-cols-[1fr_auto] items-end gap-3">
          <Text label="Or a token address" value={typed} onChange={setTyped} error={typed.trim() !== '' && !typedOk ? 'This is not a Solana address.' : undefined} />
          <SmallButton testId="use-typed" disabled={!typedOk} onClick={() => setSelected(typed.trim())}>
            Use this token
          </SmallButton>
        </div>
      </Section>
      {selected ? <Token key={selected} mint={selected} wallet={wallet} /> : null}
    </div>
  );
}

function Token({ mint, wallet }: { mint: string; wallet: string | null }) {
  const { account } = useWallet();
  const backing = useRead<BackingRead>(`/v1/assets/${mint}/backing`);
  const info = useMint(mint);
  const [halt, setHalt] = useState<HaltRead | null | 'error'>(null);
  const [rev, setRev] = useState(0);
  useEffect(() => {
    let live = true;
    void loadHalt(mint).then((r) => live && setHalt(r.ok ? r.data : 'error'));
    return () => {
      live = false;
    };
  }, [mint, rev]);
  const [form, setForm] = useState<PolicyForm>(EMPTY_POLICY);
  const [figure, setFigure] = useState('');
  const set = <K extends keyof PolicyForm>(k: K) => (v: PolicyForm[K]) => setForm((x) => ({ ...x, [k]: v }));
  const policy = useMemo(() => buildPolicy(form, wallet, mint, isAddress), [form, wallet, mint]);
  const attest = useMemo(() => buildAttest(figure, wallet, mint, info.info?.decimals ?? null), [figure, wallet, mint, info.info]);
  if (backing.phase === 'loading' || backing.phase === 'idle' || halt === null) return <Loading what="the token" />;
  if (backing.phase === 'error') return <Failed>The backing could not be read: {backing.error}</Failed>;
  const b = backing.data;
  const decimals = info.info?.decimals ?? 6;
  const reload = () => {
    backing.reload();
    setRev((r) => r + 1);
  };
  const state = halt === 'error' ? null : (halt.state ?? null);
  const watchdogNamed = state !== null && state.venueSigner === b.watchdog;
  const isAuthority = state !== null && wallet !== null && state.authority === wallet;
  const isAttester = b.policy !== null && wallet !== null && b.policy.attester === wallet;
  return (
    <>
      <p className="text-sm text-muted">
        Public page for holders:{' '}
        <Link href={`/backing/${mint}`} className="font-mono underline underline-offset-4">
          /backing/{shortAddress(mint)}
        </Link>
      </p>
      <BadgeBox badge={badgeOf(b, decimals, Math.floor(Date.now() / 1000))} />
      {b.release.deployed === false ? <Plain testId="backing-note">{b.note}</Plain> : null}

      <Section id="halt" title="1. The halt state names the watchdog" intro={<p>The watchdog is a program-derived account that may halt the token when its backing fails. It must be the halt state&apos;s venue signer, and that is fixed when the halt state is created.</p>}>
        {halt === 'error' ? <Failed>The halt state could not be read.</Failed> : null}
        {state === null && halt !== 'error' ? (
          <>
            <p className="text-sm text-muted" data-testid="halt-none">No halt state exists for this token. Creating one makes you its authority and names the watchdog as its venue signer, for good.</p>
            <div className="max-w-sm">
              <FeatureAction feature="backing" what={WHAT} account={account} label="Create the halt state with the watchdog" testId="init-halt-state" path="/v1/tx/backing-init-halt-state" body={() => ({ authority: wallet, baseMint: mint })} disabled={!wallet} disabledReason="Connect the wallet that issues this token." onDone={reload} />
            </div>
          </>
        ) : null}
        {state !== null && watchdogNamed ? <p className="text-sm" data-testid="halt-ok">The halt state names the watchdog ({shortAddress(b.watchdog)}) as its venue signer.</p> : null}
        {state !== null && !watchdogNamed ? (
          <Plain testId="halt-other">
            This token&apos;s halt state already exists and names {state.venueSigner ? shortAddress(state.venueSigner) : 'no venue signer'} as its venue signer. The venue signer is fixed at creation, so the watchdog cannot be used with this halt state; a new asset names it from the start.
          </Plain>
        ) : null}
      </Section>

      <Section id="policy" title="2. Opt the token in" intro={<p>The policy is permanent: the attester you trust, the coverage you commit to and how old a statement may be.</p>}>
        {b.optedIn && b.policy ? (
          <Facts rows={[['Attester', shortAddress(b.policy.attester)], ['Coverage committed', bpsPct(b.policy.minCoverageBps)], ['Longest age of a statement', ageText(Number(b.policy.maxAgeSecs))]]} />
        ) : (
          <>
            <div className="grid gap-4 sm:grid-cols-2" data-testid="policy-form">
              <Text label="Attester" value={form.attester} onChange={set('attester')} error={form.attester === '' ? undefined : policy.errors.attester} hint="The key whose statements count. It proves nothing about a custodian: which attesters holders should trust is your decision to make in the open." />
              <Text label="Coverage committed, % of the live supply" value={form.coveragePct} onChange={set('coveragePct')} inputMode="decimal" error={policy.errors.coveragePct} hint="1 to 200." />
              <Text label="Longest age of a statement" value={form.ageValue} onChange={set('ageValue')} inputMode="numeric" error={policy.errors.ageValue} />
              <div className="text-sm">
                <label className="block">
                  <span className="text-muted">Unit</span>
                  <select value={form.ageUnit} onChange={(e) => set('ageUnit')(e.target.value as PolicyForm['ageUnit'])} className="mt-1 min-h-11 w-full rounded-lg border border-border-strong bg-bg px-3 py-2.5">
                    <option value="minutes">minutes</option>
                    <option value="hours">hours</option>
                    <option value="days">days</option>
                  </select>
                </label>
              </div>
            </div>
            <div className="max-w-sm">
              <FeatureAction
                feature="backing"
                what={WHAT}
                account={account}
                label="Create the policy"
                testId="create-policy"
                path="/v1/tx/backing-create-policy"
                body={() => policy.body}
                disabled={!policy.body || !watchdogNamed || !isAuthority}
                disabledReason={!watchdogNamed ? 'The halt state must name the watchdog first.' : !isAuthority ? 'Only the halt state’s authority can opt the token in. Connect that wallet.' : 'Fill in the fields marked above.'}
                onDone={reload}
              />
            </div>
          </>
        )}
      </Section>

      <Section id="statement" title="3. The latest statement" intro={<p>What the attester has posted, and what it covers now.</p>}>
        {b.attestation ? (
          <Facts rows={[['Backing stated', formatAtoms(BigInt(b.attestation.backingAtoms), decimals)], ['Posted', stamp(b.attestation.postedTs)], ['Fresh until', stamp(b.attestation.freshUntil)], ['Live supply', b.supply === null ? 'unknown' : formatAtoms(BigInt(b.supply), decimals)], ['Verdict now', b.verdict ?? 'unknown']]} />
        ) : (
          <p className="text-sm text-muted" data-testid="no-statement">{b.optedIn ? 'No statement has been posted: the asset halts at the next check.' : 'No policy, so no statement is expected.'}</p>
        )}
        {isAttester ? (
          <div className="space-y-3" data-testid="attest-box">
            <p className="text-sm font-medium">You are this policy&apos;s attester</p>
            <Text label="Backing to state, in tokens of this asset" value={figure} onChange={setFigure} inputMode="decimal" error={attest.error} hint="Post only a figure your source gave you, dated and fresh. The chain stamps the time." />
            <div className="max-w-sm">
              <FeatureAction feature="backing" what={WHAT} account={account} label="Post the statement" testId="attest" path="/v1/tx/backing-attest" body={() => attest.body} disabled={!attest.body} disabledReason="Enter the backing figure." onDone={reload} />
            </div>
          </div>
        ) : b.optedIn ? (
          <p className="text-sm text-muted" data-testid="not-attester">Only the attester ({shortAddress(b.policy!.attester)}) can post a statement.</p>
        ) : null}
      </Section>
    </>
  );
}
