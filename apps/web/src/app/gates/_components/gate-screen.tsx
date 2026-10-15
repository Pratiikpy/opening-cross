'use client';

import { isAddress } from '@solana/kit';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { useWallet } from '@/lib/wallet';
import { type GateRead, readGate } from '../_lib/chain';
import { RulesForm } from './admin-card';
import { CreateGate, GrantPass, WalletControls } from './authority-tools';
import { Notice } from './notice';
import { RulesCard } from './rules-card';
import { StandingCard } from './standing-card';

type State = { phase: 'loading' } | { phase: 'error'; message: string } | { phase: 'ready'; read: GateRead };

/** The page of one token's gate: what it requires, where the connected wallet stands, and, for the gate authority, the controls. */
export function GateScreen({ mint }: { mint: string }) {
  const { account } = useWallet();
  const [state, setState] = useState<State>({ phase: 'loading' });
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  const valid = isAddress(mint);
  useEffect(() => {
    if (!valid) return;
    let live = true;
    readGate(mint).then(
      (read) => live && setState({ phase: 'ready', read }),
      (e: unknown) => live && setState({ phase: 'error', message: e instanceof Error ? e.message : 'The chain could not be read.' }),
    );
    return () => {
      live = false;
    };
  }, [mint, valid, tick]);

  if (!valid) {
    return (
      <Notice tone="warn" title="That is not a token address" testId="gate-invalid" alert>
        The address in the link is not a Solana address. <Link href="/gates" className="underline underline-offset-2">Look up a token</Link>.
      </Notice>
    );
  }
  if (state.phase === 'loading') return <p role="status" className="text-muted" data-testid="gate-loading">Reading the gate…</p>;
  if (state.phase === 'error') {
    return (
      <Notice tone="warn" title="The gate could not be read" testId="gate-error" alert>
        {state.message}
      </Notice>
    );
  }
  const read = state.read;
  if (!read.found) {
    return (
      <div className="space-y-4" data-testid="gate-missing">
        <Notice
          title={read.reason === 'no-config' ? 'This token has no gate' : read.reason === 'foreign-owner' ? 'This address is not a gate' : 'The gate could not be decoded'}
        >
          {read.reason === 'no-config'
            ? 'Anyone can hold it: no one has created a gate for it, so nothing restricts who may receive it or bid for it.'
            : read.reason === 'foreign-owner'
              ? 'An account exists at the gate address but another program owns it.'
              : 'The account is there but this page cannot read it. It may have been written by a newer version of the program.'}
        </Notice>
        {read.reason === 'no-config' && account ? <CreateGate mint={mint} account={account} onChanged={reload} /> : null}
        {read.reason === 'no-config' && !account ? <p className="text-sm text-muted">The token&apos;s mint authority can create the gate here. Connect that wallet.</p> : null}
      </div>
    );
  }
  const gate = read.gate;
  const isAuthority = !!account && account.address === gate.authority;
  return (
    <div className="space-y-6">
      <RulesCard gate={gate} />
      <StandingCard gate={gate} />
      {isAuthority && account ? (
        <>
          <RulesForm gate={gate} account={account} onChanged={reload} />
          <GrantPass gate={gate} account={account} onChanged={reload} />
          <WalletControls gate={gate} account={account} onChanged={reload} />
        </>
      ) : account ? (
        <p className="text-xs text-muted" data-testid="not-authority">
          The controls for this gate appear when its authority is connected.
        </p>
      ) : null}
    </div>
  );
}
