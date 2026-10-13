import type { Metadata } from 'next';
import { SupportPage } from '@/components/portfolio/support-page';

export const metadata: Metadata = {
  title: 'Support',
  description: 'Ask a person about an order, a claim, a pass or alerts, see the reply, and see your identity status. Says plainly what response time, if any, is committed.',
};

export default function Support() {
  return (
    <div className="mx-auto max-w-[1100px] px-4 py-12 sm:px-6">
      <h1 className="text-[34px] font-semibold tracking-tight">Support</h1>
      <p className="mt-2 max-w-xl text-muted">A request goes to a person. You get a reference to check it with, and the page says what response time is promised and what is not.</p>
      <SupportPage />
    </div>
  );
}
