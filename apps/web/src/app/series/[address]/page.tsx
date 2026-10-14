import type { Metadata } from 'next';
import Link from 'next/link';
import { SeriesDetail } from '@/components/series/series-detail';

type Params = { params: Promise<{ address: string }> };
export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { address } = await params;
  return { title: `Series ${address.slice(0, 6)}`, description: 'A recurring series: its schedule, the next cross and whether it can be started now, and how every cross it ran ended.' };
}

export default async function Page({ params }: Params) {
  const { address } = await params;
  return (
    <div className="mx-auto max-w-[900px] px-4 py-14 sm:px-6">
      <p className="text-sm text-muted">
        <Link href="/series" className="underline underline-offset-4 hover:text-ink">
          Recurring series
        </Link>
      </p>
      <h1 className="mt-3 text-[30px] font-semibold tracking-tight sm:text-[40px]">Series</h1>
      <p className="mt-2 max-w-2xl text-muted">The schedule below is what the program enforces. Nobody can move a cross to another time, and a cross that fails a guard refunds everyone.</p>
      <div className="mt-8">
        <SeriesDetail address={address} />
      </div>
    </div>
  );
}
