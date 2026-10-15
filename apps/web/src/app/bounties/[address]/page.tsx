import type { Metadata } from 'next';
import { BountyView } from '@/components/bounty/bounty-view';
import { PublicPage } from '@/components/w4/ui';

type Params = { params: Promise<{ address: string }> };
export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { address } = await params;
  return { title: `Bounty ${address.slice(0, 6)}`, description: 'The terms of a bounty, what it pays for, how to claim and what has been paid.' };
}

export default async function Page({ params }: Params) {
  const { address } = await params;
  return (
    <PublicPage title="Bounty" trail={[{ href: '/bounties', label: 'Bounties' }]} intro={<p>Check a cross account against the eleven invariants. If it breaks one this bounty pays, the reward is yours.</p>}>
      <BountyView address={address} />
    </PublicPage>
  );
}
