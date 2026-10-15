import type { Metadata } from 'next';
import { IssuerLiquidityView } from '@/components/pools/issuer-liquidity';
import { PublicPage } from '@/components/w4/ui';

type Params = { params: Promise<{ cross: string }> };
export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { cross } = await params;
  return { title: `Liquidity of ${cross.slice(0, 6)}`, description: 'The issuer’s liquidity view of a cross: its pools, how far each has moved from the clearing price, how deep each is and what is left of the conviction ladder.' };
}

export default async function Page({ params }: Params) {
  const { cross } = await params;
  return (
    <PublicPage title="Liquidity health" trail={[{ href: '/pools', label: 'Pools' }]} intro={<p>The market a cross opened, as its issuer watches it: where the price is against where the cross cleared, and how much can be traded before it moves.</p>}>
      <IssuerLiquidityView cross={cross} />
    </PublicPage>
  );
}
