import type { Metadata } from 'next';
import { PageHead } from '@/components/issuer/issuer-shell';
import { SeriesConsole } from '@/components/issuer/series-console';

export const metadata: Metadata = { title: 'Recurring series', description: 'Create a recurring series, spawn its next cross, pause it and withdraw from it. Each action is built by the API, checked against the cluster and signed in your wallet.' };

export default function Page() {
  return (
    <>
      <PageHead title="Recurring series" intro={<p>Open the same market again and again on a schedule. A series is a template: the schedule, the price grid, the guards and the fees are fixed when you create it, and every cross it spawns follows them. Each action is built by the API, checked against the cluster and signed in your own wallet.</p>} />
      <SeriesConsole />
    </>
  );
}
