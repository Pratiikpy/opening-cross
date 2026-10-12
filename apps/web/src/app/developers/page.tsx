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
  ['GET  /v1/crosses/:address/promise', 'The latest signed price band for a cross, with its grade once graded.'],
  ['GET  /v1/promises/:id', 'A signed promise with its grade and its on-chain anchor proof. Add /inputs for the book it was computed from.'],
  ['GET  /v1/promises/signer', 'The key that signs promises; promises by any other key are not ours.'],
  ['GET  /v1/accuracy', 'Every signed band counted by outcome, with calibration per time bucket.'],
  ['GET  /v1/tokens/:mint/authenticity', "Is this the issuer's real token? Mainnet mints only."],
  ['GET  /v1/crosses/:address/authenticity', 'The same check for both tokens of a cross.'],
  ['GET  /v1/premium/summary?days=', 'Stock-token premium by order size and market session, with exclusions counted.'],
  ['GET  /v1/premium/latest', 'The newest premium measurement for each token.'],
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
  ['@opening-cross/promises', 'Verify a signed price band yourself: id, signature, the book it was computed from, and its grade against the chain.'],
  ['@opening-cross/authenticity', "Is this the issuer's real token? Issuer lists, issuer keys on chain, and copy detection."],
  ['@opening-cross/premium', 'Executable per-share premium of Solana stock tokens against an independent reference.'],
  ['@opening-cross/mcp', 'An MCP server for agents: reads and unsigned drafts only, third-party text wrapped as data.'],
];

export default function Developers() {
  return (
    <div className="mx-auto max-w-[1000px] px-4 py-12 sm:px-6">
      <h1 className="text-[34px] font-semibold tracking-tight">Developers</h1>
      <p className="mt-2 max-w-2xl text-muted">
        Opening Cross is Apache-2.0 licensed. Everything this app does goes through the same SDK, API and programs available to you.
      </p>

      <h2 className="mt-12 text-xl font-semibold">Run a full cross locally</h2>
      <p className="mt-2 text-sm text-muted">
        These are the commands CI runs on a fresh machine for every change. They need Linux (or WSL on Windows), Node 22, pnpm 10, Rust 1.96.1
        and Agave 4.0.2 (<code className="font-mono">cargo build-sbf</code>); the first program build takes several minutes.
      </p>
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
      <p className="mt-3 text-sm text-muted">These packages are not on a public registry yet. Until they are, use them from the repository (`pnpm install` links them) or from the tarballs `examples/ts-quickstart/run.sh` packs.</p>

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
        <code>{`# from a clone of the repository, after pnpm install
pnpm --filter @opening-cross/verifier verify <cross-address> --rpc <your RPC URL>
pnpm --filter @opening-cross/verifier conformance     # 525 vectors from the on-chain clearing code`}</code>
      </pre>
    </div>
  );
}
