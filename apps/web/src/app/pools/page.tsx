import type { Metadata } from 'next';
import { PoolsIndex } from '@/components/pools/pools-index';
import { PublicPage } from '@/components/w4/ui';

export const metadata: Metadata = {
  title: 'Pools',
  description: 'The Meteora pools a cross opens its market in: depth, price impact and a trade panel, read from chain.',
};

export default function Page() {
  return (
    <PublicPage title="Pools" intro={<p>A cross prices an asset once. After it, the asset trades in a pool. Find the pool, see how deep it is and what a trade of your size costs, and trade it.</p>}>
      <PoolsIndex />
    </PublicPage>
  );
}
