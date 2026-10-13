import type { Metadata } from 'next';
import { ReceiptPage, receiptMetadata } from '@/components/cross/receipt-page';

export const dynamic = 'force-dynamic';
type Params = { params: Promise<{ address: string; owner: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { address, owner } = await params;
  return receiptMetadata(address, owner);
}

export default async function Page({ params }: Params) {
  const { address, owner } = await params;
  return <ReceiptPage address={address} owner={owner} />;
}
