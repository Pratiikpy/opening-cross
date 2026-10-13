import type { Metadata } from 'next';
import { Growth } from '@/components/issuer/growth';
import { PageHead } from '@/components/issuer/issuer-shell';

export const metadata: Metadata = { title: 'Issuer growth', description: 'Playbooks for before, during and after a raise, the wallets that took part, and a referral link that routes the integrator fee.' };

export default function Page() {
  return (
    <>
      <PageHead title="Growth" intro={<p>Playbooks, the wallets that took part in your raises, and a referral link. Everything here comes from public activity; nothing identifies a person.</p>} />
      <Growth />
    </>
  );
}
