import type { Metadata } from 'next';
import { DraftCreate } from '@/components/issuer/draft-create';
import { PageHead } from '@/components/issuer/issuer-shell';

export const metadata: Metadata = { title: 'Demand check', description: 'Publish a draft listing before you fix a date, collect soft commits from wallets, and read the demand by price against your offer.' };

export default function Page() {
  return (
    <>
      <PageHead title="Demand check" intro={<p>Before you fix a date, publish a draft and let people say how much they would commit at which price. Soft commits are signed statements of interest: nothing is escrowed and nobody is bound. The demand map and the sizing tool read what they said against your offer.</p>} />
      <DraftCreate />
    </>
  );
}
