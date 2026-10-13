import type { Metadata } from 'next';
import { ReceiptPage, receiptMetadata } from '@/components/cross/receipt-page';

export const dynamic = 'force-dynamic';
type Params = { params: Promise<{ address: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  return receiptMetadata((await params).address);
}

export default async function Page({ params }: Params) {
  return <ReceiptPage address={(await params).address} />;
}
