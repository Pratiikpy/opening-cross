'use client';

import Link from 'next/link';
import { FeatureNotice, Failed, Loading, Plain } from '@/components/w4/ui';
import { type BasketsRead, SHARE_DECIMALS } from '@/lib/baskets';
import { useRead } from '@/lib/use-read';
import { formatAtoms, shortAddress } from '@/lib/units';

/** Every basket the index knows, with how many shares are outstanding. */
export function BasketIndex() {
  const read = useRead<BasketsRead>('/v1/baskets');
  return (
    <div className="space-y-6">
      <FeatureNotice feature="baskets" what="Basket tokens" />
      <p className="text-sm">
        <Link href="/baskets/new" className="underline underline-offset-4" data-testid="new-link">
          Create a basket
        </Link>
      </p>
      {read.phase === 'loading' ? <Loading what="the baskets" /> : null}
      {read.phase === 'error' ? <Failed>The baskets could not be read: {read.error}</Failed> : null}
      {read.phase === 'ok' && read.data.baskets.length === 0 ? <Plain testId="no-baskets">{read.data.note ?? 'No basket has been created on this network yet.'}</Plain> : null}
      {read.phase === 'ok' && read.data.baskets.length > 0 ? (
        <ul className="grid gap-4 sm:grid-cols-2" data-testid="baskets">
          {read.data.baskets.map((b) => (
            <li key={b.basket} className="rounded-[var(--radius-card)] border border-border p-5 text-sm" data-testid={`basket-${b.basket}`}>
              <Link href={`/baskets/${b.basket}`} className="font-mono text-base underline underline-offset-4">
                {shortAddress(b.basket)}
              </Link>
              <p className="mt-2 text-muted">
                {b.components.length} component{b.components.length === 1 ? '' : 's'}; created by {shortAddress(b.creator)}.
              </p>
              <p className="mt-1">{formatAtoms(BigInt(b.outstanding), SHARE_DECIMALS)} shares outstanding</p>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
