import type { Metadata } from 'next';
import { Apply } from '@/components/issuer/apply';
import { PageHead } from '@/components/issuer/issuer-shell';

export const metadata: Metadata = { title: 'Apply for review', description: 'The readiness checklist we review against, and an application signed with your wallet.' };

export default function Page() {
  return (
    <>
      <PageHead title="Apply for review" intro={<p>The checklist is public. The first half is checked by the console itself; the second is what a reviewer looks at. Applying is optional: a cross is permissionless and can be opened without one.</p>} />
      <Apply />
    </>
  );
}
