// The pool routes of the API (services/api/src/routes/pools.ts, ADR-0920 to ADR-0924), over HTTP against real pool accounts read back from devnet.
//
// The route runs in a Fastify instance of its own, with the same error handler the server has. Accounts are the ones in
// packages/router/test/fixtures/devnet-pools.json: two DLMM pairs, one DAMM v2 pool, their six Token-2022 mints and the Clock sysvar, as they were on chain.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Address, type Instruction, decompileTransactionMessage, getAddressDecoder, getAddressEncoder, getCompiledTransactionMessageDecoder, getTransactionDecoder, none, some } from '@solana/kit';
import { TOKEN_2022_PROGRAM_ADDRESS, getMintEncoder } from '@solana-program/token-2022';
import { CROSS_CORE_PROGRAM_ADDRESS, CrossKind, CrossState, Disclosure, SupplyMode, ata, getCrossEncoder, getLevelsEncoder } from '@opening-cross/sdk';
import { bookAddressOf } from '@opening-cross/verifier';
import { RequestError } from '../src/tx.js';
import { decimalOf, registerPools } from '../src/routes/pools.js';
import { registerDashboard } from '../src/routes/dashboard.js';
import { holderDb } from './helpers/holder-pg.js';
import { dlmmEngine, decodeBinArray, decodeLbPair, dammCanonicalPool, dlmmCanonicalPair, engineDepth } from '../../../packages/adapters/src/health.js';

type Fx = { accounts: Record<string, { owner: string; data: string }>; pools: { 'dlmm-proof': { pair: string; binArrays: { address: string }[] }; 'dlmm-ladder': { pair: string; binArrays: { address: string }[] }; 'damm-proof': { pool: string } } };
const fx = JSON.parse(readFileSync(new URL('../../../packages/router/test/fixtures/devnet-pools.json', import.meta.url), 'utf8')) as Fx;
type Account = { data: Uint8Array; owner: Address };
const fixtureAccounts = (): Map<string, Account> => new Map(Object.entries(fx.accounts).map(([k, v]) => [k, { data: new Uint8Array(Buffer.from(v.data, 'base64')), owner: v.owner as Address }]));

const T22 = TOKEN_2022_PROGRAM_ADDRESS;
const P = {
  one: { pair: fx.pools['dlmm-proof'].pair, x: 'AypfHSmpMQ2C1zaGRHRyoYbQBjFA8Wphc7AQrkmCLZXN', y: 'HRYt8BVWnDkBNXJQ8CUpAkVEaQUgFeUAshGCRAk8JEGN' },
  ladder: { pair: fx.pools['dlmm-ladder'].pair, x: 'BdbY4wWxCKv1CX9xY5XSbjexeZUFQimyhPp86jgmhakt', y: 'B8yoGNPDWTaWK86Po4V1nBGnqHTCvSKn839kAgrksQHJ' },
  damm: { pool: fx.pools['damm-proof'].pool, a: 'EkisVxYv7x5pJfXUM75WiQC9AgYKy2ps5R3pyTEeovCV', b: '7BavPghywmfMMvt7VctXpFvqKCB8kwnXDyA2iZUQzidy' },
} as const;
const key = (label: string): Address => getAddressDecoder().decode(createHash('sha256').update(`api pools test: ${label}`).digest());
const TRADER = key('trader');
const CLOCK = 'SysvarC1ock11111111111111111111111111111111';
const BLOCKHASH = '4NCYB3kRT8sCNodPNuCZo8VkwveZSHhg7R7mrRBFM1Uy' as never;

function mintBytes(extensions: unknown[] | null, decimals = 9, authority = false) {
  const data = getMintEncoder().encode({ mintAuthority: authority ? some(key('auth')) : none(), supply: 1_000n, decimals, isInitialized: true, freezeAuthority: none(), extensions: extensions ? some(extensions) : none() } as never);
  return { data: new Uint8Array(extensions ? data : data.slice(0, 82)), owner: T22 };
}
function tokenAccount(mint: Address, owner: Address, amount: bigint): Account {
  const b = new Uint8Array(165);
  b.set(getAddressEncoder().encode(mint), 0);
  b.set(getAddressEncoder().encode(owner), 32);
  new DataView(b.buffer).setBigUint64(64, amount, true);
  b[108] = 1; // initialized
  return { data: b, owner: T22 };
}
async function give(accounts: Map<string, Account>, owner: Address, mint: string, amount: bigint) {
  accounts.set(await ata(owner, mint as Address, T22), tokenAccount(mint as Address, owner, amount));
}

function crossBytes(over: Record<string, unknown> = {}): Uint8Array {
  const now = Number(new DataView(fixtureAccounts().get(CLOCK)!.data.buffer).getBigInt64(32, true));
  return Uint8Array.from(
    getCrossEncoder().encode({
      creator: key('creator'), crossId: 7n, kind: CrossKind.Launch, supplyMode: SupplyMode.Escrow, disclosure: Disclosure.Open, state: CrossState.Live,
      baseMint: P.one.x as Address, quoteMint: P.one.y as Address, baseTokenProgram: T22, quoteTokenProgram: T22, baseDecimals: 6, quoteDecimals: 6, proceedsTo: key('proceeds'),
      minPrice: 1_000_000n, tick: 50_000n, ticks: 11, priceScale: 1_000_000n, openTs: BigInt(now - 60), closeTs: BigInt(now + 3_600), revealEndTs: BigInt(now + 3_600),
      referencePrice: null, minMatched: 0n, maxImbalanceBps: null, protocolFeeBps: 5, integratorFeeBps: 20, integrator: key('integrator'), feeRecipient: key('fee'), gateMint: null,
      shards: 2, maxOrders: 100, dustBond: 0n, ordersTotal: 4, ordersOpen: 4, mergedMask: 3, clearing: null, noPrintReason: null, buyerPaid: 0n, baseBought: 0n, baseSold: 0n,
      sellerPaid: 0n, feesAccrued: 0n, oracle: null, calendar: null, settler: null, settleDeadlineTs: 0n, baseBound: true, bump: 255, quoteVaultBump: 254, baseVaultBump: 253, bookBump: 252,
      ...over,
    } as never),
  );
}
const clearing = (price: bigint) => ({ price, matched: 1_000_000_000n, demand: 1_000_000_000n, supply: 1_000_000_000n, rationed: 0, marginalQuantity: 0n, marginalRemaining: 0n, marginalOrders: 0 });
function levelsBytes(buy: Record<number, bigint>, sell: Record<number, bigint>): Uint8Array {
  const arr = (m: Record<number, bigint>) => Array.from({ length: 256 }, (_, i) => m[i] ?? 0n);
  const cnt = (m: Record<number, bigint>) => Array.from({ length: 256 }, (_, i) => (m[i] ? 1 : 0));
  return Uint8Array.from(getLevelsEncoder().encode({ cross: CROSS, buy: arr(buy), sell: arr(sell), buyOrders: cnt(buy), sellOrders: cnt(sell), index: 0, pad: new Uint8Array(7) } as never));
}
const CROSS = key('cross');

type Harness = { app: FastifyInstance; accounts: Map<string, Account>; get: (url: string) => Promise<{ status: number; body: any }>; post: (url: string, body: unknown) => Promise<{ status: number; body: any }> };
async function harness(opts: { accounts?: Map<string, Account>; router?: 'ranking' | 'absent' | 'missing-mint'; db?: unknown } = {}): Promise<Harness> {
  const accounts = opts.accounts ?? fixtureAccounts();
  const app = Fastify();
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof RequestError) return reply.code(err.status).type('application/json').send(JSON.stringify({ error: err.message, ...err.detail }, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
    return reply.code(500).send({ error: String(err) });
  });
  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: 'no such route' }));
  if (opts.router === 'ranking') {
    app.get('/v1/router/quote', async (req) => {
      const q = req.query as Record<string, string>;
      return {
        schema: 'opening-cross/router-quote/v1',
        network: 'devnet',
        intent: { base: q.base, quote: q.quote, side: q.side, amount: q.amount },
        base: { decimals: 9 },
        priceUnit: 'quote atoms per one whole base token',
        venues: [{ rank: 1, venue: 'cross', cross: CROSS, baseAtoms: q.amount, quoteAtoms: '0', pricePerBase: '1500000000', fill: 'full', indicative: true, executableNow: false }],
        excluded: [{ venue: 'jupiter', reason: 'Jupiter routes mainnet liquidity only' }, { venue: 'meteora', reason: 'The router does not price Meteora pools directly. When a Meteora pool has liquidity for the pair, Jupiter may route through it.' }],
        best: { venue: 'cross', cross: CROSS },
        caveats: ['A cross price is indicative.', 'This is a quote comparison only. Nothing is signed or sent.'],
      };
    });
  }
  if (opts.router === 'missing-mint') app.get('/v1/router/quote', async (_req, reply) => reply.code(404).send({ error: 'mint is not on chain', reason: 'MINT_NOT_FOUND' }));
  registerPools(
    app,
    {
      account: async (a) => accounts.get(a) ?? null,
      lifetime: async () => ({ blockhash: BLOCKHASH, lastValidBlockHeight: 123n }),
      network: 'devnet',
      ...(opts.db ? { db: opts.db as never } : {}),
    },
    { summaryTtlMs: 0 },
  );
  await app.ready();
  const call = async (method: 'GET' | 'POST', url: string, body?: unknown) => {
    const r = await app.inject({ method, url, ...(body !== undefined ? { payload: body as never } : {}) });
    return { status: r.statusCode, body: JSON.parse(r.body) };
  };
  return { app, accounts, get: (u) => call('GET', u), post: (u, b) => call('POST', u, b) };
}

const decode = (tx: string): Instruction[] => {
  const decoded = getTransactionDecoder().decode(Uint8Array.from(Buffer.from(tx, 'base64')));
  return decompileTransactionMessage(getCompiledTransactionMessageDecoder().decode(decoded.messageBytes)).instructions as Instruction[];
};

describe('decimalOf', () => {
  it('formats atoms as a decimal, trimming zeros, and keeps the sign', () => {
    expect(decimalOf(1_234_500n, 6)).toBe('1.2345');
    expect(decimalOf(1_000_000n, 6)).toBe('1');
    expect(decimalOf(5n, 6)).toBe('0.000005');
    expect(decimalOf(-1_500_000n, 6)).toBe('-1.5');
    expect(decimalOf(1_299_356_123_456_789n, 18, 9)).toBe('0.001299356');
    expect(decimalOf(0n, 9)).toBe('0');
  });
});

describe('GET /v1/pools/:address', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await harness();
  });
  afterAll(() => h.app.close());

  it('reports a DLMM pair: price, reserves, fee, depth both ways, impact, the bin ladder and where every figure came from', async () => {
    const r = await h.get(`/v1/pools/${P.one.pair}`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const b = r.body;
    expect(b).toMatchObject({ schema: 'opening-cross/pool-health/v1', kind: 'dlmm', pool: P.one.pair, network: 'devnet' });
    expect(b.chain.source).toBe('the Clock sysvar');
    expect(b.base.mint).toBe(P.one.x);
    expect(b.quote.mint).toBe(P.one.y);
    expect(b.baseIsA).toBe(true);
    expect(b.base.decimals).toBe(6);
    // active bin 262 of a 10 bps pair: (1.001)^262 = 1.2994
    expect(b.price.quotePerBase).toMatch(/^1\.2993/);
    expect(b.status).toMatchObject({ open: true });
    expect(b.fee).toMatchObject({ kind: 'dlmm', baseFeeBps: 10, binStepBps: 10 });
    // reserves equal what the loaded bins hold: A3 evidence ended with 1,033,509,715 quote in the pair and the proof's ladder left 804,995,000 base
    expect(b.liquidity.baseReserve).toBe('804995000');
    expect(b.liquidity.quoteReserve).toBe('1033509715');
    expect(b.depth).toHaveLength(6);
    const d100 = b.depth.find((x: { maxSlippageBps: string }) => x.maxSlippageBps === '100');
    expect(BigInt(d100.sellBase.maxBaseIn)).toBeGreaterThan(0n);
    expect(BigInt(d100.buyBase.maxQuoteIn)).toBeGreaterThan(0n);
    // the depth is the engine's: recompute it here from the same accounts
    const pair = decodeLbPair(fixtureAccounts().get(P.one.pair)!.data);
    const arrays = fx.pools['dlmm-proof'].binArrays.map((x) => decodeBinArray(fixtureAccounts().get(x.address)!.data));
    const clock = new DataView(fixtureAccounts().get(CLOCK)!.data.buffer).getBigInt64(32, true);
    const direct = engineDepth(dlmmEngine({ pair, arrays, nowSeconds: clock }), true, 100n);
    expect(d100.sellBase.maxBaseIn).toBe(direct.maxIn.toString());
    expect(b.impact.sellBase.length).toBeGreaterThan(3);
    expect(b.impact.sellBase[0]).toMatchObject({ percentOfReserve: 0.1, partial: false });
    expect(b.ladder.some((x: { role: string }) => x.role === 'active')).toBe(true);
    expect(b.sources[0]).toBe(P.one.pair);
    expect(b.sources.length).toBeGreaterThan(1);
    expect(b.swapTx).toEqual({ supported: true, reason: null });
    expect(b.caveats.join(' ')).toMatch(/bin arrays read/);
  });

  it('reports a DAMM v2 pool: the same shape, no ladder, the fee from the pool account', async () => {
    const r = await h.get(`/v1/pools/${P.damm.pool}`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ kind: 'damm-v2', ladder: null });
    expect(r.body.fee).toMatchObject({ kind: 'damm-v2', cliffFeeBps: 30, collects: 'token B only' });
    // 0.30% fee: no depth within 25 bps, some within 100
    expect(r.body.depth[1].sellBase.maxBaseIn).toBe('0');
    expect(BigInt(r.body.depth[3].sellBase.maxBaseIn)).toBeGreaterThan(0n);
    expect(r.body.liquidity.baseReserve).toBe('905000000');
    expect(r.body.liquidity.quoteReserve).toBe('1163535912');
    // seeded at 1.3 and traded down by the proof's own swap: the price is a little under
    expect(Number(r.body.price.quotePerBase)).toBeGreaterThan(1.28);
    expect(Number(r.body.price.quotePerBase)).toBeLessThan(1.3);
  });

  it('reads the pair the other way round when the base is the other token', async () => {
    const r = await h.get(`/v1/pools/${P.damm.pool}?base=${P.damm.b}`);
    expect(r.body.base.mint).toBe(P.damm.b);
    expect(r.body.baseIsA).toBe(false);
    expect(r.body.orientation).toMatch(/token B/);
    expect(Number(r.body.price.quotePerBase)).toBeGreaterThan(0.76);
    expect(Number(r.body.price.quotePerBase)).toBeLessThan(0.78);
    const forward = (await h.get(`/v1/pools/${P.damm.pool}`)).body;
    // a sell of the base in one orientation is a buy of the quote in the other
    expect(r.body.depth[3].sellBase.maxBaseIn).toBe(forward.depth[3].buyBase.maxQuoteIn);
  });

  it('prices the pool at the moment of the request: a pool that has not opened is reported closed with when it opens', async () => {
    const accounts = fixtureAccounts();
    const pair = accounts.get(P.one.pair)!;
    const patched = new Uint8Array(pair.data);
    new DataView(patched.buffer).setBigUint64(8 + 808, 9_999_999_999n, true); // activation point far ahead
    accounts.set(P.one.pair, { ...pair, data: patched });
    const closed = await harness({ accounts });
    const r = await closed.get(`/v1/pools/${P.one.pair}`);
    expect(r.status).toBe(200);
    expect(r.body.status).toMatchObject({ open: false, pointUnit: 'timestamp', opensAtPoint: '9999999999' });
    expect(r.body.swapTx.supported).toBe(false);
    await closed.app.close();
  });

  it('refuses what it cannot read, with a stable reason', async () => {
    expect((await h.get('/v1/pools/not-an-address')).status).toBe(400);
    const missing = await h.get(`/v1/pools/${key('nowhere')}`);
    expect(missing.status).toBe(404);
    expect(missing.body.reason).toBe('POOL_NOT_FOUND');
    const notAPool = await h.get(`/v1/pools/${P.one.x}`);
    expect(notAPool.status).toBe(422);
    expect(notAPool.body.reason).toBe('NOT_A_POOL');
    const badBase = await h.get(`/v1/pools/${P.damm.pool}?base=${key('other')}`);
    expect(badBase.status).toBe(400);
    expect(badBase.body.reason).toBe('BASE_NOT_IN_POOL');
    expect((await h.get(`/v1/pools/${P.damm.pool}?base=nope`)).status).toBe(400);
  });

  it('a corrupt pool account is a refusal, not a crash', async () => {
    const accounts = fixtureAccounts();
    const pair = accounts.get(P.one.pair)!;
    const broken = new Uint8Array(pair.data);
    broken[8 + 67] = 9; // an unknown pair type
    accounts.set(P.one.pair, { ...pair, data: broken });
    const x = await harness({ accounts });
    const r = await x.get(`/v1/pools/${P.one.pair}`);
    expect(r.status).toBe(422);
    expect(r.body.reason).toBe('NOT_A_POOL');
    await x.app.close();
  });

  it('applies a token-2022 transfer fee of a mint and says so', async () => {
    const accounts = fixtureAccounts();
    accounts.set(P.damm.b, mintBytes([{ __kind: 'TransferFeeConfig', transferFeeConfigAuthority: key('a'), withdrawWithheldAuthority: key('b'), withheldAmount: 0n, olderTransferFee: { epoch: 0n, maximumFee: 1_000_000_000n, transferFeeBasisPoints: 100 }, newerTransferFee: { epoch: 0n, maximumFee: 1_000_000_000n, transferFeeBasisPoints: 100 } }], 9, true));
    const x = await harness({ accounts });
    const withFee = (await x.get(`/v1/pools/${P.damm.pool}`)).body;
    const plain = (await h.get(`/v1/pools/${P.damm.pool}`)).body;
    expect(withFee.quote.transferFee).toEqual({ bps: 100, maxFee: '1000000000' });
    expect(withFee.caveats.join(' ')).toMatch(/transfer fee of 100 bps/);
    // selling the base into the pool returns the quote less 1%: the depth at the same limit is smaller
    expect(BigInt(withFee.depth[4].sellBase.maxBaseIn)).toBeLessThan(BigInt(plain.depth[4].sellBase.maxBaseIn));
    await x.app.close();
  });
});

describe('GET /v1/pools?base&quote: discovery', () => {
  it('finds the pools the adapters open at their canonical addresses, and names the ones that are not there', async () => {
    expect(dlmmCanonicalPair(P.one.x as Address, P.one.y as Address)).toBe(P.one.pair);
    expect(dammCanonicalPool(P.damm.a as Address, P.damm.b as Address)).toBe(P.damm.pool);
    expect(dammCanonicalPool(P.damm.b as Address, P.damm.a as Address)).toBe(P.damm.pool);
    const h = await harness();
    const dammPair = await h.get(`/v1/pools?base=${P.damm.a}&quote=${P.damm.b}`);
    expect(dammPair.status).toBe(200);
    expect(dammPair.body.pools.map((p: { pool: string; kind: string }) => [p.kind, p.pool])).toEqual([['damm-v2', P.damm.pool]]);
    expect(dammPair.body.absent.map((a: { kind: string }) => a.kind)).toEqual(['dlmm']);
    expect(dammPair.body.discovery).toMatch(/canonical|addresses the Opening Cross adapters/);
    const dlmmPair = await h.get(`/v1/pools?base=${P.one.x}&quote=${P.one.y}`);
    expect(dlmmPair.body.pools[0]).toMatchObject({ kind: 'dlmm', pool: P.one.pair, status: { open: true } });
    expect(dlmmPair.body.pools[0].depthAt100bps.sellBase.maxBaseIn).not.toBe('0');
    const none = await h.get(`/v1/pools?base=${key('x1')}&quote=${key('x2')}`);
    expect(none.body.pools).toEqual([]);
    expect(none.body.absent).toHaveLength(2);
    await h.app.close();
  });

  it('refuses a missing or equal pair', async () => {
    const h = await harness();
    expect((await h.get('/v1/pools')).status).toBe(400);
    expect((await h.get(`/v1/pools?base=${P.one.x}`)).status).toBe(400);
    expect((await h.get(`/v1/pools?base=${P.one.x}&quote=${P.one.x}`)).status).toBe(400);
    await h.app.close();
  });
});

describe('GET /v1/pools/route: pools in the ranking', () => {
  it('prices the pools and ranks them with the cross and the rest of the router’s answer', async () => {
    const h = await harness({ router: 'ranking' });
    const r = await h.get(`/v1/pools/route?base=${P.damm.a}&quote=${P.damm.b}&side=sell&amount=5000000`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.schema).toBe('opening-cross/router-quote/v1');
    expect(r.body.venues.map((v: { venue: string }) => v.venue).sort()).toEqual(['cross', 'meteora-damm-v2']);
    // 1.5 per base on the (stub) cross beats ~1.27 from the pool for a seller
    expect(r.body.venues[0].venue).toBe('cross');
    const pool = r.body.venues.find((v: { venue: string }) => v.venue === 'meteora-damm-v2');
    expect(pool).toMatchObject({ pool: P.damm.pool, fill: 'full', executableNow: true });
    expect(pool.route).toMatchObject({ aToB: true, amountIn: '5000000', inputMint: P.damm.a, outputMint: P.damm.b });
    expect(r.body.excluded.some((e: { venue: string }) => e.venue === 'meteora')).toBe(false);
    expect(r.body.excluded).toContainEqual({ venue: 'jupiter', reason: 'Jupiter routes mainnet liquidity only' });
    expect(r.body.intent).toEqual({ base: P.damm.a, quote: P.damm.b, side: 'sell', amount: '5000000' });
    expect(r.body.pools.read).toEqual([{ pool: P.damm.pool, kind: 'damm-v2', sources: [P.damm.pool] }]);
    expect(r.body.chain.source).toBe('the Clock sysvar');
    await h.app.close();
  });

  it('a buyer’s price from the pool is minimal and round trips through the pool’s own quote', async () => {
    const h = await harness({ router: 'ranking' });
    const r = await h.get(`/v1/pools/route?base=${P.damm.a}&quote=${P.damm.b}&side=buy&amount=10000000`);
    const pool = r.body.venues.find((v: { venue: string }) => v.venue === 'meteora-damm-v2');
    // the stub cross asks 1.5; the pool sells for about 1.27, so it wins for a buyer
    expect(r.body.best).toMatchObject({ venue: 'meteora-damm-v2' });
    expect(pool.route).toMatchObject({ aToB: false, inputMint: P.damm.b });
    expect(BigInt(pool.route.expectedOut)).toBeGreaterThanOrEqual(10_000_000n);
    await h.app.close();
  });

  it('names a pool elsewhere with pool=, and says it does not trade the pair when it does not', async () => {
    const h = await harness({ router: 'ranking' });
    const r = await h.get(`/v1/pools/route?base=${P.damm.a}&quote=${P.damm.b}&side=sell&amount=5000000&pool=${P.ladder.pair}`);
    expect(r.status).toBe(200);
    expect(r.body.excluded).toContainEqual({ venue: 'meteora-dlmm', pool: P.ladder.pair, reason: 'the pool does not trade this pair' });
    expect(r.body.venues.some((v: { pool?: string }) => v.pool === P.damm.pool)).toBe(true);
    await h.app.close();
  });

  it('works when the router route is not mounted: only the pools are priced, and the gap is stated', async () => {
    const h = await harness({ router: 'absent' });
    const r = await h.get(`/v1/pools/route?base=${P.damm.a}&quote=${P.damm.b}&side=sell&amount=5000000`);
    expect(r.status).toBe(200);
    expect(r.body.venues.map((v: { venue: string }) => v.venue)).toEqual(['meteora-damm-v2']);
    expect(r.body.excluded[0].reason).toMatch(/not enabled on this deployment/);
    await h.app.close();
  });

  it('passes the router’s own refusal through instead of pricing a pair it cannot read', async () => {
    const h = await harness({ router: 'missing-mint' });
    const r = await h.get(`/v1/pools/route?base=${P.damm.a}&quote=${P.damm.b}&side=sell&amount=5000000`);
    expect(r.status).toBe(404);
    expect(r.body.reason).toBe('MINT_NOT_FOUND');
    await h.app.close();
  });

  it('validates its query like the router route does', async () => {
    const h = await harness({ router: 'ranking' });
    const base = `base=${P.damm.a}&quote=${P.damm.b}`;
    expect((await h.get(`/v1/pools/route?${base}&side=hold&amount=1`)).status).toBe(400);
    expect((await h.get(`/v1/pools/route?${base}&side=buy&amount=0`)).status).toBe(400);
    expect((await h.get(`/v1/pools/route?${base}&side=buy&amount=-5`)).status).toBe(400);
    expect((await h.get(`/v1/pools/route?${base}&side=buy`)).status).toBe(400);
    expect((await h.get(`/v1/pools/route?base=${P.damm.a}&quote=${P.damm.a}&side=buy&amount=1`)).status).toBe(400);
    expect((await h.get(`/v1/pools/route?${base}&side=buy&amount=1&pool=bad`)).status).toBe(400);
    await h.app.close();
  });

  it('an amount the pool cannot supply is a partial fill and ranks below a full one', async () => {
    const h = await harness({ router: 'ranking' });
    const r = await h.get(`/v1/pools/route?base=${P.damm.a}&quote=${P.damm.b}&side=buy&amount=900000000000`);
    expect(r.status).toBe(200);
    const pool = r.body.venues.find((v: { venue: string }) => v.venue === 'meteora-damm-v2');
    expect(pool.fill).toBe('partial');
    expect(r.body.venues.at(-1).venue).toBe('meteora-damm-v2');
    await h.app.close();
  });
});

describe('GET /v1/pools/by-cross/:address: the issuer’s view', () => {
  it('shows each pool of a cleared cross, how far it has moved from the clearing price and what the ask ladder still offers', async () => {
    const accounts = fixtureAccounts();
    accounts.set(CROSS, { data: crossBytes({ state: CrossState.Finalized, clearing: clearing(1_300_000n), baseMint: P.ladder.x, quoteMint: P.ladder.y }), owner: CROSS_CORE_PROGRAM_ADDRESS });
    const h = await harness({ accounts });
    const r = await h.get(`/v1/pools/by-cross/${CROSS}`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.schema).toBe('opening-cross/issuer-liquidity/v1');
    expect(r.body.cross).toMatchObject({ state: 'Finalized', clearingPrice: '1300000', baseMint: P.ladder.x });
    expect(r.body.pools).toHaveLength(1);
    const p = r.body.pools[0];
    expect(p).toMatchObject({ kind: 'dlmm', pool: P.ladder.pair });
    // the ladder pair sold 20 bins' worth upward from 1.3 and now sits at bin 269 (1.3 x 1.001^7): about 70 bps above the clearing price
    expect(Number(p.movedFromClearingBps)).toBeGreaterThan(60);
    expect(Number(p.movedFromClearingBps)).toBeLessThan(90);
    expect(p.askLadder.bins).toBeGreaterThan(5);
    expect(BigInt(p.askLadder.baseOffered)).toBe(440291063n);
    await h.app.close();
  });

  it('says so when the cross has no market yet, or no base mint, or is not a cross', async () => {
    const accounts = fixtureAccounts();
    accounts.set(CROSS, { data: crossBytes({ state: CrossState.Finalized, clearing: clearing(1_300_000n), baseMint: key('no pool for this') }), owner: CROSS_CORE_PROGRAM_ADDRESS });
    const unbound = key('unbound');
    accounts.set(unbound, { data: crossBytes({ baseBound: false, baseMint: '11111111111111111111111111111111' }), owner: CROSS_CORE_PROGRAM_ADDRESS });
    const h = await harness({ accounts });
    const none = await h.get(`/v1/pools/by-cross/${CROSS}`);
    expect(none.body.pools).toEqual([]);
    expect(none.body.note).toMatch(/No pool was found/);
    expect((await h.get(`/v1/pools/by-cross/${unbound}`)).body.note).toMatch(/no base mint/);
    expect((await h.get(`/v1/pools/by-cross/${key('absent')}`)).status).toBe(404);
    expect((await h.get(`/v1/pools/by-cross/${P.damm.pool}`)).body.reason).toBe('NOT_A_CROSS');
    await h.app.close();
  });
});

describe('GET /v1/depth/cross/:address: a cross’s depth beside its pools', () => {
  async function withBook(buy: Record<number, bigint>, sell: Record<number, bigint>, over: Record<string, unknown> = {}) {
    const accounts = fixtureAccounts();
    accounts.set(CROSS, { data: crossBytes(over), owner: CROSS_CORE_PROGRAM_ADDRESS });
    accounts.set(await bookAddressOf(CROSS), { data: levelsBytes(buy, sell), owner: CROSS_CORE_PROGRAM_ADDRESS });
    return harness({ accounts });
  }
  const BUY = { 6: 1_000_000_000n, 4: 500_000_000n };
  const SELL = { 2: 800_000_000n, 5: 900_000_000n };

  it('returns the book’s depth, the price impact of each size on each side and the pool’s slippage for the same sizes', async () => {
    const h = await withBook(BUY, SELL);
    const r = await h.get(`/v1/depth/cross/${CROSS}?sizes=10000000,100000000`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ schema: 'opening-cross/cross-depth/v1', bookVisible: true, state: 'Live', disclosure: 'open' });
    expect(r.body.levels).toHaveLength(4);
    expect(r.body.market).toEqual({ baseMint: P.one.x, quoteMint: P.one.y, baseDecimals: 6, quoteDecimals: 6 });
    expect(r.body.baseline).toMatchObject({ prints: true, matched: '1000000000' });
    expect(r.body.impact.map((x: { side: string; size: string }) => `${x.side}:${x.size}`)).toEqual(['buy:10000000', 'sell:10000000', 'buy:100000000', 'sell:100000000']);
    expect(r.body.pools).toHaveLength(1);
    expect(r.body.pools[0]).toMatchObject({ kind: 'dlmm', pool: P.one.pair });
    expect(r.body.pools[0].rows).toHaveLength(4);
    const sell = r.body.pools[0].rows.find((x: { side: string; size: string }) => x.side === 'sell' && x.size === '100000000');
    expect(BigInt(sell.slippageBps)).toBeGreaterThan(0n);
    expect(r.body.notes.join(' ')).toMatch(/different quantities/);
    await h.app.close();
  });

  it('a sealed cross shows no book and no price impact, and still lists its pools', async () => {
    const h = await withBook({}, {}, { disclosure: Disclosure.Sealed });
    const r = await h.get(`/v1/depth/cross/${CROSS}`);
    expect(r.body).toMatchObject({ bookVisible: false, levels: null, impact: [] });
    expect(r.body.hiddenBecause).toMatch(/sealed/);
    expect(r.body.pools).toHaveLength(1);
    await h.app.close();
  });

  it('refuses sizes it cannot use, and a cross that is not there', async () => {
    const h = await withBook(BUY, SELL);
    expect((await h.get(`/v1/depth/cross/${CROSS}?sizes=0`)).status).toBe(400);
    expect((await h.get(`/v1/depth/cross/${CROSS}?sizes=1,x`)).status).toBe(400);
    expect((await h.get(`/v1/depth/cross/${CROSS}?sizes=${Array(13).fill(1).join(',')}`)).status).toBe(400);
    expect((await h.get(`/v1/depth/cross/${key('absent')}`)).status).toBe(404);
    await h.app.close();
  });
});

describe('GET /v1/pools/summary: the dashboard’s liquidity section', () => {
  it('lists the pools of the latest cleared crosses, once per pair, from the cross index', async () => {
    const db = await holderDb();
    const insert = (address: string, base: string, quote: string, state: string, close: number) =>
      db.query(
        `INSERT INTO crosses (address, creator, kind, supply_mode, disclosure, base_mint, quote_mint, open_ts, close_ts, reveal_end_ts, protocol_fee_bps, integrator_fee_bps, state, clearing_price, matched, created_slot, updated_slot)
         VALUES ($1, 'c', 0, 0, 0, $2, $3, 1, $4, $4, 30, 0, $5, 1300000, 1000, 1, 1)`,
        [address, base, quote, close, state],
      );
    await insert(key('c1'), P.one.x, P.one.y, 'Finalized', 300);
    await insert(key('c2'), P.one.x, P.one.y, 'Finalized', 200); // the same pair again: one row only
    await insert(key('c3'), P.damm.a, P.damm.b, 'Cleared', 100);
    await insert(key('c4'), key('unlisted base'), key('unlisted quote'), 'Finalized', 50); // no pool for it
    await insert(key('c5'), P.ladder.x, P.ladder.y, 'Live', 400); // not cleared: skipped
    const h = await harness({ db });
    const r = await h.get('/v1/pools/summary');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.schema).toBe('opening-cross/pools-summary/v1');
    expect(r.body.pairsScanned).toBe(3);
    expect(r.body.pools.map((p: { pool: string }) => p.pool).sort()).toEqual([P.one.pair, P.damm.pool].sort());
    expect(r.body.pools.find((p: { pool: string }) => p.pool === P.one.pair)).toMatchObject({ cross: key('c1'), kind: 'dlmm' });
    await h.app.close();
  });

  it('is not served by a deployment without the cross index', async () => {
    const h = await harness();
    const r = await h.get('/v1/pools/summary');
    expect(r.status).toBe(404);
    await h.app.close();
  });
});

describe('POST /v1/pools/swap-tx', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await harness();
    await give(h.accounts, TRADER, P.damm.a, 1_000_000_000n);
    await give(h.accounts, TRADER, P.damm.b, 1_000_000_000n);
    await give(h.accounts, TRADER, P.one.x, 1_000_000_000n);
    await give(h.accounts, TRADER, P.one.y, 1_000_000_000n);
  });
  afterAll(() => h.app.close());

  const swapOf = (ixs: Instruction[]) => ixs.find((i) => i.programAddress === 'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG' || i.programAddress === 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo')!;

  it('builds an unsigned DAMM v2 swap: a compute limit, the output account, the swap; the trader pays and signs', async () => {
    const r = await h.post('/v1/pools/swap-tx', { pool: P.damm.pool, owner: TRADER, inputMint: P.damm.a, amountIn: '5000000' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.signers).toEqual([TRADER]);
    expect(r.body.kind).toBe('damm-v2');
    expect(r.body.swap).toMatchObject({ inputMint: P.damm.a, outputMint: P.damm.b, amountIn: '5000000', toleranceBps: 50 });
    const expected = BigInt(r.body.swap.expectedOut);
    expect(expected).toBeGreaterThan(6_000_000n);
    // the minimum is the expected output less 0.5%, rounded up
    expect(BigInt(r.body.swap.minimumAmountOut)).toBe((expected * 9_950n + 9_999n) / 10_000n);
    const ixs = decode(r.body.transaction);
    expect(ixs).toHaveLength(3);
    expect(ixs[0]!.programAddress).toBe('ComputeBudget111111111111111111111111111111');
    expect(ixs[1]!.programAddress).toBe('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
    const swap = swapOf(ixs);
    expect(Buffer.from(swap.data!).readBigUInt64LE(8)).toBe(5_000_000n);
    expect(Buffer.from(swap.data!).readBigUInt64LE(16)).toBe(BigInt(r.body.swap.minimumAmountOut));
    expect(swap.accounts!.map((a) => a.address)).toContain(await ata(TRADER, P.damm.a as Address, T22));
    expect(Buffer.from(r.body.transaction, 'base64').length).toBeLessThanOrEqual(1232);
    expect(r.body.lastValidBlockHeight).toBe('123');
  });

  it('builds an unsigned DLMM swap that names the bin arrays the trade walks, plus the next one in its direction', async () => {
    const r = await h.post('/v1/pools/swap-tx', { pool: P.one.pair, owner: TRADER, inputMint: P.one.x, amountIn: '5000000', maxSlippageBps: 100 });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    // the same swap as the A3 proof's real one: 5,000,000 base in gives 6,490,285 quote out
    expect(r.body.swap.expectedOut).toBe('6490285');
    expect(r.body.swap.toleranceBps).toBe(100);
    const swap = swapOf(decode(r.body.transaction));
    expect(swap.programAddress).toBe('LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo');
    expect(swap.accounts!.at(-1)!.address).toBe(fx.pools['dlmm-proof'].binArrays[0]!.address);
    expect(Buffer.from(swap.data!).readBigUInt64LE(8)).toBe(5_000_000n);
  });

  it('a buy sells the quote token: the input account is the quote’s', async () => {
    const r = await h.post('/v1/pools/swap-tx', { pool: P.damm.pool, owner: TRADER, inputMint: P.damm.b, amountIn: '5000000' });
    expect(r.status).toBe(200);
    expect(r.body.swap).toMatchObject({ inputMint: P.damm.b, outputMint: P.damm.a });
    expect(BigInt(r.body.swap.expectedOut)).toBeLessThan(5_000_000n); // 5,000,000 quote buys about 3.86 million base at ~1.29
  });

  it('an explicit minimum replaces the tolerance, and one above the quote is refused', async () => {
    const quote = await h.post('/v1/pools/swap-tx', { pool: P.damm.pool, owner: TRADER, inputMint: P.damm.a, amountIn: '5000000' });
    const expected = BigInt(quote.body.swap.expectedOut);
    const exact = await h.post('/v1/pools/swap-tx', { pool: P.damm.pool, owner: TRADER, inputMint: P.damm.a, amountIn: '5000000', minimumAmountOut: (expected - 100n).toString() });
    expect(exact.status).toBe(200);
    expect(exact.body.swap).toMatchObject({ minimumAmountOut: (expected - 100n).toString(), toleranceBps: null });
    const tooHigh = await h.post('/v1/pools/swap-tx', { pool: P.damm.pool, owner: TRADER, inputMint: P.damm.a, amountIn: '5000000', minimumAmountOut: (expected + 1n).toString() });
    expect(tooHigh.status).toBe(409);
    expect(tooHigh.body).toMatchObject({ reason: 'MINIMUM_ABOVE_QUOTE', expectedOut: expected.toString() });
  });

  it('refuses before building anything: a trader without the token, without enough of it, a pool too small, an amount too small', async () => {
    const stranger = key('stranger');
    const noAccount = await h.post('/v1/pools/swap-tx', { pool: P.damm.pool, owner: stranger, inputMint: P.damm.a, amountIn: '5000000' });
    expect(noAccount.status).toBe(409);
    expect(noAccount.body.reason).toBe('NO_INPUT_ACCOUNT');
    const poor = key('poor');
    await give(h.accounts, poor, P.damm.a, 4_999_999n);
    const short = await h.post('/v1/pools/swap-tx', { pool: P.damm.pool, owner: poor, inputMint: P.damm.a, amountIn: '5000000' });
    expect(short.status).toBe(422);
    expect(short.body).toMatchObject({ reason: 'INSUFFICIENT_INPUT', have: '4999999', need: '5000000' });
    const huge = await h.post('/v1/pools/swap-tx', { pool: P.one.pair, owner: TRADER, inputMint: P.one.x, amountIn: '900000000000' });
    expect(huge.status).toBe(409);
    expect(huge.body.reason).toBe('POOL_CANNOT_ABSORB');
    const tiny = await h.post('/v1/pools/swap-tx', { pool: P.one.pair, owner: TRADER, inputMint: P.one.x, amountIn: '1' });
    expect(tiny.status).toBe(409);
    expect(tiny.body.reason).toBe('AMOUNT_TOO_SMALL');
  });

  it('refuses a malformed request, field by field', async () => {
    const ok = { pool: P.damm.pool, owner: TRADER, inputMint: P.damm.a, amountIn: '5000000' };
    const bad = async (patch: Record<string, unknown>) => (await h.post('/v1/pools/swap-tx', { ...ok, ...patch })).status;
    expect(await bad({ pool: 'x' })).toBe(400);
    expect(await bad({ owner: 'x' })).toBe(400);
    expect(await bad({ inputMint: key('other') })).toBe(400);
    expect(await bad({ amountIn: '0' })).toBe(400);
    expect(await bad({ amountIn: '-1' })).toBe(400);
    expect(await bad({ amountIn: 'abc' })).toBe(400);
    expect(await bad({ maxSlippageBps: 5001 })).toBe(400);
    expect(await bad({ maxSlippageBps: -1 })).toBe(400);
    expect(await bad({ maxSlippageBps: 1.5 })).toBe(400);
    expect(await bad({ minimumAmountOut: 'x' })).toBe(400);
    expect(await bad({ surprise: true })).toBe(400);
    expect((await h.post('/v1/pools/swap-tx', [])).status).toBe(400);
    expect((await h.post('/v1/pools/swap-tx', { ...ok, pool: key('nowhere') })).status).toBe(404);
    expect((await h.post('/v1/pools/swap-tx', { ...ok, pool: P.damm.a })).status).toBe(422);
  });

  it('will not build a swap into a pool that has not opened, a paused mint, a native-SOL pool or a DLMM pair whose mint has a transfer hook', async () => {
    const accounts = fixtureAccounts();
    const pair = accounts.get(P.one.pair)!;
    const patched = new Uint8Array(pair.data);
    new DataView(patched.buffer).setBigUint64(8 + 808, 9_999_999_999n, true);
    accounts.set(P.one.pair, { ...pair, data: patched });
    accounts.set(P.damm.b, mintBytes([{ __kind: 'PausableConfig', authority: key('pauser'), paused: true }], 9, true));
    accounts.set(P.ladder.y, mintBytes([{ __kind: 'TransferHook', authority: key('hook auth'), programId: key('hook program') }], 9, true));
    const x = await harness({ accounts });
    await give(x.accounts, TRADER, P.one.x, 1_000_000_000n);
    await give(x.accounts, TRADER, P.damm.a, 1_000_000_000n);
    await give(x.accounts, TRADER, P.ladder.x, 1_000_000_000n);
    const closed = await x.post('/v1/pools/swap-tx', { pool: P.one.pair, owner: TRADER, inputMint: P.one.x, amountIn: '5000000' });
    expect(closed.status).toBe(409);
    expect(closed.body).toMatchObject({ reason: 'POOL_CLOSED', opensAtPoint: '9999999999' });
    const paused = await x.post('/v1/pools/swap-tx', { pool: P.damm.pool, owner: TRADER, inputMint: P.damm.a, amountIn: '5000000' });
    expect(paused.status).toBe(409);
    expect(paused.body.error).toMatch(/paused transfers/);
    const hook = await x.post('/v1/pools/swap-tx', { pool: P.ladder.pair, owner: TRADER, inputMint: P.ladder.x, amountIn: '5000000' });
    expect(hook.status).toBe(422);
    expect(hook.body.reason).toBe('TRANSFER_HOOK');
    await x.app.close();
  });
});

describe('the dashboard’s liquidity section', () => {
  const SKIP = ['programs', 'execution', 'fairness', 'externalFlow', 'accuracy', 'fees', 'protocol', 'ratings', 'health', 'totals'];
  it('appears when the pool routes are mounted, carries the summary without its prose, and names the route it came from', async () => {
    const app = Fastify();
    app.setErrorHandler((err, _req, reply) => reply.code(500).send({ error: String(err) }));
    registerDashboard(app, { account: async () => null }, { skip: SKIP, ttlMs: 0 });
    app.get('/v1/pools/summary', async () => ({ schema: 'opening-cross/pools-summary/v1', pairsScanned: 1, pools: [{ pool: P.damm.pool }], discovery: 'long prose' }));
    await app.ready();
    const body = (await app.inject({ method: 'GET', url: '/v1/dashboard' })).json();
    expect(Object.keys(body.sections)).toEqual(['liquidity']);
    expect(body.sections.liquidity).toEqual({ ok: true, source: '/v1/pools/summary', data: { schema: 'opening-cross/pools-summary/v1', pairsScanned: 1, pools: [{ pool: P.damm.pool }] } });
    await app.close();
  });

  it('is left out, not reported as missing, on a deployment that does not mount the pool routes', async () => {
    const app = Fastify();
    registerDashboard(app, { account: async () => null }, { skip: SKIP, ttlMs: 0 });
    await app.ready();
    const body = (await app.inject({ method: 'GET', url: '/v1/dashboard' })).json();
    expect(body.sections).toEqual({});
    await app.close();
  });

  it('reports a failing summary as unavailable with the reason, and does not hide the other sections', async () => {
    const app = Fastify();
    registerDashboard(app, { account: async () => null }, { skip: [...SKIP.filter((x) => x !== 'totals')], ttlMs: 0 });
    app.get('/v1/stats', async () => ({ crosses_total: 1 }));
    app.get('/v1/pools/summary', async (_req, reply) => reply.code(503).send({ error: 'rpc busy' }));
    await app.ready();
    const body = (await app.inject({ method: 'GET', url: '/v1/dashboard' })).json();
    expect(body.sections.totals.ok).toBe(true);
    expect(body.sections.liquidity).toEqual({ ok: false, source: '/v1/pools/summary', error: 'answered HTTP 503: rpc busy' });
    await app.close();
  });
});
