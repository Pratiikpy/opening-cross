import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { ReceiptPage, receiptMetadata } from '@/components/cross/receipt-page';
import { isAddress } from '@/lib/receipt-routes';
import { AttestationPanel } from '../_attestation/attestation-panel';

export const dynamic = 'force-dynamic';
type Params = { params: Promise<{ address: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  return receiptMetadata((await params).address);
}

export default async function Page({ params }: Params) {
  const { address } = await params;
  const h = await headers();
  const origin = `${h.get('x-forwarded-proto') ?? 'https'}://${h.get('host') ?? 'localhost'}`;
  return (
    <>
      <ReceiptPage address={address} />
      {isAddress(address) ? <AttestationPanel address={address} origin={origin} /> : null}
    </>
  );
}
