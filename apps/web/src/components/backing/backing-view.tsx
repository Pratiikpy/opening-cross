'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Facts, Pill, Section } from '@/components/issuer/treasury-ui';
import { Failed, FeatureAction, FeatureNotice, Loading, Plain } from '@/components/w4/ui';
import { type BackingRead, type Badge, ageText, badgeOf, bpsPct, stamp, who } from '@/lib/backing';
import { useMint, useRead } from '@/lib/use-read';
import { formatAtoms } from '@/lib/units';
import { useWallet } from '@/lib/wallet';

const TONE = { ok: 'ok', block: 'block', warn: 'warn', info: 'info' } as const;

function useNow(): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 5_000);
    return () => clearInterval(t);
  }, []);
  return now;
}

/** The backing state of one asset: the badge, the figures behind it, and the check anyone may run. */
export function BackingView({ mint }: { mint: string }) {
  const read = useRead<BackingRead>(`/v1/assets/${mint}/backing`);
  const info = useMint(mint);
  const now = useNow();
  if (read.phase === 'loading' || read.phase === 'idle') return <Loading what="the backing" />;
  if (read.phase === 'error') return <Failed>{read.status === 400 ? `${mint} is not a token address.` : `The backing could not be read: ${read.error}`}</Failed>;
  const b = read.data;
  const decimals = info.info?.decimals ?? 6;
  const badge = badgeOf(b, decimals, now);
  return (
    <div className="space-y-6" data-testid="backing-view" data-verdict={b.verdict ?? 'none'}>
      <FeatureNotice feature="backing" what="Automatic pause on missing backing" />
      {b.release.deployed === false ? <Plain testId="backing-note">{b.note}</Plain> : null}
      <BadgeBox badge={badge} />
      {b.optedIn && b.policy ? (
        <Section id="figures" title="What the chain holds" intro={<p>The policy, the latest statement and the live supply. The chain proves a statement exists, is fresh, covers the supply and was signed by the named key. It proves nothing about what a custodian holds.</p>}>
          <Facts
            rows={[
              ['Attester', who(b.policy.attester)],
              ['Coverage committed', bpsPct(b.policy.minCoverageBps)],
              ['Longest age of a statement', ageText(Number(b.policy.maxAgeSecs))],
              ['Live supply', b.supply === null ? 'unknown' : formatAtoms(BigInt(b.supply), decimals)],
              ['Backing required now', b.required == null ? 'unknown' : formatAtoms(BigInt(b.required), decimals)],
              ['Latest statement', b.attestation ? `${formatAtoms(BigInt(b.attestation.backingAtoms), decimals)}, posted ${stamp(b.attestation.postedTs)}` : 'none yet'],
            ]}
          />
          <Check b={b} mint={mint} reload={read.reload} />
        </Section>
      ) : null}
      <p className="text-sm text-muted">
        Halt state of this token: <Link href={`/halts/${mint}`} className="underline underline-offset-4">/halts/{who(mint)}</Link>. If you issue it,{' '}
        <Link href={`/issuer/backing?mint=${mint}`} className="underline underline-offset-4">
          manage its backing policy
        </Link>
        .
      </p>
    </div>
  );
}

export function BadgeBox({ badge }: { badge: Badge }) {
  return (
    <div className={`rounded-[var(--radius-card)] border p-5 ${badge.tone === 'block' ? 'border-accent' : badge.tone === 'ok' ? 'border-positive' : 'border-border'}`} data-testid="backing-badge" data-tone={badge.tone}>
      <p className="flex items-center gap-2 text-lg font-semibold">
        <Pill tone={TONE[badge.tone]}>{badge.title}</Pill>
      </p>
      {badge.lines.map((l) => (
        <p key={l} className="mt-2 text-sm text-muted">
          {l}
        </p>
      ))}
    </div>
  );
}

function Check({ b, mint, reload }: { b: BackingRead; mint: string; reload: () => void }) {
  const { account } = useWallet();
  const wallet = account?.address ?? null;
  const halted = b.halt?.halted === true;
  const ok = b.verdict === 'Backed';
  const off = ok ? 'The backing is fresh and covers the live supply, so a check would change nothing: the program refuses it.' : halted ? 'The asset is already halted. Only a printing resume cross lifts a halt.' : undefined;
  return (
    <div className="space-y-2" data-testid="check-box">
      <p className="text-sm text-muted">Anyone can run the check. It halts the asset through the halt machinery of cross_core when the statement is missing, stale or short, and refuses when the backing is fine.</p>
      <div className="max-w-sm">
        <FeatureAction feature="backing" what="Automatic pause on missing backing" account={account} label="Run the check" testId="backing-check" variant="secondary" path="/v1/tx/backing-check" body={() => ({ payer: wallet, mint })} disabled={Boolean(off)} disabledReason={off} onDone={reload} connectHint="Connect any wallet: anyone can run the check." />
      </div>
    </div>
  );
}
