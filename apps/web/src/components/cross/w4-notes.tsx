'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { type BackingRead, badgeOf } from '@/lib/backing';
import { type ListingRow, type ListingsRead, type VenueRead, statusLine } from '@/lib/listing';
import type { CrossDetail } from '@/lib/types';
import { useMint, useRead } from '@/lib/use-read';
import { formatAtoms, shortAddress } from '@/lib/units';

/**
 * Two facts about a cross that the seven Wave 3D programs add, shown above the tabs so they are not missed: which venues listed it against a bond, and
 * whether its token carries a backing policy that is failing. Both are read from the API; a cluster without the programs has nothing to show, and nothing is.
 */
export function Wave3dNotes({ cross }: { cross: CrossDetail }) {
  return (
    <div className="mt-4 space-y-3" data-testid="wave3d-notes">
      <ListingBadges cross={cross.address} />
      {cross.baseMint ? <BackingNote mint={cross.baseMint} /> : null}
    </div>
  );
}

function ListingBadges({ cross }: { cross: string }) {
  const read = useRead<ListingsRead>(`/v1/crosses/${cross}/listings`);
  if (read.phase !== 'ok' || read.data.listings.length === 0) return null;
  return (
    <ul className="space-y-2" data-testid="listing-badges">
      {read.data.listings.map((l) => (
        <ListingBadge key={l.listing} l={l} />
      ))}
    </ul>
  );
}

function ListingBadge({ l }: { l: ListingRow }) {
  const venue = useRead<VenueRead>(`/v1/listing/venues/${l.venue}`);
  const mint = useMint(venue.phase === 'ok' ? venue.data.bondMint : null);
  const bond = mint.info ? `${formatAtoms(BigInt(l.amount), mint.info.decimals)} ${mint.info.symbol ?? 'bond tokens'}` : `${l.amount} bond atoms`;
  const tone = l.status === 'slashed' ? 'border-accent' : 'border-border';
  return (
    <li className={`rounded-[var(--radius-card)] border px-4 py-3 text-sm ${tone}`} data-testid={`listing-badge-${l.status}`} data-venue={l.venue}>
      <span className="font-medium">{l.status === 'open' ? 'Listed with a bond at stake' : l.status === 'released' ? 'Listed: the bond was released' : 'Listed: the bond was slashed'}</span>{' '}
      on venue{' '}
      <Link href={`/listing/${l.venue}`} className="font-mono underline underline-offset-4">
        {shortAddress(l.venue)}
      </Link>{' '}
      by {shortAddress(l.lister)}. <span className="text-muted">{statusLine(l, bond)}</span>
    </li>
  );
}

function BackingNote({ mint }: { mint: string }) {
  const read = useRead<BackingRead>(`/v1/assets/${mint}/backing`);
  const info = useMint(mint);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 10_000);
    return () => clearInterval(t);
  }, []);
  if (read.phase !== 'ok' || !read.data.optedIn) return null;
  const b = read.data;
  const badge = badgeOf(b, info.info?.decimals ?? 6, now);
  const backed = b.verdict === 'Backed';
  return (
    <div role="status" className={`rounded-[var(--radius-card)] border px-4 py-3 text-sm ${backed ? 'border-positive' : 'border-accent'}`} data-testid={backed ? 'backing-badge-ok' : 'backing-banner'} data-verdict={b.verdict ?? 'none'}>
      <p>
        <span className="font-medium">{backed ? 'Backed' : badge.title}.</span> {badge.lines[0]}{' '}
        <Link href={`/backing/${mint}`} className="underline underline-offset-4">
          The backing policy
        </Link>
      </p>
      {!backed && b.halt?.halted ? <p className="mt-1 text-muted">Trading in this token is halted for this reason; a cross that honours the halt will not print while it lasts.</p> : null}
    </div>
  );
}
