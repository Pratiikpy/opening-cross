'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { Text } from '@/components/issue-wizard/fields';
import { FeatureAction, FeatureNotice, Loading, Plain } from '@/components/w4/ui';
import { EMPTY_VENUE, type VenueForm, type VenuesRead, buildVenue, days } from '@/lib/listing';
import { useMint, useRead } from '@/lib/use-read';
import { formatAtoms, shortAddress } from '@/lib/units';
import { useWallet } from '@/lib/wallet';
import { Section } from './treasury-ui';

/** Creating a listing venue, and the venues this wallet runs. */
export function ListingConsole() {
  const { account } = useWallet();
  const wallet = account?.address ?? null;
  const [f, setF] = useState<VenueForm>(EMPTY_VENUE);
  const set = <K extends keyof VenueForm>(k: K) => (v: VenueForm[K]) => setF((x) => ({ ...x, [k]: v }));
  const mint = useMint(f.bondMint.trim().length >= 32 ? f.bondMint.trim() : null);
  const built = useMemo(() => buildVenue(f, wallet, mint.info?.decimals ?? null), [f, wallet, mint.info]);
  const mine = useRead<VenuesRead>(wallet ? `/v1/listing/venues?creator=${wallet}` : null);
  const shown = (k: keyof VenueForm) => (f[k] === '' ? undefined : built.errors[k]);
  return (
    <div className="mt-8 space-y-6">
      <FeatureNotice feature="listing" what="Stake-bonded listing" />
      <Section id="create" title="Create a venue" intro={<p>Everything below is fixed for good. Slashed bonds go to the account you name; the conditions for a slash are objective, so a venue cannot create one.</p>}>
        <div className="grid gap-4 sm:grid-cols-2" data-testid="venue-form">
          <Text label="Bond token" value={f.bondMint} onChange={set('bondMint')} error={shown('bondMint')} hint={mint.info ? `${mint.info.symbol ?? 'Token'} with ${mint.info.decimals} decimals.` : mint.failed ? 'This token could not be read on this network.' : undefined} />
          <Text label="Bond one listing sets aside" value={f.minBond} onChange={set('minBond')} inputMode="decimal" error={shown('minBond')} />
          <Text label="Release delay, days" value={f.delayDays} onChange={set('delayDays')} inputMode="numeric" error={built.errors.delayDays} hint="After a cross closes. At least one day." />
          <Text label="Slashed bonds go to (optional)" value={f.slashTo} onChange={set('slashTo')} error={built.errors.slashTo} hint="Empty: your own wallet." />
        </div>
        <div className="max-w-sm">
          <FeatureAction feature="listing" what="Stake-bonded listing" account={account} label="Create the venue" testId="create-venue" path="/v1/tx/listing-create-venue" body={() => built.body} disabled={!built.body} disabledReason={wallet ? 'Fill in the fields marked above.' : 'Connect the wallet that will run the venue.'} onDone={() => mine.reload()} />
        </div>
      </Section>
      <Section id="mine" title="Venues you run" intro={<p>Listers bond and list on each venue&apos;s own page.</p>}>
        {!wallet ? <Plain testId="connect-hint">Connect a wallet to see the venues it runs.</Plain> : null}
        {mine.phase === 'loading' ? <Loading what="your venues" /> : null}
        {mine.phase === 'ok' && mine.data.venues.length === 0 ? <Plain testId="no-mine">This wallet runs no venue.</Plain> : null}
        {mine.phase === 'ok' && mine.data.venues.length > 0 ? (
          <ul className="space-y-2 text-sm" data-testid="my-venues">
            {mine.data.venues.map((v) => (
              <li key={v.venue}>
                <Link href={`/listing/${v.venue}`} className="font-mono underline underline-offset-4">
                  {shortAddress(v.venue)}
                </Link>{' '}
                · bond {formatAtoms(BigInt(v.minBond), mint.info?.decimals ?? 6)} · released {days(v.releaseDelaySecs)} after close · {v.openListings} open of {v.listings} listings
              </li>
            ))}
          </ul>
        ) : null}
      </Section>
    </div>
  );
}
