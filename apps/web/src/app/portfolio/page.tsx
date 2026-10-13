import type { Metadata } from 'next';
import { PortfolioPage } from '@/components/portfolio/portfolio-page';

export const metadata: Metadata = {
  title: 'Portfolio',
  description: 'What your wallet holds from crosses, what each token last cleared at, what you paid, what needs you, and the rights and distributions that come with a token.',
};

export default function Portfolio() {
  return (
    <div className="mx-auto max-w-[1000px] px-4 py-12 sm:px-6">
      <h1 className="text-[34px] font-semibold tracking-tight">Portfolio</h1>
      <p className="mt-2 max-w-xl text-muted">Everything the connected wallet holds from crosses, valued only at prices a cross actually cleared at.</p>
      <PortfolioPage />
    </div>
  );
}
