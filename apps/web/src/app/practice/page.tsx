import type { Metadata } from 'next';
import { PracticePage } from '@/components/portfolio/practice-page';

export const metadata: Metadata = {
  title: 'Practice',
  description: 'A 60-second practice cross with play money and simulated bidders, priced by the same rule as a real one. Nothing touches a wallet.',
};

export default function Practice() {
  return (
    <div className="mx-auto max-w-[1100px] px-4 py-12 sm:px-6">
      <h1 className="text-[34px] font-semibold tracking-tight">Practice</h1>
      <p className="mt-2 max-w-xl text-muted">Try a cross before you trade in one: place an order, watch the price form, and see what you pay. Play money only.</p>
      <PracticePage />
    </div>
  );
}
