import type { Metadata } from 'next';
import { PageHead } from '@/components/issuer/issuer-shell';
import { TreasuryConsole } from '@/components/issuer/treasury-console';

type Params = { params: Promise<{ address: string }> };
export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { address } = await params;
  return { title: `Treasury console ${address.slice(0, 6)}`, description: 'Extend a treasury once, then run its holder votes, NAV wall, distributions, revenue rounds, team grants, disclosure requests and wind-down. Each action is signed in your wallet.' };
}

export default async function Page({ params }: Params) {
  const { address } = await params;
  return (
    <>
      <PageHead
        title="Treasury console"
        intro={<p>Extend a treasury once, then run what the extension adds: holder votes, the NAV wall, distributions, revenue rounds, team grants, disclosure requests and the wind-down window. Every action builds an unsigned transaction, shows you the program’s verdict first, and is signed in your own wallet.</p>}
      />
      <TreasuryConsole address={address} />
    </>
  );
}
