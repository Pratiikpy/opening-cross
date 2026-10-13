import type { Metadata } from 'next';
import { Suspense } from 'react';
import { ManageLink } from '@/components/alerts/manage-link';

export const metadata: Metadata = { title: 'Stop alerts', robots: { index: false } };

export default function StopAlerts() {
  return (
    <div className="mx-auto max-w-[640px] px-4 py-16 sm:px-6">
      <h1 className="text-[28px] font-semibold tracking-tight">Stop alerts</h1>
      <Suspense fallback={<p role="status" className="mt-4 text-sm text-muted">Reading your link…</p>}>
        <ManageLink action="unsubscribe" />
      </Suspense>
    </div>
  );
}
