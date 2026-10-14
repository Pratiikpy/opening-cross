'use client';

import Link from 'next/link';
import { HaltStatus, useHalt } from './halt-status';

/** The holder's page for one token's halt state: read-only, with the way out of a halt explained. */
export function HaltView({ baseMint }: { baseMint: string }) {
  const data = useHalt(baseMint);
  return (
    <div className="space-y-6">
      <HaltStatus data={data} baseMint={baseMint} />
      <p className="text-sm text-muted">
        Why did a cross not print? Its page says so in words, with the guard that stopped it. If you issue this token, <Link href={`/issuer/halts?mint=${baseMint}`} className="underline underline-offset-4">manage its halt state</Link>.
      </p>
    </div>
  );
}
