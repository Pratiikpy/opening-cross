import type { Metadata } from 'next';
import { PageHead } from '@/components/issuer/issuer-shell';
import { GraduationConsole } from '@/components/issuer/graduation-console';

export const metadata: Metadata = { title: 'Graduation by holder vote', description: 'Set the charter of a governed cross, open its voting rounds and see which venue holders chose.' };

export default function Page() {
  return (
    <>
      <PageHead title="Graduation by holder vote" intro={<p>A cross that set the governed-graduation rule opens its market only on the venue its holders vote for. Here you set the charter before the first order, open the rounds once the cross is finalized, and see the outcome. Holders vote on the cross&apos;s own page.</p>} />
      <GraduationConsole />
    </>
  );
}
