'use client';

import Link from 'next/link';
import { FeatureNotice, Failed, Loading, Plain } from '@/components/w4/ui';
import { type PoliciesRead, ageText, bpsPct } from '@/lib/backing';
import { useRead } from '@/lib/use-read';
import { shortAddress } from '@/lib/units';

/** Every token that opted in, with the age of its last statement. */
export function BackingIndex() {
  const read = useRead<PoliciesRead>('/v1/backing/policies');
  const now = Math.floor(Date.now() / 1000);
  return (
    <div className="space-y-6">
      <FeatureNotice feature="backing" what="Automatic pause on missing backing" />
      {read.phase === 'loading' ? <Loading what="the policies" /> : null}
      {read.phase === 'error' ? <Failed>The policies could not be read: {read.error}</Failed> : null}
      {read.phase === 'ok' && read.data.policies.length === 0 ? <Plain testId="no-policies">{read.data.note ?? 'No token has opted in on this network yet.'}</Plain> : null}
      {read.phase === 'ok' && read.data.policies.length > 0 ? (
        <ul className="grid gap-4 sm:grid-cols-2" data-testid="policies">
          {read.data.policies.map((p) => (
            <li key={p.policy} className="rounded-[var(--radius-card)] border border-border p-5 text-sm" data-testid={`policy-${p.mint}`}>
              <Link href={`/backing/${p.mint}`} className="font-mono text-base underline underline-offset-4">
                {shortAddress(p.mint)}
              </Link>
              <p className="mt-2 text-muted">
                Commits to {bpsPct(p.minCoverageBps)} of the live supply, statements no older than {ageText(p.maxAgeSecs)}. Attester {shortAddress(p.attester)}.
              </p>
              <p className="mt-1">{p.lastPostedTs === null ? 'No statement posted.' : `Last statement ${ageText(now - p.lastPostedTs)} ago.`}</p>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
