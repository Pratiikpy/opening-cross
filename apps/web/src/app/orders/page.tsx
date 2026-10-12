import type { Metadata } from 'next';
import { MyOrdersPage } from '@/components/orders/my-orders-page';

export const metadata: Metadata = { title: 'My orders', description: 'Every order your connected wallet has placed across crosses, with its fill, refund and what to do next.' };

export default function OrdersPage() {
  return (
    <div className="mx-auto max-w-[1000px] px-4 py-12 sm:px-6">
      <h1 className="text-[34px] font-semibold tracking-tight">My orders</h1>
      <p className="mt-2 max-w-xl text-muted">Every order the connected wallet has placed, newest first. Open a cross to cancel, reveal, claim or see its book.</p>
      <MyOrdersPage />
    </div>
  );
}
