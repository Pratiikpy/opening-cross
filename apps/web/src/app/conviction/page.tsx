import type { Metadata } from 'next';
import { ConvictionView } from '@/components/conviction/conviction-view';
import { PublicPage } from '@/components/w4/ui';

export const metadata: Metadata = { title: 'Conviction', description: 'Lock tokens with no exit and earn a badge that cannot be sent: proof that you held through the lock.' };

export default function Page() {
  return (
    <PublicPage title="Conviction" intro={<p>A balance read cannot show that tokens were held throughout. A lock can: tokens you cannot move until a time you chose, and a badge for the days you held through.</p>}>
      <ConvictionView />
    </PublicPage>
  );
}
