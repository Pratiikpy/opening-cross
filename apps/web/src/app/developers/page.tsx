import type { Metadata } from 'next';
import { API_URL } from '@/lib/api';

export const metadata: Metadata = { title: 'Developers' };

const QUICKSTART = `git clone https://github.com/Pratiikpy/opening-cross && cd opening-cross
pnpm install --frozen-lockfile
sh scripts/build-programs.sh          # Agave 4.0.x
sh examples/ts-quickstart/run.sh     # packs the SDK, installs it in a clean project, runs a full cross`;

const ROUTES: [string, string][] = [
  ['GET  /v1/health', 'Indexed slot and recent reconciliation alerts.'],
  ['GET  /v1/stats', 'Protocol totals, with the network named.'],
  ['GET  /v1/crosses?state=&limit=', 'Crosses, newest first.'],
  ['GET  /v1/crosses/:address', 'One cross, read from chain.'],
  ['GET  /v1/crosses/:address/book', 'Resting book (merged and unmerged shards) and the price it would clear at now.'],
  ['GET  /v1/crosses/:address/orders', 'Indexed orders with fills.'],
  ['GET  /v1/crosses/:address/proof', 'Fairness proof: the clearing recomputed independently.'],
  ['GET  /v1/orders?addresses=a,b', 'Orders by address; open ones read from chain.'],
  ['GET  /v1/owners/:owner/orders', 'All orders of one wallet across crosses.'],
  ['POST /v1/tx/{create-cross,place-order,cancel,reveal,settle,claim,finalize}', 'Unsigned transactions; your wallet signs and sends.'],
  ['WS   /v1/stream?cross=', 'Every event as the indexer commits it.'],
];

const PACKAGES: [string, string][] = [
  ['@opening-cross/sdk', 'Instruction builders for every step of a cross, on @solana/kit.'],
  ['@opening-cross/verifier', 'Recompute any cross; fairness proofs; the conformance suite (opening-cross-conformance).'],
  ['@opening-cross/router', 'Compare a cross with a live Jupiter route at the same moment.'],
  ['opening-cross-cpi (Rust)', 'CPI bindings and PDA derivations for your own program.'],
];

export default function Developers() {
  return (
    <div className="mx-auto max-w-[1000px] px-4 py-12 sm:px-6">
      <h1 className="text-[34px] font-semibold tracking-tight">Developers</h1>
      <p className="mt-2 max-w-2xl text-muted">
        Opening Cross is open source (Apache-2.0). Everything this app does goes through the same SDK, API and programs available to you.
      </p>

      <h2 className="mt-12 text-xl font-semibold">Run a full cross in five minutes</h2>
      <p className="mt-2 text-sm text-muted">These are the commands CI runs on a fresh machine for every change.</p>
      <pre tabIndex={0} className="mt-4 overflow-x-auto rounded-[var(--radius-card)] bg-inverse-bg p-4 font-mono text-[13px] leading-6 text-inverse-ink">
        <code>{QUICKSTART}</code>
      </pre>

      <h2 className="mt-12 text-xl font-semibold">Packages</h2>
      <ul className="mt-4 grid gap-3 sm:grid-cols-2">
        {PACKAGES.map(([name, text]) => (
          <li key={name} className="rounded-[var(--radius-card)] border border-border p-4">
            <p className="font-mono text-sm text-accent-text">{name}</p>
            <p className="mt-1 text-sm text-muted">{text}</p>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-sm text-muted">Registry publishing is pending; until then install from the repository or the packed tarballs.</p>

      <h2 className="mt-12 text-xl font-semibold">API</h2>
      <p className="mt-2 text-sm text-muted">
        Base URL: <code className="font-mono">{API_URL}</code>. Integers are decimal strings. Errors return a 4xx status and{' '}
        <code className="font-mono">{'{ "error": "…" }'}</code> naming the field at fault.
      </p>
      <dl className="mt-4 divide-y divide-border border-y border-border text-sm">
        {ROUTES.map(([r, d]) => (
          <div key={r} className="grid gap-1 py-3 sm:grid-cols-[1.4fr_1fr]">
            <dt className="break-all font-mono text-xs">{r}</dt>
            <dd className="text-muted">{d}</dd>
          </div>
        ))}
      </dl>

      <h2 className="mt-12 text-xl font-semibold">Check any result yourself</h2>
      <pre tabIndex={0} className="mt-4 overflow-x-auto rounded-[var(--radius-card)] bg-inverse-bg p-4 font-mono text-[13px] leading-6 text-inverse-ink">
        <code>{`npx opening-cross-verify <cross-address> --rpc <your RPC URL>
npx opening-cross-conformance     # 525 vectors from the on-chain clearing code`}</code>
      </pre>
    </div>
  );
}
