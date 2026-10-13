'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { API_URL } from '@/lib/api';
import type { Gate, GateDetail } from '@/lib/gate';
import { shortAddress } from '@/lib/units';
import { useWallet } from '@/lib/wallet';

type State = { s: 'idle' } | { s: 'loading' } | { s: 'error' } | { s: 'ready'; gates: { gate: Gate; pass: boolean | null }[] };

async function json<T>(path: string): Promise<T | null> {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(`${API_URL}${path}`, { cache: 'no-store' });
      if (r.status === 429) {
        await new Promise((res) => setTimeout(res, 2000));
        continue;
      }
      return r.ok ? ((await r.json()) as T) : null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Identity status, always where the wallet is (N1): what checking this wallet has passed and what it has not. Most crosses need no check at
 * all, and the line says so. A gate is satisfied by a pass held in this wallet; the test attester on devnet does not verify a real identity.
 */
export function IdentityStatus() {
  const { account } = useWallet();
  const owner = account?.address ?? null;
  const [state, setState] = useState<State>({ s: 'idle' });
  useEffect(() => {
    if (!owner) return setState({ s: 'idle' });
    let live = true;
    setState({ s: 'loading' });
    void (async () => {
      const list = await json<{ gates: Gate[] }>('/v1/gates');
      if (!list) return live && setState({ s: 'error' });
      const gates: { gate: Gate; pass: boolean | null }[] = [];
      for (const g of list.gates.slice(0, 12)) {
        const d = await json<GateDetail>(`/v1/gates/${g.mint}?wallet=${owner}`);
        gates.push({ gate: g, pass: d?.standing ? d.standing.hasPass : null });
      }
      if (live) setState({ s: 'ready', gates });
    })();
    return () => {
      live = false;
    };
  }, [owner]);

  if (!owner) return null;
  const held = state.s === 'ready' ? state.gates.filter((g) => g.pass === true).length : 0;
  const missing = state.s === 'ready' ? state.gates.filter((g) => g.pass === false) : [];
  return (
    <section aria-labelledby="idstatus-h" className="rounded-[var(--radius-card)] border border-border p-5" data-testid="identity-status">
      <h2 id="idstatus-h" className="font-medium">
        Identity status
      </h2>
      {state.s === 'loading' ? (
        <p role="status" className="mt-2 text-sm text-muted">
          Checking this wallet against the gates on recent crosses…
        </p>
      ) : state.s === 'error' ? (
        <p role="alert" className="mt-2 text-sm text-accent-text">
          The gates could not be read just now, so this wallet&apos;s status is unknown.
        </p>
      ) : state.s === 'ready' ? (
        <>
          <p className="mt-2 text-sm" data-testid="identity-summary">
            {state.gates.length === 0
              ? 'No recent cross asks for an identity check. Any wallet can place an order in them.'
              : missing.length === 0
                ? `This wallet holds the pass for ${held} gated ${held === 1 ? 'offering' : 'offerings'}. Crosses without a gate need no check.`
                : `This wallet holds ${held} of ${state.gates.length} gate passes. It has no pass for ${missing.length}: ${missing.slice(0, 3).map((m) => shortAddress(m.gate.mint)).join(', ')}${missing.length > 3 ? ' and more' : ''}.`}
          </p>
          <p className="mt-2 text-xs text-muted">
            A check happens only where an issuer put a gate on a cross, and only when you place an order in it. On devnet the attester is a test attester: it issues passes without verifying a real identity. <Link href="/gates" className="underline">Gates</Link>
          </p>
        </>
      ) : null}
    </section>
  );
}
