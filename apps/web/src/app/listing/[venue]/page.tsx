import type { Metadata } from 'next';
import { VenueView } from '@/components/listing/venue-view';
import { PublicPage } from '@/components/w4/ui';

type Params = { params: Promise<{ venue: string }> };
export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { venue } = await params;
  return { title: `Listing venue ${venue.slice(0, 6)}`, description: 'The terms of a listing venue, your bond on it and the crosses listed there.' };
}

export default async function Page({ params }: Params) {
  const { venue } = await params;
  return (
    <PublicPage title="Listing venue" trail={[{ href: '/listing', label: 'Venues' }]} intro={<p>The terms below were fixed when the venue was created and never change.</p>}>
      <VenueView venue={venue} />
    </PublicPage>
  );
}
