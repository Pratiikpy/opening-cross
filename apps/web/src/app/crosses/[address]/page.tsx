import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { CrossView } from '@/components/cross/cross-view';
import { type Result, get } from '@/lib/api';
import type { AuthenticityView, PromiseView } from '@/lib/trust-types';
import type { CrossDetail } from '@/lib/types';
import { shortAddress } from '@/lib/units';

type Params = { params: Promise<{ address: string }> };

/** The extras are read on the server only if they are quick; otherwise the page does not wait and the client fetches them. */
const within = <T,>(read: Promise<Result<T>>, ms: number): Promise<Result<T>> =>
  Promise.race([read, new Promise<Result<T>>((resolve) => setTimeout(() => resolve({ ok: false, error: 'not ready' }), ms))]);

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { address } = await params;
  return { title: `Cross ${shortAddress(address)}` };
}

export default async function CrossPage({ params }: Params) {
  const { address } = await params;
  const [res, identity, band] = await Promise.all([
    get<CrossDetail>(`/v1/crosses/${address}`, 0),
    within(get<AuthenticityView>(`/v1/crosses/${address}/authenticity`, 0), 1_500),
    within(get<PromiseView | { promise: null }>(`/v1/crosses/${address}/promise?optional=1`, 0), 1_500),
  ]);
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
  // The identity check and the signed band are read on the server too, so they are in the first paint and never push the page around.
  return (
    <CrossView
      initial={res.data}
      serverNow={String(Math.floor(Date.now() / 1000))}
      initialIdentity={identity.ok ? identity.data : null}
      initialBand={band.ok && band.data.promise ? (band.data as PromiseView) : null}
    />
  );
}
