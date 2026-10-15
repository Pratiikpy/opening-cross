import type { Metadata } from 'next';
import { BasketIndex } from '@/components/baskets/basket-index';
import { PublicPage } from '@/components/w4/ui';

export const metadata: Metadata = { title: 'Baskets', description: 'Tokens that stand for several tokens, redeemable for exactly what backs them.' };

export default function Page() {
  return (
    <PublicPage title="Baskets" intro={<p>A basket token is only worth holding if anyone can redeem it for the tokens behind it. Each share is backed by fixed amounts of up to eight tokens, with no manager, no fee and no way to change it.</p>}>
      <BasketIndex />
    </PublicPage>
  );
}
