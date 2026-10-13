import type { Metadata } from 'next';
import { IssuerOverview } from '@/components/issuer/issuer-overview';
import { PageHead } from '@/components/issuer/issuer-shell';

export const metadata: Metadata = { title: 'Issuer overview', description: 'Your crosses, the wallets that bid, the fees you paid, your treasury and what needs your attention, read from Solana devnet.' };

export default function IssuerPage() {
  return (
    <>
      <PageHead title="Issuer overview" intro={<p>Your crosses, who took part, what you paid in fees, your treasury and what needs you. Everything is read from the network for the wallet you connect; nothing is stored about you.</p>} />
      <IssuerOverview />
    </>
  );
}
