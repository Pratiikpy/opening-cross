import type { Metadata } from 'next';
import { PageHead } from '@/components/issuer/issuer-shell';
import { ListingConsole } from '@/components/issuer/listing-console';

export const metadata: Metadata = { title: 'Run a listing venue', description: 'Create a listing venue: the bond a listing sets aside, the release delay and where slashed bonds go.' };

export default function Page() {
  return (
    <>
      <PageHead title="Run a listing venue" intro={<p>A venue fixes its terms for good: the token of the bond, how much one listing sets aside, how long after a cross closes the bond is released, and who receives a slashed bond. Listers then bond and list crosses on its page.</p>} />
      <ListingConsole />
    </>
  );
}
