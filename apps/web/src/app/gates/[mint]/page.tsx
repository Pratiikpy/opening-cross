import type { Metadata } from 'next';
import Link from 'next/link';
import { GateScreen } from '../_components/gate-screen';

export const metadata: Metadata = { title: 'Gate', description: "Who may hold a restricted token: the issuer's rules, and whether your wallet meets them." };

export default async function Gate({ params }: { params: Promise<{ mint: string }> }) {
  const { mint } = await params;
  return (
    <div className="mx-auto max-w-[800px] px-4 py-12 sm:px-6">
      <p className="text-sm">
        <Link href="/gates" className="text-muted underline underline-offset-2">
          All gates
        </Link>
      </p>
      <h1 className="mt-2 text-[34px] font-semibold tracking-tight">Gate</h1>
      <p className="mt-1 break-all font-mono text-xs text-muted" data-testid="gate-mint-shown">
        {mint}
      </p>
      <div className="mt-8">
        <GateScreen mint={mint} />
      </div>
    </div>
  );
}
