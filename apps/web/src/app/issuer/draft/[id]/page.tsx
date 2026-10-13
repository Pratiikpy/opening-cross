import type { Metadata } from 'next';
import { DraftView } from '@/components/issuer/draft-view';

type Params = { params: Promise<{ id: string }> };
export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { id } = await params;
  return { title: `Draft listing ${id.slice(0, 8)}`, description: 'A draft listing that is not yet verified, with the demand wallets have said they would commit.' };
}

export default async function Page({ params }: Params) {
  const { id } = await params;
  return <DraftView id={id} />;
}
