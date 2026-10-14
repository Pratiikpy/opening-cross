'use client';

import { isAddress } from '@solana/kit';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { SmallButton, Text } from '@/components/issue-wizard/fields';
import { HaltStatus, useHalt } from '@/components/halts/halt-status';
import { readMintFull } from '@/lib/issuer-chain';
import { crossSummary } from '@/lib/issuer-data';
import { atomsOf } from '@/lib/issuer-treasury-console';
import { EMPTY_HALT_INIT, type FeedRead, type HaltInitForm, buildHaltInit, parsePublishers, roleOf } from '@/lib/halts';
import { formatAtoms, shortAddress } from '@/lib/units';
import { useWallet } from '@/lib/wallet';
import { WalletAction } from './issuer-action';
import { ProgramNotice } from './program-notice';
import { Section } from './treasury-ui';

export function HaltConsole() {
  const { account } = useWallet();
  const wallet = account?.address ?? null;
  const [mints, setMints] = useState<string[] | null>(null);
  const [mintsError, setMintsError] = useState<string | null>(null);
  const [selected, setSelected] = useState('');
  const [typed, setTyped] = useState('');

  useEffect(() => {
    const q = new URLSearchParams(window.location.search).get('mint');
    if (q && isAddress(q)) setSelected(q);
  }, []);
  useEffect(() => {
    let live = true;
    void crossSummary(1000).then((r) => {
      if (!live) return;
      if (r.ok) setMints([...new Set(r.data.crosses.filter((c) => c.creator === wallet).map((c) => c.baseMint))]);
      else setMintsError(r.error);
    });
    return () => {
      live = false;
    };
  }, [wallet]);

  const typedOk = isAddress(typed.trim());
  return (
    <div className="mt-8 space-y-6">
      <ProgramNotice which="crossCore" what="Halt states, corporate-action flags and the lender print feed" />
      <Section id="pick" title="Choose a token" intro="A halt state belongs to a token, not to a cross. It is created once by the token’s issuer, and every cross that honours it stops printing while the token is halted. The tokens of the crosses your wallet created are listed.">
        {!wallet ? <p className="text-sm text-muted" data-testid="connect-for-tokens">Connect the wallet you issue from to list your tokens, or paste a token address below.</p> : null}
        {mintsError ? <p role="alert" className="text-sm text-accent-text">{mintsError}</p> : null}
        {wallet && mints && mints.length === 0 ? <p className="text-sm text-muted" data-testid="no-tokens">This wallet has created no cross on this network.</p> : null}
        {mints && wallet && mints.length > 0 ? (
          <ul className="grid gap-2" data-testid="my-tokens">
            {mints.map((m) => (
              <li key={m}>
                <button type="button" aria-pressed={selected === m} onClick={() => setSelected(m)} data-testid={`pick-${m}`} className={`flex min-h-11 w-full items-center rounded-lg border px-4 py-2 text-left font-mono text-sm ${selected === m ? 'border-ink' : 'border-border'}`}>
                  {shortAddress(m)}
                </button>
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
      {selected ? <Token key={selected} baseMint={selected} account={account ?? null} wallet={wallet} /> : null}
    </div>
  );
}

function Token({ baseMint, account, wallet }: { baseMint: string; account: ReturnType<typeof useWallet>['account']; wallet: string | null }) {
  const [rev, setRev] = useState(0);
  const reload = () => setRev((r) => r + 1);
  const data = useHalt(baseMint, rev);
  const state = data?.halt?.state;
  const role = roleOf(state, wallet);
  return (
    <>
      <p className="text-sm text-muted">
        Public page for holders:{' '}
        <Link href={`/halts/${baseMint}`} className="font-mono underline underline-offset-4">
          /halts/{shortAddress(baseMint)}
        </Link>
      </p>
      <HaltStatus data={data} baseMint={baseMint} />
      {data?.halt ? (
        state ? (
          <Controls baseMint={baseMint} account={account} wallet={wallet} role={role} halted={state.halted} corporateAction={state.corporateAction} hasBreaker={state.breaker !== null} reload={reload} />
        ) : (
          <Init baseMint={baseMint} account={account} wallet={wallet} reload={reload} />
        )
      ) : null}
      {data?.halt ? <Feed baseMint={baseMint} account={account} wallet={wallet} feed={data.feed} reload={reload} /> : null}
    </>
  );
}

function Init({ baseMint, account, wallet, reload }: { baseMint: string; account: ReturnType<typeof useWallet>['account']; wallet: string | null; reload: () => void }) {
  const [f, setF] = useState<HaltInitForm>(EMPTY_HALT_INIT);
  const set = <K extends keyof HaltInitForm>(k: K) => (v: HaltInitForm[K]) => setF((x) => ({ ...x, [k]: v }));
  const built = useMemo(() => buildHaltInit(f, wallet, baseMint), [f, wallet, baseMint]);
  return (
    <Section id="init" title="Create the halt state" intro="Creating it makes you the token’s halt authority, once and for good. You can then halt the token and flag a corporate action, and only a cross you or the venue creates can lift a halt. You may also name an exchange or market operator as a second signer that can halt, and a circuit breaker fed by a Pyth price.">
      <div className="grid gap-4 sm:grid-cols-2" data-testid="halt-init-form">
        <Text label="Venue signer (optional)" value={f.venueSigner} onChange={set('venueSigner')} error={built.errors.venueSigner} hint="An exchange or market operator that can signal a halt. It can never flag a corporate action." />
        <div className="text-sm">
          <label className="mt-6 flex min-h-11 items-center gap-3">
            <input type="checkbox" checked={f.breaker} onChange={(e) => set('breaker')(e.target.checked)} className="size-5" />
            <span>Add a circuit breaker</span>
          </label>
        </div>
        {f.breaker ? (
          <>
            <Text label="Pyth price feed id" value={f.feedId} onChange={set('feedId')} error={built.errors.feedId} hint="64 hexadecimal characters. Anyone can then feed a verified update to the breaker." />
            <Text label="Window, slots" value={f.windowSlots} onChange={set('windowSlots')} inputMode="numeric" error={built.errors.windowSlots} hint="About 0.4 seconds each: 150 is a minute." />
            <Text label="Largest move inside the window, %" value={f.movePct} onChange={set('movePct')} inputMode="decimal" error={built.errors.movePct} hint="If two observations inside the window differ by more than this, the token halts." />
          </>
        ) : null}
      </div>
      <div className="max-w-sm">
        <WalletAction account={account} label="Create the halt state" path="/v1/tx/init-halt-state" needs="crossCore" what="Halt states" testId="init-halt" disabled={!built.body} disabledReason={wallet ? 'Fill in the fields marked above.' : 'Connect the wallet that will be the halt authority.'} body={() => built.body} onDone={reload} />
      </div>
    </Section>
  );
}

function Controls({ baseMint, account, wallet, role, halted, corporateAction, hasBreaker, reload }: { baseMint: string; account: ReturnType<typeof useWallet>['account']; wallet: string | null; role: ReturnType<typeof roleOf>; halted: boolean; corporateAction: boolean; hasBreaker: boolean; reload: () => void }) {
  const [priceUpdate, setPriceUpdate] = useState('');
  const authority = role === 'authority';
  const may = role !== 'none';
  return (
    <Section id="controls" title="Halt, flag and resume" intro="Three people can stop a token: its issuer, a venue the issuer named, and a price that moves too far. Only a printing resume cross starts it again.">
      <p className="text-sm text-muted" data-testid="role-line">
        {role === 'authority' ? 'This wallet is the token’s halt authority.' : role === 'venue' ? 'This wallet is the token’s venue signer. It can halt, but cannot flag a corporate action.' : wallet ? 'This wallet is neither the halt authority nor the venue signer. It can copy a pause or feed a price update, which anyone may do.' : 'Connect the halt authority or the venue signer to halt the token.'}
      </p>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <WalletAction account={account} label="Halt trading" variant="secondary" path="/v1/tx/set-halt" needs="crossCore" what="Halt states" testId="set-halt" disabled={!may || halted} disabledReason={halted ? 'The token is already halted. Only a printing resume cross lifts a halt.' : 'Only the halt authority or the venue signer can halt the token.'} body={() => ({ signer: wallet, baseMint })} onDone={reload} />
          <p className="text-xs text-muted">Crosses that honour the halt stop printing and refund everyone. Nothing but a resume cross that prints lifts it.</p>
        </div>
        <div className="space-y-2">
          <WalletAction
            account={account}
            label={corporateAction ? 'Clear the corporate action' : 'Flag a corporate action'}
            variant="secondary"
            path="/v1/tx/set-corporate-action"
            needs="crossCore"
            what="Corporate-action flags"
            testId="set-corporate-action"
            disabled={!authority}
            disabledReason="Only the halt authority can flag or clear a corporate action."
            body={() => ({ signer: wallet, baseMint, flag: !corporateAction })}
            onDone={reload}
          />
          <p className="text-xs text-muted">Flag it before a split, a dividend or a change to what one token represents. Crosses that honour the flag do not print while it is up.</p>
        </div>
        <div className="space-y-2">
          <WalletAction account={account} label="Copy the token’s pause" variant="secondary" path="/v1/tx/sync-pause" needs="crossCore" what="Halt states" testId="sync-pause" connectHint="Anyone can do this. Connect a wallet to pay the fee." body={() => ({ payer: wallet, baseMint })} onDone={reload} />
          <p className="text-xs text-muted">If the token’s own issuer paused it (a Token-2022 pause), this halts crosses to match. If the pause has been lifted it records that, and the halt still waits for a resume cross.</p>
        </div>
        {hasBreaker ? (
          <div className="space-y-2" data-testid="observe">
            <Text label="Pyth price update account" value={priceUpdate} onChange={setPriceUpdate} error={priceUpdate.trim() !== '' && !isAddress(priceUpdate.trim()) ? 'This is not a Solana address.' : undefined} hint="A verified PriceUpdateV2 account for the breaker’s feed." />
            <WalletAction account={account} label="Feed it to the breaker" variant="secondary" path="/v1/tx/observe-price" needs="crossCore" what="The circuit breaker" testId="observe-price" disabled={!isAddress(priceUpdate.trim())} disabledReason="Name the price update account." connectHint="Anyone can do this. Connect a wallet to pay the fee." body={() => ({ payer: wallet, baseMint, priceUpdate: priceUpdate.trim() })} onDone={reload} />
          </div>
        ) : null}
      </div>
      <div className="rounded-lg border border-border p-4 text-sm" data-testid="resume-howto">
        <p className="font-medium">To resume trading</p>
        <p className="mt-1 text-muted">Open a cross for this token from the wallet that is the halt authority or the venue signer, switch on “this is a resume cross” in its rules, and let it print. A cross from any other wallet cannot lift the halt. {halted ? 'The token is halted now.' : 'The token is not halted now.'}</p>
        <p className="mt-2">
          <Link href="/issue" className="underline underline-offset-4">
            Open a resume cross
          </Link>
        </p>
      </div>
    </Section>
  );
}

function Feed({ baseMint, account, wallet, feed, reload }: { baseMint: string; account: ReturnType<typeof useWallet>['account']; wallet: string | null; feed: FeedRead | null; reload: () => void }) {
  const exists = Boolean(feed?.feed);
  const [quoteMint, setQuoteMint] = useState('');
  const [publishers, setPublishers] = useState(wallet ?? '');
  const [minMatched, setMinMatched] = useState('');
  const [decimals, setDecimals] = useState<number | null>(null);
  useEffect(() => {
    let live = true;
    void readMintFull(baseMint).then((m) => live && setDecimals(m.ok ? m.decimals : null));
    return () => {
      live = false;
    };
  }, [baseMint]);
  useEffect(() => {
    if (feed?.publishers && feed.publishers.length > 0) setPublishers(feed.publishers.join('\n'));
  }, [feed?.publishers]);
  // An update keeps the minimum the feed has unless the person changes it: leaving the box empty must not silently set it to nothing.
  useEffect(() => {
    if (feed?.feed && feed.minMatched !== undefined && decimals !== null) setMinMatched(BigInt(feed.minMatched) === 0n ? '' : formatAtoms(BigInt(feed.minMatched), decimals));
  }, [feed?.feed, feed?.minMatched, decimals]);
  const pub = parsePublishers(publishers);
  const min = minMatched.trim() === '' ? { ok: true as const, atoms: '0' } : atomsOf(minMatched, decimals, 'The minimum');
  const isAuthority = Boolean(feed?.authority) && feed?.authority === wallet;
  const quoteOk = isAddress(quoteMint.trim());
  return (
    <Section id="feed-admin" title={exists ? 'Update the print feed' : 'Create a lender print feed'} intro="Lenders that accept the token as collateral can read the price at which it last traded in a resume cross. You name up to four wallets that may publish a print and the smallest volume that counts.">
      <div className="grid gap-4 sm:grid-cols-2" data-testid="feed-form">
        {!exists ? <Text label="Quote token" value={quoteMint} onChange={setQuoteMint} error={quoteMint.trim() !== '' && !quoteOk ? 'This is not a Solana address.' : undefined} hint="The token prices are quoted in." /> : null}
        <Text label="Smallest volume that counts, in tokens" value={minMatched} onChange={setMinMatched} inputMode="decimal" error={!min.ok ? min.error : undefined} hint="Empty: any volume." />
        <div className="sm:col-span-2 text-sm">
          <label className="block">
            <span className="text-muted">Publishers (one wallet per line, up to four)</span>
            <textarea value={publishers} onChange={(e) => setPublishers(e.target.value)} rows={3} spellCheck={false} aria-invalid={!pub.ok} className="mt-1 w-full rounded-lg border border-border-strong bg-bg px-3 py-2.5 font-mono text-sm" />
          </label>
          {!pub.ok ? <span className="mt-1 block text-xs text-accent-text">{pub.error}</span> : null}
        </div>
      </div>
      <div className="max-w-sm">
        <WalletAction
          account={account}
          label={exists ? 'Update the publishers' : 'Create the feed'}
          variant="secondary"
          path={exists ? '/v1/tx/set-feed-publishers' : '/v1/tx/init-print-feed'}
          needs="crossCore"
          what="The lender print feed"
          testId={exists ? 'set-feed-publishers' : 'init-print-feed'}
          disabled={!pub.ok || !min.ok || (!exists && !quoteOk) || (exists && !isAuthority)}
          disabledReason={exists && !isAuthority ? 'Only the feed’s authority can change its publishers.' : 'Fill in the fields marked above.'}
          body={() => ({ authority: wallet, baseMint, ...(exists ? {} : { quoteMint: quoteMint.trim() }), publishers: pub.ok ? pub.list : [], minMatched: min.ok ? min.atoms : '0' })}
          onDone={reload}
        />
      </div>
    </Section>
  );
}
