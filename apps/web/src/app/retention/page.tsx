import type { Metadata } from 'next';
import { RetentionView } from '@/components/portfolio/retention-view';

export const metadata: Metadata = {
  title: 'Retention',
  description: 'How many wallets that ordered in a cross came back in a later week, by cohort, with the method and the sample size. Devnet test traffic.',
};

export default function Retention() {
  return (
    <div className="mx-auto max-w-[1000px] px-4 py-12 sm:px-6">
      <h1 className="text-[34px] font-semibold tracking-tight">Retention</h1>
      <p className="mt-2 max-w-xl text-muted">Whether investors come back, measured from the chain index and published with its sample size.</p>
      <RetentionView />
    </div>
  );
}
