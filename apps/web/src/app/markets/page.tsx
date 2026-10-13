import type { Metadata } from 'next';
import { MarketsPage } from '@/components/portfolio/markets-page';

export const metadata: Metadata = {
  title: 'Markets',
  description: 'Every token that has cleared in a cross, the price it last cleared at, when it clears next, an index of repeat prints, and the tokenized stocks the premium monitor watches.',
};

export default function Markets() {
  return (
    <div className="mx-auto max-w-[1000px] px-4 py-12 sm:px-6">
      <h1 className="text-[34px] font-semibold tracking-tight">Markets</h1>
      <p className="mt-2 max-w-xl text-muted">Between crosses: what each token last cleared at, and when it clears next.</p>
      <MarketsPage />
    </div>
  );
}
