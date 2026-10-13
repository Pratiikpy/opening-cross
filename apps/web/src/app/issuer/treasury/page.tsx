import type { Metadata } from 'next';
import { PageHead } from '@/components/issuer/issuer-shell';
import { TreasuryManage } from '@/components/issuer/treasury-manage';

export const metadata: Metadata = { title: 'Issuer treasury', description: 'The treasuries your wallet controls: allowance, attestation status and what holders are told.' };

export default function Page() {
  return (
    <>
      <PageHead title="Treasury" intro={<p>A treasury holds proceeds in a program, not in your wallet. You can spend a capped allowance each period, and only while an attestation from the attester you named is live. This page shows the ones your wallet controls and what holders are told about them.</p>} />
      <TreasuryManage />
    </>
  );
}
