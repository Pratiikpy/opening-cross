import type { Metadata } from 'next';
import Link from 'next/link';
import { HaltView } from '@/components/halts/halt-view';

type Params = { params: Promise<{ mint: string }> };
export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { mint } = await params;
  return { title: `Halt state ${mint.slice(0, 6)}`, description: 'Whether trading in a token is halted, why, who can change it, and what lifts a halt.' };
}

export default async function Page({ params }: Params) {
  const { mint } = await params;
  return (
    <div className="mx-auto max-w-[900px] px-4 py-14 sm:px-6">
      <p className="text-sm text-muted">
        <Link href="/calendar" className="underline underline-offset-4 hover:text-ink">
          Calendar
        </Link>
      </p>
      <h1 className="mt-3 text-[30px] font-semibold tracking-tight sm:text-[40px]">Is this token halted?</h1>
      <p className="mt-2 max-w-2xl text-muted">A halt is read from the chain. Crosses that honour it do not print while it lasts, and refund every order in full.</p>
      <div className="mt-8">
        <HaltView baseMint={mint} />
      </div>
    </div>
  );
}
