import type { Metadata } from 'next';
import Link from 'next/link';
import { VenueIndex } from '@/components/listing/venue-index';
import { PublicPage } from '@/components/w4/ui';

export const metadata: Metadata = { title: 'Listing venues', description: 'Venues that list crosses against a bond the lister loses only if a cross fails because its settlement never happened.' };

export default function Page() {
  return (
    <PublicPage
      title="Listing venues"
      intro={
        <p>
          A venue lists crosses and holds the lister to a bond. The bond comes back when a cross ends well and is slashed only for the one fault the chain can prove without a judge: a settlement that never happened. To run a venue,{' '}
          <Link href="/issuer/listing" className="underline underline-offset-4">
            create one
          </Link>
          .
        </p>
      }
    >
      <VenueIndex />
    </PublicPage>
  );
}
