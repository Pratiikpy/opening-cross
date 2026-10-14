import type { Metadata } from 'next';
import { DashboardView } from '@/components/dashboard/dashboard-view';

export const metadata: Metadata = {
  title: 'Dashboard',
  description: 'Live figures from the protocol, each beside the route it came from: totals, execution quality, fairness, the accuracy record, the fee ledger and who can replace each program.',
};

export default function Page() {
  return (
    <div className="mx-auto max-w-[1000px] px-4 py-14 sm:px-6">
      <h1 className="text-[34px] font-semibold tracking-tight sm:text-[44px]">Dashboard</h1>
      <p className="mt-2 max-w-2xl text-muted">The protocol’s live figures on one page. The dashboard computes nothing: every section is the answer of a route you can open yourself, named under its heading, and a section that failed says so instead of showing a default.</p>
      <DashboardView />
    </div>
  );
}
