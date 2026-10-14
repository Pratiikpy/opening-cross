import type { Metadata } from 'next';
import { PageHead } from '@/components/issuer/issuer-shell';
import { HaltConsole } from '@/components/issuer/halt-console';

export const metadata: Metadata = { title: 'Halts and corporate actions', description: 'Create a halt state for a token, halt it, flag a corporate action, copy a pause, feed the circuit breaker and run the lender print feed.' };

export default function Page() {
  return (
    <>
      <PageHead title="Halts and corporate actions" intro={<p>Stop crosses of your token when it should not trade: an issuer pause, a venue halt, a price that moved too far, or a corporate action in progress. Crosses that honour the halt refuse to print and refund every order. Only a printing resume cross starts trading again.</p>} />
      <HaltConsole />
    </>
  );
}
