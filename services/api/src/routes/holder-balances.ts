// What a wallet holds, read through the API's own cluster access (ROADMAP Y9, M6, I3): GET /v1/balances/:owner?mints=a,b&sol=1.
//
// The portfolio and the readiness checklist need a wallet's balance of a few tokens. A browser asking the public cluster endpoints for each
// one is rate limited and fills the console with failed requests, so the API reads them with the retries and failover it already has.
// A token is read from the owner's associated token account of that mint, which is where every flow of this product puts tokens. A
// balance that could not be read is marked `unavailable`, never reported as zero.
import type { FastifyInstance, FastifyReply } from 'fastify';
import { type Address, isAddress } from '@solana/kit';
import { ata } from '@opening-cross/sdk';
import { RequestError } from '../tx.js';

type ChainAccount = { data: Uint8Array; owner: Address };

export type HolderBalanceDeps = {
  account: (a: Address) => Promise<ChainAccount | null>;
  /** Lamports of an account. Defaults to JSON-RPC against RPC_URL (its first answering endpoint). */
  lamports?: (a: Address) => Promise<bigint>;
};

export const MAX_MINTS = 20;

export type MintBalance =
  | { mint: string; status: 'ok'; amount: bigint; decimals: number; tokenProgram: string }
  | { mint: string; status: 'not-a-mint' }
  | { mint: string; status: 'unavailable'; reason: string };

/** SPL mint layout (shared by both token programs): decimals sit at byte 44; a token account's amount at byte 64. */
export function mintDecimals(data: Uint8Array): number | null {
  return data.length >= 82 ? data[44]! : null;
}
export function tokenAmount(data: Uint8Array): bigint {
  return data.length >= 72 ? new DataView(data.buffer, data.byteOffset).getBigUint64(64, true) : 0n;
}

const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));
const send = (reply: FastifyReply, v: unknown, status = 200) => reply.code(status).type('application/json').send(json(v));

async function rpcLamports(a: Address): Promise<bigint> {
  const urls = (process.env.RPC_URL ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  let last: unknown = new Error('RPC_URL is not set');
  for (const url of urls) {
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getBalance', params: [a, { commitment: 'confirmed' }] }), signal: AbortSignal.timeout(10_000) });
      const j = (await r.json()) as { result?: { value: number }; error?: { message: string } };
      if (j.error || !j.result) throw new Error(j.error?.message ?? 'no result');
      return BigInt(j.result.value);
    } catch (e) {
      last = e;
    }
  }
  throw last;
}

export function registerHolderBalances(app: FastifyInstance, deps: HolderBalanceDeps) {
  const lamports = deps.lamports ?? rpcLamports;
  app.get('/v1/balances/:owner', async (req, reply) => {
    const owner = (req.params as { owner: string }).owner;
    if (!isAddress(owner)) throw new RequestError(400, 'owner must be a base58 Solana address');
    const q = req.query as { mints?: string; sol?: string };
    const mints = (q.mints ?? '').split(',').filter(Boolean);
    if (mints.length > MAX_MINTS) throw new RequestError(400, `at most ${MAX_MINTS} mints per request`);
    for (const m of mints) if (!isAddress(m)) throw new RequestError(400, `${m} is not a base58 Solana address`);
    if (mints.length === 0 && q.sol !== '1') throw new RequestError(400, 'ask for mints (mints=a,b) or the SOL balance (sol=1)');

    const read = async (mint: string): Promise<MintBalance> => {
      try {
        const m = await deps.account(mint as Address);
        const decimals = m ? mintDecimals(m.data) : null;
        if (!m || decimals === null) return { mint, status: 'not-a-mint' };
        const held = await deps.account(await ata(owner, mint as Address, m.owner));
        return { mint, status: 'ok', amount: held ? tokenAmount(held.data) : 0n, decimals, tokenProgram: m.owner };
      } catch (e) {
        return { mint, status: 'unavailable', reason: String(e instanceof Error ? e.message : e).slice(0, 120) };
      }
    };
    const balances: MintBalance[] = [];
    for (let i = 0; i < mints.length; i += 4) balances.push(...(await Promise.all(mints.slice(i, i + 4).map(read))));
    let sol: { status: 'ok'; lamports: bigint } | { status: 'unavailable' } | undefined;
    if (q.sol === '1') sol = await lamports(owner).then((l) => ({ status: 'ok' as const, lamports: l }), () => ({ status: 'unavailable' as const }));
    return send(reply, { owner, balances, ...(sol ? { sol } : {}), note: 'Token balances are read from the owner’s associated token account of each mint.' });
  });
}
