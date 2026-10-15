import type { Metadata } from 'next';
import { PoolView } from '@/components/pools/pool-view';
import { PublicPage } from '@/components/w4/ui';

type Params = { params: Promise<{ address: string }> };
export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { address } = await params;
  return { title: `Pool ${address.slice(0, 6)}`, description: 'A Meteora pool read from chain: price, fee, depth within price limits, the cost of a trade of a given size and a trade panel.' };
}

export default async function Page({ params }: Params) {
  const { address } = await params;
  return (
    <PublicPage title="Pool" wide trail={[{ href: '/pools', label: 'Pools' }]} intro={<p>Everything on this page is read from the pool’s accounts on the network when you open it, and again every fifteen seconds.</p>}>
      <PoolView address={address} />
    </PublicPage>
  );
}
