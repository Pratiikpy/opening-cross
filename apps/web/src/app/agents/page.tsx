import type { Metadata } from 'next';
import { AgentsView } from '@/components/mandates/agents-view';
import { PublicPage } from '@/components/w4/ui';

export const metadata: Metadata = { title: 'Agents', description: 'What an agent key can sign for a mandate, the guard that checks a transaction before it signs, and the MCP tools.' };

export default function Page() {
  return (
    <PublicPage title="Agents" intro={<p>For people who run an agent that invests on someone&apos;s behalf: what its key may sign, and how to check a transaction before it does.</p>}>
      <AgentsView />
    </PublicPage>
  );
}
