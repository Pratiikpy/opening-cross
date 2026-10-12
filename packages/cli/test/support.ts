// Shared helpers for the CLI tests that need no chain: a captured terminal and a fake JSON-RPC endpoint.
import { createHash } from 'node:crypto';
import { type Address, getAddressDecoder } from '@solana/kit';
import { CrossKind, CrossState, Disclosure, SupplyMode, getCrossEncoder } from '@opening-cross/sdk';
import { run } from '../src/main.js';

export const key = (label: string): Address => getAddressDecoder().decode(createHash('sha256').update(`cli test: ${label}`).digest());

export type Captured = { code: number; out: string[]; err: string[]; stdout: string; stderr: string };

export async function cli(argv: string[], opts: { env?: Record<string, string>; fetch?: typeof fetch } = {}): Promise<Captured> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, {
    io: { out: (l) => out.push(l), err: (l) => err.push(l) },
    env: opts.env ?? {},
    fetch: opts.fetch ?? ((async () => {
      throw new Error('the test did not expect any network request');
    }) as unknown as typeof fetch),
    sleep: async () => {},
  });
  return { code, out, err, stdout: out.join('\n'), stderr: err.join('\n') };
}

export const CROSS_ADDRESS = key('cross');

/** A live, open-book, escrow cross with a 1.00 to 1.50 grid; windows are relative to `now`. */
export function crossBytes(now: number, over: Record<string, unknown> = {}): Uint8Array {
  const args = {
    creator: key('creator'),
    crossId: 7n,
    kind: CrossKind.Launch,
    supplyMode: SupplyMode.Escrow,
    disclosure: Disclosure.Open,
    state: CrossState.Live,
    baseMint: key('base'),
    quoteMint: key('quote'),
    baseTokenProgram: key('token-program-a'),
    quoteTokenProgram: key('token-program-b'),
    baseDecimals: 6,
    quoteDecimals: 6,
    proceedsTo: key('proceeds'),
    minPrice: 1_000_000n,
    tick: 50_000n,
    ticks: 11,
    priceScale: 1_000_000n,
    openTs: BigInt(now - 60),
    closeTs: BigInt(now + 3_600),
    revealEndTs: BigInt(now + 3_600),
    referencePrice: null,
    minMatched: 0n,
    maxImbalanceBps: null,
    protocolFeeBps: 5,
    integratorFeeBps: 20,
    integrator: key('integrator'),
    feeRecipient: key('fee'),
    gateMint: null,
    shards: 2,
    maxOrders: 100,
    dustBond: 0n,
    ordersTotal: 3,
    ordersOpen: 3,
    mergedMask: 0,
    clearing: null,
    noPrintReason: null,
    buyerPaid: 0n,
    baseBought: 0n,
    baseSold: 0n,
    sellerPaid: 0n,
    feesAccrued: 0n,
    oracle: null,
    calendar: null,
    settler: null,
    settleDeadlineTs: 0n,
    baseBound: true,
    bump: 255,
    quoteVaultBump: 254,
    baseVaultBump: 253,
    bookBump: 252,
    ...over,
  };
  return Uint8Array.from(getCrossEncoder().encode(args as never));
}

const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64');

/** A JSON-RPC endpoint that serves the given accounts and a clock, and records every method it was asked. */
export function fakeRpc(accounts: Record<string, { data: Uint8Array; owner: string }>, nowSeconds: number) {
  const calls: string[] = [];
  const f = (async (_url: string, init?: RequestInit) => {
    const { method, params } = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
    calls.push(method);
    const result = (() => {
      switch (method) {
        case 'getAccountInfo': {
          const a = accounts[params[0] as string];
          return { context: { slot: 1 }, value: a ? { data: [b64(a.data), 'base64'], owner: a.owner, lamports: 1_000_000, executable: false } : null };
        }
        case 'getMultipleAccounts':
          return { context: { slot: 1 }, value: (params[0] as string[]).map((k) => (accounts[k] ? { data: [b64(accounts[k]!.data), 'base64'], owner: accounts[k]!.owner, lamports: 1, executable: false } : null)) };
        case 'getSlot':
          return 100;
        case 'getBlockTime':
          return nowSeconds;
        default:
          throw new Error(`the fake RPC does not serve ${method}`);
      }
    })();
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { fetch: f, calls };
}
