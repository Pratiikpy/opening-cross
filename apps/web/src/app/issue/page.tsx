import type { Metadata } from 'next';
import { IssuerConsole } from '@/components/issuer/issuer-console';

export const metadata: Metadata = { title: 'Open a cross' };

export default function IssuePage() {
  return (
    <div className="mx-auto max-w-[900px] px-4 py-12 sm:px-6">
      <h1 className="text-[34px] font-semibold tracking-tight">Open a cross</h1>
      <p className="mt-2 max-w-xl text-muted">
        Set the price grid, the call window and your supply. Everything here becomes on-chain parameters you sign; nothing can be changed
        after the call opens.
      </p>
      <IssuerConsole />
    </div>
  );
}
