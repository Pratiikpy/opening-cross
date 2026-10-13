import type { Metadata } from 'next';
import { PageHead } from '@/components/issuer/issuer-shell';
import { TreasuryCreate } from '@/components/issuer/treasury-create';

export const metadata: Metadata = { title: 'Create a treasury', description: 'Create the program-held treasury for a coin whose supply is fixed, with a spend allowance and an attestation that unlocks spending.' };

export default function Page() {
  return (
    <>
      <PageHead title="Create a treasury" intro={<p>One treasury per coin. Its terms are fixed when you create it, and holders see them, and what they mean, on the coin&apos;s treasury page. This runs on Solana devnet; the treasury program is not audited.</p>} />
      <TreasuryCreate />
    </>
  );
}
