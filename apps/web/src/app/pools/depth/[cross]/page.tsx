import type { Metadata } from 'next';
import { CrossDepthView } from '@/components/pools/cross-depth-view';
import { PublicPage } from '@/components/w4/ui';

type Params = { params: Promise<{ cross: string }> };
export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { cross } = await params;
  return { title: `Depth of ${cross.slice(0, 6)}`, description: 'A cross’s resting book, the price impact of orders of set sizes, and the pools’ slippage for the same sizes.' };
}

export default async function Page({ params }: Params) {
  const { cross } = await params;
  return (
    <PublicPage title="Depth and price impact" wide trail={[{ href: '/pools', label: 'Pools' }]} intro={<p>A cross has no order book you trade against and no marginal price. Its depth is what is resting; its slippage is how far an extra order moves the clearing price.</p>}>
      <CrossDepthView cross={cross} />
    </PublicPage>
  );
}
