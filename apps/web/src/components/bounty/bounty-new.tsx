'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { Text } from '@/components/issue-wizard/fields';
import { Section } from '@/components/issuer/treasury-ui';
import { FeatureAction, FeatureNotice } from '@/components/w4/ui';
import { BOUNTY_INVARIANT_NAMES, type BountyForm, EMPTY_BOUNTY, buildBounty } from '@/lib/bounty';
import { useMint } from '@/lib/use-read';
import { useWallet } from '@/lib/wallet';

/** Posting a bounty: the reward token, the arbiter, how long the pool is committed and what each invariant pays. Funding is a separate step on the bounty's page. */
export function BountyNew() {
  const { account } = useWallet();
  const wallet = account?.address ?? null;
  const [f, setF] = useState<BountyForm>(EMPTY_BOUNTY);
  const mint = useMint(f.rewardMint.trim().length >= 32 ? f.rewardMint.trim() : null);
  const now = Math.floor(Date.now() / 1000);
  const built = useMemo(() => buildBounty(f, wallet, mint.info?.decimals ?? null, now), [f, wallet, mint.info, now]);
  const [made, setMade] = useState<string | null>(null);
  const setReward = (i: number, v: string) => setF((x) => ({ ...x, rewards: x.rewards.map((r, j) => (j === i ? v : r)) }));
  return (
    <div className="space-y-6">
      <FeatureNotice feature="bounty" what="The adversarial bounty" />
      <Section id="terms" title="Terms" intro={<p>Everything here is fixed for good. The pool is committed for at least 30 days: you cannot take it back sooner.</p>}>
        <div className="grid gap-4 sm:grid-cols-2" data-testid="bounty-form">
          <Text label="Reward token" value={f.rewardMint} onChange={(v) => setF({ ...f, rewardMint: v })} error={f.rewardMint === '' ? undefined : built.errors.rewardMint} hint={mint.info ? `${mint.info.symbol ?? 'Token'} with ${mint.info.decimals} decimals.` : mint.failed ? 'This token could not be read on this network.' : undefined} />
          <Text label="Arbiter" value={f.arbiter} onChange={(v) => setF({ ...f, arbiter: v })} error={f.arbiter === '' ? undefined : built.errors.arbiter} hint="Judges what the chain cannot check and awards from the pool, only before the expiry." />
          <Text label="Committed for, days" value={f.days} onChange={(v) => setF({ ...f, days: v })} inputMode="numeric" error={built.errors.days} hint="At least 30." />
        </div>
      </Section>
      <Section id="rewards" title="What each invariant pays" intro={<p>Eleven account-level invariants that cross_core promises never to break. Leave one empty to leave it out. Each pays once, to whoever shows a cross account that breaks it.</p>}>
        <div className="grid gap-3 sm:grid-cols-2" data-testid="reward-form">
          {BOUNTY_INVARIANT_NAMES.map((name, i) => (
            <Text key={name} label={`${i + 1}. ${name}`} value={f.rewards[i] ?? ''} onChange={(v) => setReward(i, v)} inputMode="decimal" error={built.errors.rewards[i]} />
          ))}
        </div>
        {built.errors.none && f.rewards.some((r) => r !== '') === false ? <p className="text-xs text-muted" data-testid="none-hint">{built.errors.none}</p> : null}
        <div className="max-w-sm">
          <FeatureAction feature="bounty" what="The adversarial bounty" account={account} label="Post the bounty" testId="create-bounty" path="/v1/tx/bounty-create" body={() => built.body} disabled={!built.body} disabledReason={wallet ? 'Fill in the fields marked above.' : 'Connect the wallet that sponsors the bounty.'} onBuilt={(x) => setMade(typeof x.bounty === 'string' ? x.bounty : null)} onDone={() => undefined} />
        </div>
        {made ? (
          <p className="text-sm" role="status" data-testid="made">
            Posted.{' '}
            <Link href={`/bounties/${made}`} className="font-mono underline underline-offset-4">
              Open it
            </Link>{' '}
            to fund the pool: a bounty with an empty pool pays nothing.
          </p>
        ) : null}
      </Section>
    </div>
  );
}
