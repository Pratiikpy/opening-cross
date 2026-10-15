import type { Metadata } from 'next';
import { PageHead } from '@/components/issuer/issuer-shell';
import { BackingConsole } from '@/components/issuer/backing-console';

export const metadata: Metadata = { title: 'Backing policy', description: 'Opt a token in to the backing watchdog and post the attester’s statements.' };

export default function Page() {
  return (
    <>
      <PageHead title="Backing policy" intro={<p>For a token that claims to be backed by something: name the attester you trust, commit to a coverage and a freshness, and the token halts by itself if the statement goes missing, stale or short. The attester posts its statements here.</p>} />
      <BackingConsole />
    </>
  );
}
