import type { Metadata } from 'next';
import { BackingView } from '@/components/backing/backing-view';
import { PublicPage } from '@/components/w4/ui';

type Params = { params: Promise<{ mint: string }> };
export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { mint } = await params;
  return { title: `Backing ${mint.slice(0, 6)}`, description: 'Whether a token’s backing is attested, fresh and enough, and what happens when it is not.' };
}

export default async function Page({ params }: Params) {
  const { mint } = await params;
  return (
    <PublicPage title="Is this token backed?" trail={[{ href: '/backing', label: 'Backing' }]} intro={<p>An issuer can commit to a backing policy: a named attester states the backing, and the token halts if the statement is missing, stale or short of the live supply. A statement is a claim, not an audit.</p>}>
      <BackingView mint={mint} />
    </PublicPage>
  );
}
