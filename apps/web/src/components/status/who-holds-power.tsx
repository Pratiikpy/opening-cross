'use client';

import { useCallback, useEffect, useState } from 'react';
import { RPC_URL } from '@/lib/config';
import {
  EXTERNAL_PROGRAMS,
  JUPITER_NOTE,
  OWN_PROGRAMS,
  type ProgramState,
  type Protocol,
  readPower,
} from '@/lib/power';

type Loaded = { own: ProgramState[]; external: ProgramState[]; protocol: { address: string; protocol: Protocol } | null; at: Date };

const FEE_KINDS = ['launch', 'reopen', 'tender', 'recurring'];
const cluster = /devnet/i.test(RPC_URL) ? '?cluster=devnet' : /testnet/i.test(RPC_URL) ? '?cluster=testnet' : '';
const explorer = (a: string) => `https://explorer.solana.com/address/${a}${cluster}`;
const host = (() => {
  try {
    return new URL(RPC_URL).host;
  } catch {
    return RPC_URL;
  }
})();

function Addr({ a }: { a: string }) {
  return (
    <a href={explorer(a)} className="break-all font-mono text-xs underline decoration-border-strong underline-offset-4 hover:text-ink" rel="noreferrer">
      {a}
    </a>
  );
}

function Authority({ s }: { s: ProgramState }) {
  if (!s.found) return <p className="text-sm text-muted">No program found at this address on this network.</p>;
  if (!s.upgradeable) return <p className="text-sm">Not upgradeable: owned by {s.loader}.</p>;
  if (s.authority === null) return <p className="text-sm font-medium">No upgrade authority: this program can never be changed.</p>;
  return (
    <div className="space-y-1">
      <p className="text-sm text-muted">Upgrade authority</p>
      <Addr a={s.authority} />
      <p className="text-sm">
        {s.kind === 'key'
          ? 'A single key. It can replace this program on its own, with no delay and no second approval.'
          : 'An address no private key can sign for (a program-controlled address, for example a multisig vault). Look up the program that controls it to see who can act and whether a delay applies.'}
      </p>
    </div>
  );
}

/** Which roles each address holds across our five programs and the protocol account, so a single key holding everything is said outright. */
function summarise(own: ProgramState[], protocol: Loaded['protocol']): string[] {
  const upgrades = new Map<string, string[]>();
  const roles = new Map<string, string[]>();
  own.forEach((s, i) => {
    if (s.found && s.upgradeable && s.authority) upgrades.set(s.authority, [...(upgrades.get(s.authority) ?? []), OWN_PROGRAMS[i]!.name]);
  });
  if (protocol) {
    for (const [a, r] of [[protocol.protocol.admin, 'protocol admin'], [protocol.protocol.guardian, 'guardian'], [protocol.protocol.feeRecipient, 'fee recipient']] as const) roles.set(a, [...(roles.get(a) ?? []), r]);
  }
  const list = (xs: string[]) => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}` : (xs[0] ?? ''));
  const lines = [...new Set([...upgrades.keys(), ...roles.keys()])].map((a) => {
    const parts = [upgrades.has(a) ? `can upgrade ${list(upgrades.get(a)!)}` : null, roles.has(a) ? `is the ${list(roles.get(a)!)}` : null].filter(Boolean);
    return `${a} ${parts.join(' and ')}.`;
  });
  const frozen = own.filter((s) => s.found && s.upgradeable && s.authority === null).length;
  if (frozen) lines.push(`${frozen} of our programs have no upgrade authority and can never change.`);
  return lines;
}

export function WhoHoldsPower() {
  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [run, setRun] = useState(0);

  const load = useCallback(async () => {
    setError(null);
    setData(null);
    try {
      const ids = [...OWN_PROGRAMS, ...EXTERNAL_PROGRAMS].map((p) => p.id);
      const { programs, protocol } = await readPower(RPC_URL, ids);
      setData({ own: programs.slice(0, OWN_PROGRAMS.length), external: programs.slice(OWN_PROGRAMS.length), protocol, at: new Date() });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load, run]);

  const single = data ? summarise(data.own, data.protocol) : [];

  return (
    <section aria-labelledby="power-h" className="mt-16">
      <h2 id="power-h" className="text-2xl font-semibold tracking-tight">Who holds power</h2>
      <p className="mt-2 max-w-2xl text-sm text-muted">
        Who can change this protocol, and which other people’s programs it depends on. Your browser reads this from the chain through <span className="font-mono">{host}</span> when the page opens; none of it is copied from a document.
      </p>

      {error ? (
        <div role="alert" className="mt-6 rounded-[var(--radius-card)] border border-accent p-4 text-sm">
          <p className="font-medium text-accent-text">The chain could not be read just now.</p>
          <p className="mt-1 text-muted">{error}. Nothing is shown rather than a stale answer.</p>
          <button type="button" onClick={() => setRun((n) => n + 1)} className="mt-3 min-h-10 rounded-full border border-border-strong px-4 hover:bg-surface">
            Try again
          </button>
        </div>
      ) : !data ? (
        <p role="status" className="mt-6 text-sm text-muted">Reading the programs from the chain…</p>
      ) : (
        <>
          <div className="mt-6 rounded-[var(--radius-card)] border border-border-strong bg-surface p-4">
            <p className="text-sm font-medium">What the chain says right now</p>
            <ul className="mt-2 space-y-1 text-sm">
              {single.map((l) => (
                <li key={l} className="break-all">{l}</li>
              ))}
            </ul>
            <p className="mt-3 text-sm text-muted">
              This is a devnet deployment. The plan before any mainnet deployment is to move both the upgrade authority and the admin to a 2 of 3 multisig with a 7 day delay (<a className="underline underline-offset-4 hover:text-ink" href="https://github.com/Pratiikpy/opening-cross/blob/main/docs/adr/0013-governance.md">ADR-0013</a>). That has not happened: the addresses above are what holds the power today. Read at {data.at.toISOString().replace('T', ' ').slice(0, 19)} UTC.
            </p>
          </div>

          <h3 className="mt-10 text-lg font-semibold">Our five programs</h3>
          <ul className="mt-3 divide-y divide-border border-y border-border">
            {OWN_PROGRAMS.map((p, i) => (
              <li key={p.id} className="grid gap-4 py-5 md:grid-cols-[1fr_1.2fr]">
                <div>
                  <p className="font-mono text-sm font-medium">{p.name}</p>
                  <div className="mt-1"><Addr a={p.id} /></div>
                  <p className="mt-2 text-sm text-muted">{p.does}</p>
                </div>
                <div className="space-y-2">
                  <Authority s={data.own[i]!} />
                  <p className="text-sm text-muted">{p.power}</p>
                </div>
              </li>
            ))}
          </ul>

          <h3 className="mt-10 text-lg font-semibold">Protocol settings in cross_core</h3>
          {data.protocol ? (
            <dl className="mt-3 divide-y divide-border border-y border-border text-sm">
              {[
                ['Admin', data.protocol.protocol.admin, 'Sets the fee schedule for new crosses, rotates the guardian, proposes the next admin and can pause new crosses and orders. It cannot touch escrow, change a live cross, or stop claims and refunds.'],
                ['Guardian', data.protocol.protocol.guardian, 'Can pause new crosses and new orders, nothing else. Pausing never blocks reveals, clearing, claims, refunds or finalization.'],
                ['Fee recipient', data.protocol.protocol.feeRecipient, 'Receives the protocol’s share of fees at finalization.'],
              ].map(([k, a, d]) => (
                <div key={k} className="grid gap-1 py-4 md:grid-cols-[10rem_1fr]">
                  <dt className="font-medium">{k}</dt>
                  <dd className="space-y-1">
                    <Addr a={a!} />
                    <p className="text-muted">{d}</p>
                  </dd>
                </div>
              ))}
              <div className="grid gap-1 py-4 md:grid-cols-[10rem_1fr]">
                <dt className="font-medium">State</dt>
                <dd className="text-muted">
                  {data.protocol.protocol.paused ? 'Paused: new crosses and orders are refused.' : 'Not paused.'}{' '}
                  {data.protocol.protocol.pendingAdmin ? (
                    <>
                      An admin handover is pending to <Addr a={data.protocol.protocol.pendingAdmin} />.
                    </>
                  ) : (
                    'No admin handover is pending.'
                  )}{' '}
                  Protocol fee schedule in basis points, before the cap tied to the integrator fee:{' '}
                  {data.protocol.protocol.feeBps.map((b, i) => `${FEE_KINDS[i]} ${b}`).join(', ')}.
                </dd>
              </div>
            </dl>
          ) : (
            <p className="mt-3 text-sm text-muted">The protocol account was not found on this network, so no admin, guardian or fee recipient is set here.</p>
          )}

          <h3 className="mt-10 text-lg font-semibold">Programs we depend on</h3>
          <p className="mt-1 text-sm text-muted">Other people’s code. We cannot change it, and the upgrade authority shown is theirs, read from this same network.</p>
          <ul className="mt-3 divide-y divide-border border-y border-border">
            {EXTERNAL_PROGRAMS.map((p, i) => (
              <li key={p.id} className="grid gap-4 py-5 md:grid-cols-[1fr_1.2fr]">
                <div>
                  <p className="text-sm font-medium">{p.name}</p>
                  <div className="mt-1"><Addr a={p.id} /></div>
                  <p className="mt-2 text-sm text-muted">{p.used}</p>
                </div>
                <div className="space-y-2">
                  <Authority s={data.external[i]!} />
                  <p className="text-sm text-muted">{p.power}</p>
                </div>
              </li>
            ))}
            <li className="py-5">
              <p className="text-sm font-medium">Jupiter</p>
              <p className="mt-1 text-sm text-muted">{JUPITER_NOTE}</p>
            </li>
          </ul>
        </>
      )}
    </section>
  );
}
