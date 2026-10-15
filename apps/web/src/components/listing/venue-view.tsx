'use client';

import { isAddress } from '@solana/kit';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { SmallButton, Text } from '@/components/issue-wizard/fields';
import { Facts, Pill, Section } from '@/components/issuer/treasury-ui';
import { Failed, FeatureAction, FeatureNotice, Loading, Plain, when } from '@/components/w4/ui';
import { type ListingDetail, type ListingRow, type ListingsRead, NEXT_LABEL, type VenueRead, type VenuesRead, atomsText, bondLine, days, statusLine } from '@/lib/listing';
import { crossSummary, type CrossRow } from '@/lib/issuer-data';
import { useMint, useRead } from '@/lib/use-read';
import { formatAtoms, shortAddress } from '@/lib/units';
import { useWallet } from '@/lib/wallet';

const WHAT = 'Stake-bonded listing';

/** One venue: its terms, your bond on it, the crosses listed on it, and release or slash for any listing that is ready. */
export function VenueView({ venue }: { venue: string }) {
  // The index is asked first: a venue that is not in it (or a network without the program) is said in words, not provoked as a 404 the browser logs as an error.
  const index = useRead<VenuesRead>('/v1/listing/venues?limit=200');
  if (index.phase === 'loading' || index.phase === 'idle') return <Loading what="the venue" />;
  if (index.phase === 'ok') {
    if (index.data.release.deployed === false) {
      return (
        <div className="space-y-4">
          <FeatureNotice feature="listing" what={WHAT} />
          <Plain testId="venue-not-deployed">{index.data.note ?? 'cross_listing is not deployed on this network, so there is no venue to read.'}</Plain>
        </div>
      );
    }
    if (index.data.venues.length < 200 && !index.data.venues.some((v) => v.venue === venue)) {
      return (
        <div className="space-y-4">
          <FeatureNotice feature="listing" what={WHAT} />
          <Failed testId="venue-error">No listing venue exists at {venue} on this network.</Failed>
        </div>
      );
    }
  }
  return <Venue venue={venue} />;
}

function Venue({ venue }: { venue: string }) {
  const { account } = useWallet();
  const wallet = account?.address ?? null;
  const read = useRead<VenueRead>(`/v1/listing/venues/${venue}${wallet ? `?lister=${wallet}` : ''}`);
  const listings = useRead<ListingsRead>(`/v1/listing/venues/${venue}/listings`);
  const mint = useMint(read.phase === 'ok' ? read.data.bondMint : null);
  const reload = () => {
    read.reload();
    listings.reload();
  };
  if (read.phase === 'loading' || read.phase === 'idle') return <Loading what="the venue" />;
  if (read.phase === 'error') {
    return (
      <div className="space-y-4">
        <FeatureNotice feature="listing" what={WHAT} />
        <Failed testId="venue-error">{read.reason === 'PROGRAM_NOT_DEPLOYED' ? `This venue cannot be read: ${read.error}` : read.status === 404 ? `No listing venue exists at ${venue} on this network.` : `The venue could not be read: ${read.error}`}</Failed>
      </div>
    );
  }
  const v = read.data;
  const decimals = mint.info?.decimals ?? null;
  const symbol = mint.info?.symbol ?? 'bond tokens';
  const fmt = (a: string) => (decimals === null ? `${a} atoms` : `${formatAtoms(BigInt(a), decimals)} ${symbol}`);
  return (
    <div className="space-y-6">
      <FeatureNotice feature="listing" what={WHAT} />
      <Section id="terms" title="The venue’s terms" intro={<p>Fixed when the venue was created. They never change.</p>}>
        <Facts
          rows={[
            ['Bond a listing sets aside', fmt(v.minBond)],
            ['Release delay', `${days(v.releaseDelaySecs)} after a cross closes`],
            ['Slashed bonds go to', shortAddress(v.slashTo)],
            ['Created by', shortAddress(v.creator)],
          ]}
        />
        <p className="text-sm text-muted" data-testid="venue-rules">
          A lister keeps a bond here and lists a cross it created that is still taking orders. The bond comes back when the cross ends well; it is taken, for the venue, only when the cross fails because its settlement never happened. Buyers are refunded in full by the cross itself: the bond is the price of the failure, not their compensation. A venue does not judge a listing&apos;s quality, legality or honesty.
        </p>
      </Section>
      <Bond v={v} decimals={decimals} symbol={symbol} reload={reload} />
      <ListCross v={v} reload={reload} wallet={wallet} />
      <Section id="listings" title="Listed crosses" intro={<p>Anyone can release a bond that is due or slash one that is at fault.</p>}>
        {listings.phase === 'loading' ? <Loading what="the listings" /> : null}
        {listings.phase === 'error' ? <Failed>The listings could not be read: {listings.error}</Failed> : null}
        {listings.phase === 'ok' && listings.data.listings.length === 0 ? <Plain testId="no-listings">Nothing is listed on this venue yet.</Plain> : null}
        {listings.phase === 'ok' && listings.data.listings.length > 0 ? (
          <ul className="space-y-4" data-testid="listings">
            {listings.data.listings.map((l) => (
              <ListingItem key={l.listing} l={l} fmt={fmt} reload={reload} />
            ))}
          </ul>
        ) : null}
      </Section>
    </div>
  );
}

function Bond({ v, decimals, symbol, reload }: { v: VenueRead; decimals: number | null; symbol: string; reload: () => void }) {
  const { account } = useWallet();
  const wallet = account?.address ?? null;
  const [amount, setAmount] = useState('');
  const opened = v.bond !== undefined && v.bond.opened !== false;
  const atoms = atomsText(amount, decimals);
  const free = v.bond && v.bond.opened !== false ? BigInt(v.bond.free ?? '0') : 0n;
  const asked = amount.trim() === '' ? null : atoms === null ? `A number above zero with at most ${decimals ?? 6} decimals.` : null;
  return (
    <Section id="bond" title="Your bond" intro={<p>The bond is yours: you can take back what no open listing has set aside.</p>}>
      <p className="text-sm" data-testid="bond-line">
        {!wallet ? 'Connect a wallet to open a bond on this venue.' : decimals === null ? 'Reading the bond token…' : bondLine(v.bond, decimals, symbol)}
      </p>
      {wallet && !opened ? (
        <div className="max-w-sm">
          <FeatureAction feature="listing" what={WHAT} account={account} label="Open a bond" testId="open-bond" path="/v1/tx/listing-open-bond" body={() => ({ lister: wallet, venue: v.venue })} onDone={reload} />
        </div>
      ) : null}
      {wallet && opened ? (
        <div className="space-y-3">
          <Text label={`Amount, in ${symbol}`} value={amount} onChange={setAmount} inputMode="decimal" error={asked ?? undefined} />
          <div className="grid gap-3 sm:grid-cols-2">
            <FeatureAction feature="listing" what={WHAT} account={account} label="Deposit" testId="deposit-bond" path="/v1/tx/listing-deposit-bond" body={() => ({ lister: wallet, venue: v.venue, amount: atoms })} disabled={atoms === null} disabledReason="Enter an amount to deposit." onDone={reload} />
            <FeatureAction
              feature="listing"
              what={WHAT}
              account={account}
              label="Withdraw"
              testId="withdraw-bond"
              variant="secondary"
              path="/v1/tx/listing-withdraw-bond"
              body={() => ({ lister: wallet, venue: v.venue, ...(atoms ? { amount: atoms } : {}) })}
              disabled={free === 0n || (atoms !== null && BigInt(atoms) > free)}
              disabledReason={free === 0n ? 'Nothing is free: every part of the bond is set aside by an open listing.' : 'Only the part no open listing has set aside can be withdrawn.'}
              onDone={reload}
            />
          </div>
          <p className="text-xs text-muted">Leave the amount empty to withdraw everything that is free.</p>
        </div>
      ) : null}
    </Section>
  );
}

function ListCross({ v, reload, wallet }: { v: VenueRead; reload: () => void; wallet: string | null }) {
  const { account } = useWallet();
  const [crosses, setCrosses] = useState<CrossRow[] | null>(null);
  const [chosen, setChosen] = useState('');
  const [typed, setTyped] = useState('');
  useEffect(() => {
    let live = true;
    void crossSummary(1000).then((r) => live && setCrosses(r.ok ? r.data.crosses.filter((c) => c.creator === wallet && c.state === 'Live') : []));
    return () => {
      live = false;
    };
  }, [wallet]);
  const opened = v.bond !== undefined && v.bond.opened !== false;
  const fits = v.bond?.fitsAnother === true;
  const cross = chosen || typed.trim();
  const off = !wallet ? 'Connect the wallet that created the cross.' : !opened ? 'Open a bond first.' : !fits ? 'Your free bond is below the amount one listing sets aside. Deposit more.' : !isAddress(cross) ? 'Choose a cross or type its address.' : undefined;
  return (
    <Section id="list" title="List a cross" intro={<p>Only a cross you created that is still taking orders can be listed. The listing sets aside the venue&apos;s bond.</p>}>
      {wallet && crosses && crosses.length === 0 ? <Plain testId="no-live-crosses">This wallet has no live cross to list.</Plain> : null}
      {crosses && crosses.length > 0 ? (
        <ul className="grid gap-2 sm:grid-cols-2" data-testid="listable">
          {crosses.slice(0, 10).map((c) => (
            <li key={c.address}>
              <SmallButton testId={`pick-${c.address}`} pressed={chosen === c.address} onClick={() => setChosen(chosen === c.address ? '' : c.address)}>
                {shortAddress(c.address)} · closes {when(c.closeTs)}
              </SmallButton>
            </li>
          ))}
        </ul>
      ) : null}
      <Text label="Or a cross address" value={typed} onChange={setTyped} error={typed.trim() !== '' && !isAddress(typed.trim()) ? 'This is not a Solana address.' : undefined} />
      <div className="max-w-sm">
        <FeatureAction feature="listing" what={WHAT} account={account} label="List this cross" testId="list-cross" path="/v1/tx/listing-list-cross" body={() => ({ lister: wallet, venue: v.venue, cross })} disabled={Boolean(off)} disabledReason={off} onDone={reload} />
      </div>
    </Section>
  );
}

function ListingItem({ l, fmt, reload }: { l: ListingRow; fmt: (a: string) => string; reload: () => void }) {
  const { account } = useWallet();
  const wallet = account?.address ?? null;
  const detail = useRead<ListingDetail>(l.status === 'open' ? `/v1/listing/listings/${l.listing}` : null);
  const next = detail.phase === 'ok' ? detail.data.next : null;
  return (
    <li className="space-y-2 rounded-lg border border-border p-4 text-sm" data-testid={`listing-${l.listing}`} data-status={l.status}>
      <p className="flex flex-wrap items-center gap-2">
        <Link href={`/crosses/${l.cross}`} className="font-mono underline underline-offset-4">
          {shortAddress(l.cross)}
        </Link>
        <Pill tone={l.status === 'open' ? 'info' : l.status === 'released' ? 'ok' : 'block'}>{l.status === 'open' ? 'Bond at stake' : l.status === 'released' ? 'Bond released' : 'Bond slashed'}</Pill>
        <span className="text-muted">listed by {shortAddress(l.lister)}</span>
      </p>
      <p className="text-muted">{statusLine(l, fmt(l.amount))}</p>
      {detail.phase === 'ok' ? (
        <p className="text-muted" data-testid={`next-${l.listing}`}>
          {next ? NEXT_LABEL[next] : 'The cross could not be read.'} Releasable after {when(detail.data.releaseAfter)}.
        </p>
      ) : null}
      {l.status === 'open' && (next === 'release' || next === 'slash') ? (
        <div className="max-w-sm">
          <FeatureAction
            feature="listing"
            what={WHAT}
            account={account}
            label={next === 'release' ? 'Release the bond' : 'Slash the bond'}
            testId={next === 'release' ? 'release-listing' : 'slash-listing'}
            variant="secondary"
            path={next === 'release' ? '/v1/tx/listing-release' : '/v1/tx/listing-slash'}
            body={() => ({ payer: wallet, listing: l.listing })}
            onDone={reload}
            connectHint="Connect any wallet: anyone can send this."
          />
        </div>
      ) : null}
    </li>
  );
}
