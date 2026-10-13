import type { Metadata } from 'next';
import { IssuerConsole } from '@/components/issuer/issuer-console';
import { IssuerShell } from '@/components/issuer/issuer-shell';

export const metadata: Metadata = { title: 'Open a cross', description: 'Set the price grid, the call window, your supply and the guards, simulate the result, and open a cross on Solana devnet. Nothing here needs a wallet until you create.' };

export default function IssuePage() {
  return (
    <IssuerShell
      title="Open a cross"
      intro={<p>Set the price grid, the call window, your supply and the guards, and see what the cross would do before anything is signed. Everything becomes on-chain parameters you sign; nothing can be changed after the call opens. This runs on Solana devnet: the programs are not audited and no real money is involved.</p>}
    >
      <IssuerConsole />
    </IssuerShell>
  );
}
