import type { Metadata } from 'next';
import { MandatesHome } from '@/components/mandates/mandates-home';
import { PublicPage } from '@/components/w4/ui';

export const metadata: Metadata = { title: 'Auto-invest mandates', description: 'Let one key invest for you inside limits the chain enforces, with a kill switch you can always use.' };

export default function Page() {
  return (
    <PublicPage title="Auto-invest mandates" intro={<p>Fund a vault, name one agent and set the limits. The agent can place buy orders inside them and nothing else; you can revoke it and withdraw at any time.</p>}>
      <MandatesHome />
    </PublicPage>
  );
}
