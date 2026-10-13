import type { Metadata } from 'next';
import { QaThreadView } from '@/components/issuer/qa-thread';
import { PageHead } from '@/components/issuer/issuer-shell';
import { shortAddress } from '@/lib/units';

type Params = { params: Promise<{ address: string }> };
export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { address } = await params;
  return { title: `Questions about ${shortAddress(address)}`, description: 'Public questions about a cross or a treasury and the answers its owner gave.' };
}

export default async function Page({ params }: Params) {
  const { address } = await params;
  return (
    <>
      <PageHead title="Questions and answers" intro={<p>Ask the people behind a cross or a treasury, in public, and read what they answered.</p>} />
      <QaThreadView subject={address} />
    </>
  );
}
