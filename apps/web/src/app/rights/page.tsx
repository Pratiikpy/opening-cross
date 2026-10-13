import type { Metadata } from 'next';
import { RightsView } from '@/components/portfolio/rights-view';

export const metadata: Metadata = {
  title: 'Rights',
  description: 'What holding an ownership coin does and does not give you, for each coin your wallet holds, from what its treasury program enforces.',
};

export default function Rights() {
  return (
    <div className="mx-auto max-w-[900px] px-4 py-12 sm:px-6">
      <h1 className="text-[34px] font-semibold tracking-tight">Rights</h1>
      <p className="mt-2 max-w-xl text-muted">For each ownership coin the connected wallet holds: what the treasury program enforces in your favour, and what it does not provide. Nothing here is a promise by a team.</p>
      <RightsView />
    </div>
  );
}
