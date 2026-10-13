import type { Metadata } from 'next';
import { Accelerators } from '@/components/issuer/accelerators';
import { PageHead } from '@/components/issuer/issuer-shell';

export const metadata: Metadata = { title: 'Accelerators and cohorts', description: 'How a company from an accelerator or program raises here, and the public pipeline of applications that name one.' };

export default function Page() {
  return (
    <>
      <PageHead title="Accelerators and cohorts" intro={<p>For companies that belong to an accelerator or a program. They raise the same way as anyone, in public, at one price for everyone, and the applications that name a program are listed below.</p>} />
      <Accelerators />
    </>
  );
}
