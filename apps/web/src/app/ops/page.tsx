import type { Metadata } from 'next';
import { OpsConsole } from '@/components/ops/ops-console';

// An internal tool: it is not linked from the site, not listed in the sitemap, and asks search engines to stay away.
export const metadata: Metadata = {
  title: 'Operations console',
  description: 'Listing reviews, incidents, compliance cases and the audit log, for the people who run Opening Bell.',
  robots: { index: false, follow: false },
};

export default function OpsPage() {
  return (
    <div className="mx-auto max-w-[1100px] px-4 py-10 sm:px-6">
      <h1 className="text-[34px] font-semibold tracking-tight">Operations console</h1>
      <p className="mt-2 max-w-2xl text-muted">For the people who run Opening Bell. Every action here is recorded under your name in a tamper-evident log.</p>
      <div className="mt-8">
        <OpsConsole />
      </div>
    </div>
  );
}
