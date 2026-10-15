import type { Metadata } from 'next';
import { BackingIndex } from '@/components/backing/backing-index';
import { PublicPage } from '@/components/w4/ui';

export const metadata: Metadata = { title: 'Backing watchdog', description: 'Tokens that committed to a backing policy, and the latest statement behind each.' };

export default function Page() {
  return (
    <PublicPage title="Backing watchdog" intro={<p>Tokens whose issuers opted in to the automatic pause on missing backing. The chain enforces that a statement exists, is fresh, covers the live supply and was signed by the named key. It proves nothing about what a custodian holds.</p>}>
      <BackingIndex />
    </PublicPage>
  );
}
