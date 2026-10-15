import type { Metadata } from 'next';
import { PageHead } from '@/components/issuer/issuer-shell';
import { SettleConsole } from '@/components/issuer/settle-console';
import { MeteoraMore } from './meteora-more';

export const metadata: Metadata = { title: 'Settle a cross', description: 'Partner payouts, the fees of protected liquidity and the greenshoe for a cross that has settled, with what is live today and what waits for the program upgrade.' };

export default function Page() {
  return (
    <>
      <PageHead title="Settle a cross" intro={<p>After a cross prints, its liquidity venue earns fees and its issuer can support the price. Send the partner payouts, claim the fees of protected liquidity, and run the greenshoe here. Each action is built by the API, checked against the cluster, and signed in your own wallet.</p>} />
      <SettleConsole />
      <MeteoraMore />
    </>
  );
}
