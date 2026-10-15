'use client';

import { isAddress } from '@solana/kit';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { Text } from '@/components/issue-wizard/fields';
import { Pill, Section } from '@/components/issuer/treasury-ui';
import { Failed, FeatureAction, FeatureNotice, Loading, Plain, when } from '@/components/w4/ui';
import { type ConvictionRead, EMPTY_LOCK, type LockForm, type LockRow, type MintStats, buildLock, nextStepOf, timeLeft, tokenDays } from '@/lib/conviction';
import { readHeld } from '@/lib/series-load';
import { useMint, useRead } from '@/lib/use-read';
import { formatAtoms, shortAddress } from '@/lib/units';
import { useWallet } from '@/lib/wallet';

const WHAT = 'Conviction locks and badges';
const TONE = { locked: 'info', unlockable: 'ok', unlocked: 'warn' } as const;

/** A holder's locks and soulbound badges, the form that makes a lock, and what is locked behind any token. */
export function ConvictionView() {
  const { account } = useWallet();
  const wallet = account?.address ?? null;
  const read = useRead<ConvictionRead>(wallet ? `/v1/owners/${wallet}/conviction` : null);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="space-y-6">
      <FeatureNotice feature="conviction" what={WHAT} />
      <Plain testId="conviction-promise">
        A lock is a promise with no exit. Nothing moves your tokens before the unlock time: not you, and not the program. Afterwards you take them back and can mint a badge for the time you held through. The badge is a credential in your wallet that cannot be sent to anyone else. It is not points, a tier or a payout.
      </Plain>
      <LockForm onDone={() => read.reload()} />
      <Section id="locks" title="Your locks" intro={<p>Every lock this wallet made, and what it can do next.</p>}>
        {!wallet ? <Plain testId="connect-hint">Connect a wallet to see your locks and badges.</Plain> : null}
        {read.phase === 'loading' ? <Loading what="your locks" /> : null}
        {read.phase === 'error' ? <Failed>Your locks could not be read: {read.error}</Failed> : null}
        {read.phase === 'ok' && read.data.locks.length === 0 ? <Plain testId="no-locks">{read.data.note ?? 'This wallet has made no lock on this network.'}</Plain> : null}
        {read.phase === 'ok' && read.data.locks.length > 0 ? (
          <ul className="space-y-3" data-testid="locks">
            {read.data.locks.map((l) => (
              <Lock key={l.lock} l={l} now={now} reload={read.reload} />
            ))}
          </ul>
        ) : null}
      </Section>
      {read.phase === 'ok' ? <Badges badges={read.data.badges} /> : null}
      <Lookup />
    </div>
  );
}

function LockForm({ onDone }: { onDone: () => void }) {
  const { account } = useWallet();
  const wallet = account?.address ?? null;
  const [f, setF] = useState<LockForm>(EMPTY_LOCK);
  const mint = useMint(isAddress(f.mint.trim()) ? f.mint.trim() : null);
  const [held, setHeld] = useState<bigint | null>(null);
  useEffect(() => {
    if (!wallet || !mint.info) {
      setHeld(null);
      return;
    }
    let live = true;
    void readHeld(wallet, f.mint.trim(), mint.info.program).then((r) => live && setHeld(r.ok ? r.amount : null));
    return () => {
      live = false;
    };
  }, [wallet, mint.info, f.mint]);
  const now = Math.floor(Date.now() / 1000);
  const built = useMemo(() => buildLock(f, wallet, mint.info?.decimals ?? null, held, now), [f, wallet, mint.info, held, now]);
  const d = mint.info?.decimals ?? null;
  return (
    <Section id="lock" title="Lock tokens" intro={<p>Choose a token you hold, how much and for how long. A lock lasts one day to a little under four years.</p>}>
      <div className="grid gap-4 sm:grid-cols-3" data-testid="lock-form">
        <Text label="Token" value={f.mint} onChange={(v) => setF({ ...f, mint: v })} error={f.mint === '' ? undefined : built.errors.mint} hint={mint.info ? `${mint.info.symbol ?? 'Token'} with ${mint.info.decimals} decimals${held !== null && d !== null ? `; you hold ${formatAtoms(held, d)}` : ''}.` : mint.failed ? 'This token could not be read on this network.' : undefined} />
        <Text label="Amount" value={f.amount} onChange={(v) => setF({ ...f, amount: v })} inputMode="decimal" error={f.amount === '' ? undefined : built.errors.amount} />
        <Text label="Lock for, days" value={f.days} onChange={(v) => setF({ ...f, days: v })} inputMode="numeric" error={built.errors.days} />
      </div>
      {built.days !== null ? (
        <p className="text-sm text-muted" data-testid="badge-preview">
          {built.days > 0n ? `This lock earns a badge of ${built.days.toString()} token-day${built.days === 1n ? '' : 's'}: amount times days, rounded down to whole token-days.` : 'This lock is too small to earn one token-day, so it earns no badge. The tokens still come back.'}
        </p>
      ) : null}
      <div className="max-w-sm">
        <FeatureAction feature="conviction" what={WHAT} account={account} label="Lock the tokens" testId="lock-tokens" path="/v1/tx/conviction-lock" body={() => built.body} disabled={!built.body} disabledReason={wallet ? 'Fill in the fields marked above.' : 'Connect the wallet that holds the token.'} onDone={onDone} />
      </div>
      <p className="text-xs text-muted">Once sent, there is no instruction that returns these tokens early. The program&apos;s upgrade authority could in principle replace the code, as with every program here.</p>
    </Section>
  );
}

function Lock({ l, now, reload }: { l: LockRow; now: number; reload: () => void }) {
  const { account } = useWallet();
  const wallet = account?.address ?? null;
  const mint = useMint(l.mint);
  const d = mint.info?.decimals ?? null;
  const earned = d === null ? null : tokenDays(BigInt(l.amount), l.unlockTs - l.lockedAt, d);
  const state = l.state === 'locked' && now >= l.unlockTs ? 'unlockable' : l.state;
  const step = nextStepOf({ ...l, state }, earned);
  const body = () => ({ holder: wallet, lock: l.lock });
  return (
    <li className="space-y-3 rounded-lg border border-border p-4 text-sm" data-testid={`lock-${l.lock}`} data-state={state} data-step={step}>
      <p className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{d === null ? l.amount : formatAtoms(BigInt(l.amount), d)} {mint.info?.symbol ?? shortAddress(l.mint)}</span>
        <Pill tone={TONE[state]}>{state === 'locked' ? `Locked, ${timeLeft(l.unlockTs, now)} left` : state === 'unlockable' ? 'Ready to take back' : 'Tokens returned'}</Pill>
        {l.badgeClaimed ? <Pill tone="ok">Badge minted</Pill> : null}
      </p>
      <p className="text-muted">
        Locked {when(l.lockedAt)} until {when(l.unlockTs)}.{' '}
        {l.badgeClaimed ? `The badge counts ${l.tokenDays ?? earned?.toString() ?? '?'} token-days.` : earned === null ? '' : earned > 0n ? `It earns a badge of ${earned.toString()} token-days.` : 'It is too small to earn a badge.'}
      </p>
      {state === 'locked' ? <p className="text-muted" data-testid={`wait-${l.lock}`}>Nothing can be done with this lock until the time has run. It cannot be ended early.</p> : null}
      <div className="grid gap-3 sm:grid-cols-3">
        {state === 'unlockable' ? <FeatureAction feature="conviction" what={WHAT} account={account} label="Take the tokens back" testId={`unlock-${l.lock}`} path="/v1/tx/conviction-unlock" body={body} onDone={reload} /> : null}
        {state !== 'locked' && !l.badgeClaimed && earned !== null && earned > 0n ? <FeatureAction feature="conviction" what={WHAT} account={account} label="Mint the badge" testId={`claim-${l.lock}`} variant="secondary" path="/v1/tx/conviction-claim-badge" body={body} onDone={reload} /> : null}
        {state === 'unlocked' && l.badgeClaimed ? <FeatureAction feature="conviction" what={WHAT} account={account} label="Close the lock" testId={`close-${l.lock}`} variant="secondary" path="/v1/tx/conviction-close-lock" body={body} onDone={reload} /> : null}
      </div>
    </li>
  );
}

function Badges({ badges }: { badges: ConvictionRead['badges'] }) {
  return (
    <Section id="badges" title="Your conviction badges" intro={<p>One badge token per token you locked, adding up across locks. It cannot be sent: the token program refuses a transfer.</p>}>
      {badges.length === 0 ? <Plain testId="no-badges">No badge yet. Mint one after a lock has run.</Plain> : null}
      {badges.length > 0 ? (
        <ul className="space-y-2 text-sm" data-testid="badges">
          {badges.map((b) => (
            <li key={b.badgeMint} className="rounded-lg border border-border px-3 py-2" data-testid={`badge-${b.mint}`}>
              Conviction in <span className="font-mono">{shortAddress(b.mint)}</span>: {b.tokenDays ?? 'not read'} token-days. Non-transferable.
            </li>
          ))}
        </ul>
      ) : null}
    </Section>
  );
}

function Lookup() {
  const [mint, setMint] = useState('');
  const ok = isAddress(mint.trim());
  const stats = useRead<MintStats>(ok ? `/v1/conviction/mints/${mint.trim()}` : null);
  const info = useMint(ok ? mint.trim() : null);
  const d = info.info?.decimals ?? null;
  return (
    <Section id="lookup" title="What is locked behind a token" intro={<p>Locked amounts and badge token-days across every holder of a token, as the index saw them.</p>}>
      <Text label="Token" value={mint} onChange={setMint} error={mint.trim() !== '' && !ok ? 'This is not a Solana address.' : undefined} />
      {stats.phase === 'ok' ? (
        <p className="text-sm" data-testid="mint-stats">
          {stats.data.locks} lock{stats.data.locks === 1 ? '' : 's'} by {stats.data.holders} holder{stats.data.holders === 1 ? '' : 's'}; {d === null ? stats.data.locked : formatAtoms(BigInt(stats.data.locked), d)} locked now; {stats.data.tokenDaysClaimed} token-days of badges minted.
        </p>
      ) : null}
      <p className="text-xs text-muted">
        Prefer a different view of a token? <Link href="/markets" className="underline underline-offset-4">Markets</Link>.
      </p>
    </Section>
  );
}
