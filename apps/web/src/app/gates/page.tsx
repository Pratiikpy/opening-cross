import type { Metadata } from 'next';
import { GatesView } from '@/components/gate/gates-view';
import { GateFinder } from './_components/gate-finder';

export const metadata: Metadata = {
  title: 'Gates',
  description: 'Which crosses only take orders from wallets holding a pass, what each gate requires, and how your wallet gets one.',
};

export default function GatesPage() {
  return (
    <div className="mx-auto max-w-[900px] px-4 py-12 sm:px-6">
      <h1 className="text-[34px] font-semibold tracking-tight">Gates</h1>
      <p className="mt-2 max-w-xl text-muted">
        A gated cross takes orders only from wallets holding a pass, and a restricted token can limit who may receive it. This page shows every gate behind a recent cross, what it requires, where your wallet stands and, where a route exists today, how to claim the pass.
      </p>
      <GateFinder />
      <GatesView />
    </div>
  );
}
