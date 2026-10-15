'use client';

import Link from 'next/link';
import { FeatureNotice, Failed, Loading, Plain } from '@/components/w4/ui';
import { type BountiesRead, covered, expiryText, poolOf, who } from '@/lib/bounty';
import { useRead } from '@/lib/use-read';
import { useMint } from '@/lib/use-read';
import { formatAtoms } from '@/lib/units';

function Pool({ rewardMint, pool }: { rewardMint: string; pool: bigint }) {
  const m = useMint(rewardMint);
  return <>{m.info ? `${formatAtoms(pool, m.info.decimals)} ${m.info.symbol ?? 'reward tokens'}` : `${pool} atoms`}</>;
}

/** Every bounty the index knows: the pool, the invariants it pays for and how long it is committed. */
export function BountyIndex() {
  const read = useRead<BountiesRead>('/v1/bounties');
  const now = Math.floor(Date.now() / 1000);
  return (
    <div className="space-y-6">
      <FeatureNotice feature="bounty" what="The adversarial bounty" />
      <p className="text-sm">
        <Link href="/bounties/new" className="underline underline-offset-4" data-testid="post-link">
          Post a bounty
        </Link>
      </p>
      {read.phase === 'loading' ? <Loading what="the bounties" /> : null}
      {read.phase === 'error' ? <Failed>The bounties could not be read: {read.error}</Failed> : null}
      {read.phase === 'ok' && read.data.bounties.length === 0 ? <Plain testId="no-bounties">{read.data.note ?? 'No bounty has been posted on this network yet.'}</Plain> : null}
      {read.phase === 'ok' && read.data.bounties.length > 0 ? (
        <ul className="grid gap-4 sm:grid-cols-2" data-testid="bounties">
          {read.data.bounties.map((b) => (
            <li key={b.bounty} className="rounded-[var(--radius-card)] border border-border p-5 text-sm" data-testid={`bounty-${b.bounty}`}>
              <Link href={`/bounties/${b.bounty}`} className="font-mono text-base underline underline-offset-4">
                {who(b.bounty)}
              </Link>
              <p className="mt-2">
                Pool <Pool rewardMint={b.rewardMint} pool={poolOf(b)} />
              </p>
              <p className="mt-1 text-muted">
                Pays for {covered(b.rewards)} of 11 invariants. Sponsor {who(b.sponsor)}; it {expiryText(b.expiresAt, now)}.
              </p>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
