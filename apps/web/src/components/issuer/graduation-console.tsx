'use client';

import { isAddress } from '@solana/kit';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { SmallButton, Text } from '@/components/issue-wizard/fields';
import { GraduationPanel } from '@/components/graduation/graduation-panel';
import { Failed, FeatureAction, FeatureNotice, Loading, Plain } from '@/components/w4/ui';
import { type CharterForm, EMPTY_CHARTER, type GraduationRead, buildCharter, creatorStep, venueLabel } from '@/lib/graduation';
import { crossSummary, type CrossRow } from '@/lib/issuer-data';
import { useMint, useRead } from '@/lib/use-read';
import type { CrossDetail } from '@/lib/types';
import { shortAddress } from '@/lib/units';
import { useWallet } from '@/lib/wallet';
import { Section } from './treasury-ui';

/** Where the creator of a governed cross sets its charter, opens its rounds and sees the outcome. Holders vote on the cross page. */
export function GraduationConsole() {
  const { account } = useWallet();
  const wallet = account?.address ?? null;
  const [crosses, setCrosses] = useState<CrossRow[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [selected, setSelected] = useState('');
  const [typed, setTyped] = useState('');
  useEffect(() => {
    const q = new URLSearchParams(window.location.search).get('cross');
    if (q && isAddress(q)) setSelected(q);
  }, []);
  useEffect(() => {
    let live = true;
    void crossSummary(1000).then((r) => {
      if (!live) return;
      if (r.ok) setCrosses(r.data.crosses.filter((c) => c.creator === wallet));
      else setListError(r.error);
    });
    return () => {
      live = false;
    };
  }, [wallet]);
  const typedOk = isAddress(typed.trim());
  return (
    <div className="mt-8 space-y-6">
      <FeatureNotice feature="governedGraduation" what="Graduation by holder vote" />
      <Section id="pick" title="Choose a cross" intro={<p>A cross has a graduation vote only if you set the governed-graduation rule when you created it, before its first order. Rules are written once and cannot be added later.</p>}>
        {!wallet ? <Plain testId="connect-hint">Connect the wallet you created the cross with to list your crosses, or type a cross address.</Plain> : null}
        {listError ? <Failed>Your crosses could not be listed: {listError}</Failed> : null}
        {wallet && crosses && crosses.length === 0 ? <Plain testId="no-crosses">This wallet has created no cross on this network.</Plain> : null}
        {crosses && crosses.length > 0 ? (
          <ul className="grid gap-2 sm:grid-cols-2" data-testid="my-crosses">
            {crosses.slice(0, 12).map((c) => (
              <li key={c.address}>
                <SmallButton testId={`pick-${c.address}`} pressed={selected === c.address} onClick={() => setSelected(c.address)}>
                  {shortAddress(c.address)} · {c.state}
                </SmallButton>
              </li>
            ))}
          </ul>
        ) : null}
        <div className="grid grid-cols-[1fr_auto] items-end gap-3">
          <Text label="Or a cross address" value={typed} onChange={setTyped} error={typed.trim() !== '' && !typedOk ? 'This is not a Solana address.' : undefined} />
          <SmallButton testId="use-typed" disabled={!typedOk} onClick={() => setSelected(typed.trim())}>
            Use this cross
          </SmallButton>
        </div>
      </Section>
      {selected ? <Selected key={selected} cross={selected} /> : null}
    </div>
  );
}

function Selected({ cross }: { cross: string }) {
  const detail = useRead<CrossDetail>(`/v1/crosses/${cross}`);
  const grad = useRead<GraduationRead>(`/v1/crosses/${cross}/graduation`);
  const { account } = useWallet();
  const wallet = account?.address ?? null;
  const quote = useMint(detail.phase === 'ok' ? detail.data.quoteMint : null);
  const base = useMint(detail.phase === 'ok' ? detail.data.baseMint : null);
  if (detail.phase === 'loading' || grad.phase === 'loading') return <Loading what="the cross" />;
  if (detail.phase === 'error') return <Failed>{detail.status === 404 ? `No cross exists at ${cross} on this network.` : `The cross could not be read: ${detail.error}`}</Failed>;
  if (grad.phase === 'error') return <Failed>The graduation vote could not be read: {grad.error}</Failed>;
  if (detail.phase !== 'ok' || grad.phase !== 'ok') return null;
  const c = detail.data;
  const g = grad.data;
  const mine = wallet !== null && c.creator === wallet;
  const step = creatorStep(g);
  const reload = () => {
    detail.reload();
    grad.reload();
  };
  return (
    <>
      <p className="text-sm text-muted">
        Cross{' '}
        <Link href={`/crosses/${cross}`} className="font-mono underline underline-offset-4">
          {shortAddress(cross)}
        </Link>{' '}
        · {c.state} · {c.orders.total} order{c.orders.total === 1 ? '' : 's'}. Holders vote on its page.
      </p>
      {!g.governed ? (
        <Plain testId="not-governed">This cross did not set the governed-graduation rule, so it has no vote and its market opens without one. The rule is set when a cross is created and cannot be added afterwards.</Plain>
      ) : !mine ? (
        <Plain testId="not-creator">{wallet ? 'This wallet did not create this cross. Only its creator sets the charter and opens rounds.' : 'Connect the wallet that created this cross to set its charter or open a round.'}</Plain>
      ) : g.release.deployed === false ? (
        <Plain testId="not-deployed">{g.note ?? 'cross_graduate is not deployed on this network, so no charter can be set.'}</Plain>
      ) : step === 'no-charter' ? (
        <CharterBox cross={cross} account={account} wallet={wallet} quoteDecimals={quote.info?.decimals ?? c.decimals.quote} live={c.state === 'Live'} orders={c.orders.total} reload={reload} />
      ) : step === 'start-round' ? (
        <StartRound cross={cross} account={account} finalized={c.state === 'Finalized'} baseBound={c.baseMint !== null} mintAuthority={base.info?.mintAuthority ?? null} used={g.charter!.roundsUsed} reload={reload} />
      ) : step === 'round-open' ? (
        <Plain testId="round-open">A round is open or waiting to be finalized. Holders vote and anyone finalizes it on the cross page; you can open another only if it fails.</Plain>
      ) : step === 'passed' ? (
        <Plain testId="vote-passed">
          A round passed{g.outcome ? ` and holders chose ${venueLabel(g.outcome.venue)}` : ', but its outcome is not published yet; anyone can publish it from the cross page'}.{' '}
          {g.outcome ? (
            <>
              <Link href={`/issuer/settle?cross=${cross}`} className="underline underline-offset-4">
                Open the market
              </Link>{' '}
              on that venue.
            </>
          ) : null}
        </Plain>
      ) : (
        <Plain testId="no-rounds-left">All three rounds failed. This market now has no graduation venue: the settlement program will not open a pool for it.</Plain>
      )}
      {g.governed ? (
        <Section id="state" title="The vote so far" intro={<p>The same view holders see on the cross page.</p>}>
          <GraduationPanel cross={cross} baseMint={c.baseMint} baseDecimals={c.decimals.base} quoteDecimals={c.decimals.quote} creator={c.creator} />
        </Section>
      ) : null}
    </>
  );
}

function CharterBox({ cross, account, wallet, quoteDecimals, live, orders, reload }: { cross: string; account: ReturnType<typeof useWallet>['account']; wallet: string | null; quoteDecimals: number; live: boolean; orders: number; reload: () => void }) {
  const [f, setF] = useState<CharterForm>(EMPTY_CHARTER);
  const set = <K extends keyof CharterForm>(k: K) => (v: CharterForm[K]) => setF((x) => ({ ...x, [k]: v }));
  const built = useMemo(() => buildCharter(f, wallet, cross, quoteDecimals), [f, wallet, cross, quoteDecimals]);
  const tooLate = !live || orders > 0;
  return (
    <Section id="charter" title="Set the charter" intro={<p>The charter fixes how holders will decide, for good. It can be set only before the first order. Quorum is measured against the live supply when a round is finalized.</p>}>
      <div className="grid gap-4 sm:grid-cols-2" data-testid="charter-form">
        <Text label="Quorum, % of the live supply" value={f.quorumPct} onChange={set('quorumPct')} inputMode="decimal" error={built.errors.quorumPct} hint="10 to 100. Locked tokens must reach this share for a round to pass." />
        <Text label="Voting window, days" value={f.windowDays} onChange={set('windowDays')} inputMode="numeric" error={built.errors.windowDays} hint="3 to 30 days per round." />
        <Text label="Minimum organic volume, in quote tokens (optional)" value={f.minVolume} onChange={set('minVolume')} inputMode="decimal" error={built.errors.minVolume} hint="The program cannot measure volume. If you set a minimum, the attester below states the figure." />
        <Text label="Volume attester (optional)" value={f.attester} onChange={set('attester')} error={built.errors.attester} hint="The wallet allowed to post the organic volume. A charter is as honest as its attester." />
      </div>
      {tooLate ? <Plain testId="charter-too-late">The charter is set before the first order. This cross is {live ? 'already taking orders' : 'no longer live'}, so the program will refuse it.</Plain> : null}
      <div className="max-w-sm">
        <FeatureAction
          feature="governedGraduation"
          what="Graduation by holder vote"
          account={account}
          label="Set the charter"
          testId="init-charter"
          path="/v1/tx/graduate-init-charter"
          body={() => built.body}
          disabled={!built.body || tooLate}
          disabledReason={tooLate ? 'The charter must be set before the first order.' : 'Fill in the fields marked above.'}
          onDone={reload}
        />
      </div>
    </Section>
  );
}

function StartRound({ cross, account, finalized, baseBound, mintAuthority, used, reload }: { cross: string; account: ReturnType<typeof useWallet>['account']; finalized: boolean; baseBound: boolean; mintAuthority: string | null; used: number; reload: () => void }) {
  const ready = finalized && baseBound;
  return (
    <Section id="start" title={used === 0 ? 'Open the first round' : `Open round ${used + 1}`} intro={<p>A round opens once the cross is finalized and its token exists. It runs for the charter&apos;s window; at most three rounds in all, one at a time.</p>}>
      {mintAuthority ? (
        <Plain testId="start-mint-authority-warning">
          The token still has a mint authority ({shortAddress(mintAuthority)}). While it does, the supply can grow during a round and with it the quorum, which holders would read as a veto by dilution. Revoke it before asking holders to vote.
        </Plain>
      ) : (
        <Plain testId="start-mint-authority-clear">The token has no mint authority, so the supply cannot grow while holders vote.</Plain>
      )}
      <div className="max-w-sm">
        <FeatureAction
          feature="governedGraduation"
          what="Graduation by holder vote"
          account={account}
          label="Open the round"
          testId="start-round"
          path="/v1/tx/graduate-start-round"
          body={() => ({ creator: account?.address, cross })}
          disabled={!ready}
          disabledReason="The cross must be finalized and its token must exist before holders can vote."
          onDone={reload}
        />
      </div>
    </Section>
  );
}
