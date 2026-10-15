import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { ReceiptPage, receiptMetadata } from '@/components/cross/receipt-page';
import { isAddress } from '@/lib/receipt-routes';
import { AttestationPanel } from '../../_attestation/attestation-panel';

export const dynamic = 'force-dynamic';
type Params = { params: Promise<{ address: string; owner: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { address, owner } = await params;
  return receiptMetadata(address, owner);
}

export default async function Page({ params }: Params) {
  const { address, owner } = await params;
  const h = await headers();
  const origin = `${h.get('x-forwarded-proto') ?? 'https'}://${h.get('host') ?? 'localhost'}`;
  return (
    <>
      <ReceiptPage address={address} owner={owner} />
      {isAddress(address) && isAddress(owner) ? <AttestationPanel address={address} owner={owner} origin={origin} /> : null}
    </>
  );
}
