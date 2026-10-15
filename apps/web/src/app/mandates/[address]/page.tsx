import type { Metadata } from 'next';
import { MandateView } from '@/components/mandates/mandate-view';
import { PublicPage } from '@/components/w4/ui';

type Params = { params: Promise<{ address: string }> };
export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { address } = await params;
  return { title: `Mandate ${address.slice(0, 6)}`, description: 'The limits of a mandate, its vault, what the agent placed and the owner’s controls.' };
}

export default async function Page({ params }: Params) {
  const { address } = await params;
  return (
    <PublicPage title="Mandate" trail={[{ href: '/mandates', label: 'Mandates' }]} intro={<p>An owner’s vault and the limits one agent works inside.</p>}>
      <MandateView address={address} />
    </PublicPage>
  );
}
