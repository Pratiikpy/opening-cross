import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { CrossView } from '@/components/cross/cross-view';
import { get } from '@/lib/api';
import type { CrossDetail } from '@/lib/types';
import { shortAddress } from '@/lib/units';

type Params = { params: Promise<{ address: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { address } = await params;
  return { title: `Cross ${shortAddress(address)}` };
}

export default async function CrossPage({ params }: Params) {
  const { address } = await params;
  const res = await get<CrossDetail>(`/v1/crosses/${address}`, 0);
  if (!res.ok) {
    if (/not found|not an Opening Cross|base58/.test(res.error)) notFound();
    return (
      <div className="mx-auto max-w-[1200px] px-4 py-14 sm:px-6">
        <h1 className="text-2xl font-semibold">Cross {shortAddress(address)}</h1>
        <p role="status" className="mt-4 text-muted">
          This cross cannot be loaded right now: {res.error}
        </p>
      </div>
    );
  }
  return <CrossView initial={res.data} serverNow={String(Math.floor(Date.now() / 1000))} />;
}
