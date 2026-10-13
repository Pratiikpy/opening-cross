import type { Metadata } from 'next';
import { AlertsPage } from '@/components/alerts/alerts-page';

export const metadata: Metadata = {
  title: 'Alerts',
  description: 'Be told when an order of yours can be claimed and before a cross or market you follow opens or closes: browser notification, email or Telegram, each one optional and removable.',
};

export default function Alerts() {
  return (
    <div className="mx-auto max-w-[1000px] px-4 py-12 sm:px-6">
      <h1 className="text-[34px] font-semibold tracking-tight">Alerts</h1>
      <p className="mt-2 max-w-xl text-muted">What needs you now, what you follow, and how Opening Bell reaches you when a page is not open.</p>
      <AlertsPage />
    </div>
  );
}
