import type { Metadata } from 'next';
import { BasketNew } from '@/components/baskets/basket-new';
import { PublicPage } from '@/components/w4/ui';

export const metadata: Metadata = { title: 'Create a basket', description: 'Create a basket token: a label and the amount of each component behind one share.' };

export default function Page() {
  return (
    <PublicPage title="Create a basket" trail={[{ href: '/baskets', label: 'Baskets' }]} intro={<p>Choose up to eight components and how much of each backs one whole share. It cannot be changed afterwards.</p>}>
      <BasketNew />
    </PublicPage>
  );
}
