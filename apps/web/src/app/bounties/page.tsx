import type { Metadata } from 'next';
import { BountyIndex } from '@/components/bounty/bounty-index';
import { PublicPage } from '@/components/w4/ui';

export const metadata: Metadata = { title: 'Bounties', description: 'Pools that pay whoever shows a cross account that breaks one of eleven invariants cross_core promises never to break.' };

export default function Page() {
  return (
    <PublicPage title="Bounties" intro={<p>A bounty puts a pool behind a promise: pay whoever shows a cross account that breaks one of eleven invariants the cross program says it never will. The sponsor cannot take the pool back for at least 30 days. Eleven invariants are not a proof of correctness.</p>}>
      <BountyIndex />
    </PublicPage>
  );
}
