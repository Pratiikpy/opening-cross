'use client';

import type { UiWalletAccount } from '@wallet-standard/ui';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { useSigner } from '@/components/cross/use-signer';
import { API_URL } from '@/lib/api';
import { type Gate, type GateDetail, loadGate, loadGates } from '@/lib/gate';
import { shortAddress } from '@/lib/units';
import { useWallet } from '@/lib/wallet';
import { ClaimActions } from './claim-actions';
import { ReasonList } from './reason-list';

type Preset = { id: string; name: string; summary: string; walletDoes: string; limits: string[] };

function Presets() {
  const [presets, setPresets] = useState<Preset[] | null>(null);
  useEffect(() => {
    let live = true;
    fetch(`${API_URL}/v1/gates/presets`, { cache: 'no-store' })
      .then((r) => (r.ok ? (r.json() as Promise<{ presets: Preset[] }>) : null))
      .then((b) => live && b && setPresets(b.presets))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  if (!presets) return null;
  return (
    <section aria-labelledby="presets" className="mt-8" data-testid="gate-presets">
      <h2 id="presets" className="font-mono text-xs uppercase tracking-widest text-muted">
        The three kinds of gate
      </h2>
      <ul className="mt-3 grid gap-3 sm:grid-cols-3">
        {presets.map((p) => (
          <li key={p.id} className="rounded-[var(--radius-card)] border border-border p-4 text-sm">
            <p className="font-medium">{p.name}</p>
            <p className="mt-1 text-muted">{p.summary}</p>
            <p className="mt-2">
              <span className="text-muted">You: </span>
              {p.walletDoes}
            </p>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-xs text-muted">A gate checks a wallet, not a person, and carries no jurisdiction rules. Which wallets an offering may admit is a question for the issuer's counsel; nothing here is legal advice.</p>
    </section>
  );
}

function Standing({ gate, account }: { gate: Gate; account: UiWalletAccount }) {
  const sign = useSigner(account);
  const [detail, setDetail] = useState<GateDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((v) => v + 1), []);
  useEffect(() => {
    let live = true;
    void loadGate(gate.mint, account.address).then((r) => {
      if (!live) return;
      if (r.ok) {
        setDetail(r.data);
        setError(null);
      } else setError(r.error);
    });
    return () => {
      live = false;
    };
  }, [gate.mint, account.address, version]);
  if (error) return <p role="alert" className="mt-3 text-accent-text">This wallet's standing could not be read: {error}</p>;
  if (!detail?.standing) return <p role="status" className="mt-3 text-muted">Reading this wallet's standing…</p>;
  const s = detail.standing;
  return (
    <div className="mt-4 border-t border-border pt-3" data-testid={`standing-${gate.mint}`}>
      <p className="text-xs uppercase tracking-widest text-muted">Your wallet {shortAddress(account.address)}</p>
      <p className={`mt-1 font-medium ${s.hasPass ? 'text-positive' : 'text-accent-text'}`}>{s.hasPass ? 'You hold a pass for this gate.' : 'You do not hold a pass for this gate.'}</p>
      <ReasonList reasons={s.reasons} />
      {s.hasPass ? null : (
        <div className="mt-3">
          <ClaimActions mint={gate.mint} account={account} sign={sign} claim={s.claim} sas={s.sas} onChanged={reload} />
        </div>
      )}
    </div>
  );
}

function GateCard({ gate }: { gate: Gate }) {
  const { account } = useWallet();
  return (
    <li className="rounded-[var(--radius-card)] border border-border p-5 text-sm" data-testid={`gate-${gate.mint}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="font-mono text-xs text-muted">
          Gate mint <span className="break-all text-ink">{gate.mint}</span>
        </p>
        {gate.mode ? <span className="rounded-full border border-border px-2.5 py-0.5 text-xs text-muted">Mode: {gate.mode}</span> : null}
      </div>
      {gate.error ? (
        <p className="mt-3 text-accent-text">{gate.error}</p>
      ) : (
        <>
          <h3 className="mt-3 font-medium">How a wallet gets a pass</h3>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-muted">
            {gate.routes?.map((r) => (
              <li key={r.kind}>{r.detail}</li>
            ))}
          </ul>
          <dl className="mt-3 grid gap-x-4 gap-y-1 sm:grid-cols-[max-content_1fr]">
            {gate.allowlistRoot ? (
              <>
                <dt className="text-muted">Allowlist root</dt>
                <dd className="break-all font-mono text-xs">{gate.allowlistRoot}</dd>
              </>
            ) : null}
            {gate.sas ? (
              <>
                <dt className="text-muted">Attestation credential</dt>
                <dd className="break-all font-mono text-xs">{gate.sas.credential}</dd>
                <dt className="text-muted">Attestation schema</dt>
                <dd className="break-all font-mono text-xs">{gate.sas.schema}</dd>
              </>
            ) : null}
            <dt className="text-muted">Gate authority</dt>
            <dd className="break-all font-mono text-xs">{gate.authority}</dd>
          </dl>
        </>
      )}
      <p className="mt-3 text-muted">
        Crosses behind this gate:{' '}
        {gate.crosses.map((c, i) => (
          <span key={c}>
            {i > 0 ? ', ' : ''}
            <Link href={`/crosses/${c}`} className="font-mono text-xs underline underline-offset-2">
              {shortAddress(c)}
            </Link>
          </span>
        ))}
      </p>
      {account && !gate.error ? <Standing gate={gate} account={account} /> : null}
      {!account ? <p className="mt-3 text-xs text-muted">Connect a wallet to see whether you hold a pass and what you can do about it.</p> : null}
    </li>
  );
}

export function GatesView() {
  const [state, setState] = useState<{ state: 'loading' } | { state: 'error'; message: string } | { state: 'ready'; gates: Gate[]; scanned: number }>({ state: 'loading' });
  useEffect(() => {
    let live = true;
    void loadGates().then((r) => live && setState(r.ok ? { state: 'ready', gates: r.data.gates, scanned: r.data.scannedCrosses } : { state: 'error', message: r.error }));
    return () => {
      live = false;
    };
  }, []);
  return (
    <>
      <Presets />
      <section aria-labelledby="gates" className="mt-10">
        <h2 id="gates" className="font-mono text-xs uppercase tracking-widest text-muted">
          Gates behind crosses
        </h2>
        {state.state === 'loading' ? (
          <p role="status" className="mt-3 text-muted">
            Reading gates from recent crosses…
          </p>
        ) : state.state === 'error' ? (
          <p role="alert" className="mt-3 rounded-[var(--radius-card)] border border-border p-5 text-sm text-accent-text" data-testid="gates-error">
            The gates could not be read: {state.message}
          </p>
        ) : state.gates.length === 0 ? (
          <p className="mt-3 rounded-[var(--radius-card)] border border-border p-5 text-sm text-muted" data-testid="gates-empty">
            None of the {state.scanned} most recent crosses has a gate: they are open to any wallet. A gated cross appears here once an issuer creates one.
          </p>
        ) : (
          <ul className="mt-3 space-y-4">
            {state.gates.map((g) => (
              <GateCard key={g.mint} gate={g} />
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
