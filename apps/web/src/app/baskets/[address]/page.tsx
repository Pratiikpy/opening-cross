import type { Metadata } from 'next';
import { BasketView } from '@/components/baskets/basket-view';
import { PublicPage } from '@/components/w4/ui';

type Params = { params: Promise<{ address: string }> };
export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { address } = await params;
  return { title: `Basket ${address.slice(0, 6)}`, description: 'What one share of a basket is, what backs it now, and how to mint or redeem it.' };
}

export default async function Page({ params }: Params) {
  const { address } = await params;
  return (
    <PublicPage title="Basket" trail={[{ href: '/baskets', label: 'Baskets' }]} intro={<p>A share is the sum of its parts.</p>}>
      <BasketView address={address} />
    </PublicPage>
  );
}
