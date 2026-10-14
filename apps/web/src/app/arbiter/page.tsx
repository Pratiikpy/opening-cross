import type { Metadata } from 'next';
import { ArbiterConsole } from '@/components/arbiter/arbiter-console';

export const metadata: Metadata = {
  title: 'The arbiter',
  description: 'Who rules on insider challenges, the challenges waiting for a ruling, and how a ruling moves the issuer’s bond. Open to read; only the arbiter can rule.',
};

export default function Page() {
  return (
    <div className="mx-auto max-w-[900px] px-4 py-14 sm:px-6">
      <h1 className="text-[34px] font-semibold tracking-tight sm:text-[44px]">The arbiter</h1>
      <p className="mt-2 max-w-2xl text-muted">
        An issuer can name its insiders and post a bond behind the list. Anyone can allege that another wallet was an insider too. One named arbiter weighs the evidence and rules: an upheld challenge slashes the bond, a rejected one costs the challenger the deposit, and a challenge left unanswered for 14 days is closed with the deposit returned.
      </p>
      <ArbiterConsole />
    </div>
  );
}
