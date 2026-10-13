// Registers every route group of workstream W2A in one call, from the environment, so wiring them into the server is one line:
//
//     const w2a = await registerW2A(app, deps, process.env);       // after the existing routes, before app.listen
//     setInterval(() => void w2a.reconcile?.().catch(console.error), 60_000);   // settles x402 payments that were left half done
//
// The groups: market-maker liquidity and signed intents, pay-per-call (x402/MPP), Solana Actions (Blinks), routed execution, fees and
// referrals, duplicate-token detection, integrity analysis, the live dashboard, the preset registry and agent identity. The dashboard is
// registered last because it reads the others through the server itself.
//
// Environment (docs/CONFIGURATION.md): RPC_URL (a comma separated list is tried in order with health scoring), OWN_WALLETS, the X402_* and
// ATTESTATION_KEYPAIR variables of paid-config.ts, and
//   BACKING_ATTESTERS            comma separated addresses whose backing attestations count (empty: none do)
//   BACKING_MAX_AGE_SECS         oldest an attestation may be (default 604800)
//   INTEGRITY_SERVICE_FUNDERS    comma separated addresses known to fund many unrelated wallets (an exchange, a faucet)
//   INTEGRITY_SERVICE_FANOUT     a funder that funded this many wallets is treated as a service (default 25)
//   INTEGRITY_MAX_TRACE          wallet histories read per request (default 24)
//   AGENT_REGISTRY_RPC_URL       RPC for the agent registry, which has real data on mainnet (default RPC_URL)
//   JUPITER_BASE                 Jupiter swap API base for /v1/route/execute (mainnet only)
//   W2A_SKIP                     comma separated group names to leave out
import type { FastifyInstance } from 'fastify';
import { FailoverRpc } from '@opening-cross/reliability';
import { keyPairFromSolanaFile } from '@opening-cross/attest';
import { readFileSync } from 'node:fs';
import type { ApiDeps } from '../server.js';
import { registerAgents } from './agents.js';
import { registerBlinks } from './blinks.js';
import { registerDashboard } from './dashboard.js';
import { registerTokenDuplicates } from './duplicates.js';
import { registerExecute } from './execute.js';
import { registerFees } from './fees.js';
import { registerIntegrity } from './integrity.js';
import { registerLiquidity } from './liquidity.js';
import { paidFromEnv } from './paid-config.js';
import { registerPaid } from './paid.js';
import { registerPresets } from './presets.js';

export const GROUPS = ['liquidity', 'paid', 'blinks', 'execute', 'fees', 'duplicates', 'integrity', 'presets', 'agents', 'dashboard'] as const;
export type Group = (typeof GROUPS)[number];

export interface W2A {
  registered: Group[];
  /** Settles x402 payments left half done by a restart; run it on a timer when pay-per-call is on, otherwise null. */
  reconcile: (() => Promise<unknown>) | null;
  /** The pooled RPC the groups share. */
  rpc: FailoverRpc;
}

const list = (v: string | undefined): string[] => (v ?? '').split(/[,\s]+/).filter(Boolean);

export async function registerW2A(app: FastifyInstance, d: ApiDeps, env: Record<string, string | undefined>): Promise<W2A> {
  const skip = new Set(list(env.W2A_SKIP));
  for (const s of skip) if (!(GROUPS as readonly string[]).includes(s)) throw new Error(`W2A_SKIP names an unknown group "${s}"; the groups are ${GROUPS.join(', ')}`);
  const urls = list(env.RPC_URL);
  if (urls.length === 0) throw new Error('RPC_URL is required');
  const rpc = new FailoverRpc(urls, { rounds: 2 });
  const registered: Group[] = [];
  const on = (g: Group, fn: () => void | Promise<void>) => {
    if (skip.has(g)) return;
    registered.push(g);
    return fn();
  };

  await on('liquidity', () => registerLiquidity(app, { db: d.db, account: d.account, ...(d.clock ? { clock: d.clock } : {}), ...(d.ownWallets ? { ownWallets: d.ownWallets } : {}) }));

  let reconcile: W2A['reconcile'] = null;
  await on('paid', async () => {
    const paid = await paidFromEnv(env, d.db);
    registerPaid(app, { db: d.db, account: d.account, lifetime: d.lifetime, ...(d.clock ? { clock: d.clock } : {}), ...(d.network ? { network: d.network } : {}) }, paid.options);
    reconcile = paid.gate ? () => paid.gate!.reconcile() : null;
  });

  await on('blinks', () => registerBlinks(app, { account: d.account, lifetime: d.lifetime, ...(d.clock ? { clock: d.clock } : {}), ...(d.network ? { network: d.network } : {}) }));
  await on('execute', () => registerExecute(app, { db: d.db, account: d.account, lifetime: d.lifetime, ...(d.clock ? { clock: d.clock } : {}), ...(d.network ? { network: d.network } : {}), ...(d.dexQuote ? { dexQuote: d.dexQuote } : {}) }, env.JUPITER_BASE ? { jupiterBase: env.JUPITER_BASE } : {}));

  await on('fees', async () => {
    const signer = env.ATTESTATION_KEYPAIR ? await keyPairFromSolanaFile(readFileSync(env.ATTESTATION_KEYPAIR, 'utf8')) : null;
    registerFees(app, { db: d.db, account: d.account, ...(d.clock ? { clock: d.clock } : {}), ...(d.network ? { network: d.network } : {}) }, { signer, transaction: async (sig) => {
      const j = await rpc.call<{ meta?: { err: unknown; preTokenBalances?: never[]; postTokenBalances?: never[] } } | null>('getTransaction', [sig, { encoding: 'jsonParsed', commitment: 'confirmed', maxSupportedTransactionVersion: 1 }]);
      const meta = j?.meta;
      return meta ? { err: meta.err, preTokenBalances: meta.preTokenBalances ?? [], postTokenBalances: meta.postTokenBalances ?? [] } : null;
    } });
  });

  await on('duplicates', () => registerTokenDuplicates(app, { db: d.db, account: d.account }));

  await on('integrity', () =>
    registerIntegrity(app, { db: d.db, account: d.account, ...(d.clock ? { clock: d.clock } : {}), ...(d.network ? { network: d.network } : {}) }, {
      rpc,
      trustedAttesters: new Set(list(env.BACKING_ATTESTERS)),
      serviceFunders: new Set(list(env.INTEGRITY_SERVICE_FUNDERS)),
      ...(env.INTEGRITY_SERVICE_FANOUT ? { serviceFanout: Number(env.INTEGRITY_SERVICE_FANOUT) } : {}),
      ...(env.INTEGRITY_MAX_TRACE ? { maxTrace: Number(env.INTEGRITY_MAX_TRACE) } : {}),
      ...(env.BACKING_MAX_AGE_SECS ? { backingMaxAgeSecs: Number(env.BACKING_MAX_AGE_SECS) } : {}),
    }),
  );

  await on('presets', () =>
    registerPresets(app, { db: d.db, ...(d.clock ? { clock: d.clock } : {}), ...(d.network ? { network: d.network } : {}) }, {
      memosOf: async (sig) => {
        const j = await rpc.call<{ transaction: { message: { instructions: { program?: string; parsed?: unknown }[] } }; meta?: { innerInstructions?: { instructions: { program?: string; parsed?: unknown }[] }[] } } | null>('getTransaction', [sig, { encoding: 'jsonParsed', commitment: 'confirmed', maxSupportedTransactionVersion: 1 }]);
        if (!j) return null;
        const all = [...j.transaction.message.instructions, ...(j.meta?.innerInstructions ?? []).flatMap((i) => i.instructions)];
        return all.filter((i) => i.program === 'spl-memo' && typeof i.parsed === 'string').map((i) => i.parsed as string);
      },
      ...(d.ownWallets ? { ownWallets: d.ownWallets } : {}),
    }),
  );

  await on('agents', () => registerAgents(app, { db: d.db, ...(d.network ? { network: d.network } : {}) }, { rpc: env.AGENT_REGISTRY_RPC_URL ? new FailoverRpc(list(env.AGENT_REGISTRY_RPC_URL), { rounds: 2 }) : rpc }));

  // Last: it fetches the others' routes through the server itself.
  await on('dashboard', () => registerDashboard(app, { account: d.account, ...(d.network ? { network: d.network } : {}), ...(d.clock ? { clock: d.clock } : {}) }));

  return { registered, reconcile, rpc };
}
