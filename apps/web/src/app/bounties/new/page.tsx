import type { Metadata } from 'next';
import { BountyNew } from '@/components/bounty/bounty-new';
import { PublicPage } from '@/components/w4/ui';

export const metadata: Metadata = { title: 'Post a bounty', description: 'Post an adversarial bounty: the reward token, the arbiter, the commitment and what each invariant pays.' };

export default function Page() {
  return (
    <PublicPage title="Post a bounty" trail={[{ href: '/bounties', label: 'Bounties' }]} intro={<p>Name the arbiter, commit a pool for at least 30 days and say what each invariant pays. Then fund it from its page.</p>}>
      <BountyNew />
    </PublicPage>
  );
}
