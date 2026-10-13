import type { Metadata } from 'next';
import { Disclosures } from '@/components/issuer/disclosures';
import { PageHead } from '@/components/issuer/issuer-shell';

export const metadata: Metadata = { title: 'Disclosures and questions', description: 'Post signed disclosure updates, anchored on chain, and answer the questions holders ask about your crosses and treasuries.' };

export default function Page() {
  return (
    <>
      <PageHead title="Disclosures and questions" intro={<p>Holders see when your next update is due and whether the last one is late. You post it here, signed with your wallet and anchored on chain, and you answer what they ask.</p>} />
      <Disclosures />
    </>
  );
}
