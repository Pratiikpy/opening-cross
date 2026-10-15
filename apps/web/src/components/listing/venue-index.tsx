'use client';

import Link from 'next/link';
import { FeatureNotice, Failed, Loading, Plain } from '@/components/w4/ui';
import { type VenuesRead, days } from '@/lib/listing';
import { useRead } from '@/lib/use-read';
import { shortAddress } from '@/lib/units';

/** Every listing venue the index knows: who runs it, what a listing puts at stake, and how many crosses are listed. */
export function VenueIndex() {
  const read = useRead<VenuesRead>('/v1/listing/venues');
  return (
    <div className="space-y-6">
      <FeatureNotice feature="listing" what="Stake-bonded listing" />
      {read.phase === 'loading' ? <Loading what="the venues" /> : null}
      {read.phase === 'error' ? <Failed>The venues could not be read: {read.error}</Failed> : null}
      {read.phase === 'ok' && read.data.venues.length === 0 ? <Plain testId="no-venues">{read.data.note ?? 'No venue has been created on this network yet.'}</Plain> : null}
      {read.phase === 'ok' && read.data.venues.length > 0 ? (
        <ul className="grid gap-4 sm:grid-cols-2" data-testid="venues">
          {read.data.venues.map((v) => (
            <li key={v.venue} className="rounded-[var(--radius-card)] border border-border p-5 text-sm" data-testid={`venue-${v.venue}`}>
              <Link href={`/listing/${v.venue}`} className="font-mono text-base underline underline-offset-4">
                {shortAddress(v.venue)}
              </Link>
              <p className="mt-2 text-muted">
                Run by {shortAddress(v.creator)}. Bond token {shortAddress(v.bondMint)}; released {days(v.releaseDelaySecs)} after a cross closes.
              </p>
              <p className="mt-1">
                {v.openListings} open listing{v.openListings === 1 ? '' : 's'} of {v.listings}
              </p>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
