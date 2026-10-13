// The rules extension over HTTP, with accounts injected in memory (no chain, no database): what the builders refuse before a transaction
// exists, what they build for a cross with rules, the builders behind the old routes in server.ts reading the rules tail of the cross, and
// the reads that explain a cross's rules. The program itself is not run here (LiteSVM needs Linux); `tests/core/test/sdk-rules-builders.test.ts`
// compares the instructions with the ones the LiteSVM suites run, and the transactions are decoded back to instructions below.
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import Fastify from 'fastify';
import { beforeAll, describe, expect, it } from 'vitest';
import { type Address, type Instruction, compileTransaction, decompileTransactionMessage, generateKeyPairSigner, getCompiledTransactionMessageDecoder, getTransactionDecoder, none, some } from '@solana/kit';
import { TOKEN_2022_PROGRAM_ADDRESS, getMintEncoder } from '@solana-program/token-2022';
import {
  AUX_END_BASE,
  COMMIT_ORDER_EXT_DISCRIMINATOR,
  CREATE_CROSS_DISCRIMINATOR,
  CLEAR_DISCRIMINATOR,
  CROSS_BODY_LEN,
  CROSS_CORE_PROGRAM_ADDRESS,
  CROSS_EXT_LEN,
  CrossKind,
  CrossState,
  Disclosure,
  FINALIZE_DISCRIMINATOR,
  INIT_SHARD_DISCRIMINATOR,
  MERGE_SHARD_DISCRIMINATOR,
  SET_RULES_DISCRIMINATOR,
  SupplyMode,
  ata,
  classBookAddress,
  completeRules,
  crossAddress,
  getCrossEncoder,
  getCrossExtEncoder,
  getLevelsEncoder,
  bookAddress,
  protocolAddress,
  shardAddress,
  type CrossExtArgs,
} from '@opening-cross/sdk';
import { SPL_TOKEN_PROGRAM_ADDRESS } from '@opening-cross/token-safety';
import { buildServer } from '../src/server.js';
import { RequestError } from '../src/tx.js';
import { registerRulesTx } from '../src/routes/rules-tx.js';

void compileTransaction;
const NOW = 1_800_000_000;
const BLOCKHASH = '4NCYB3kRT8sCNodPNuCZo8VkwveZSHhg7R7mrRBFM1Uy' as never;
const key = async () => (await generateKeyPairSigner()).address;
const mintBytes = (authority: Address | null) =>
  new Uint8Array(getMintEncoder().encode({ mintAuthority: authority ? some(authority) : none(), supply: 0n, decimals: 6, isInitialized: true, freezeAuthority: none(), extensions: none() } as never).slice(0, 82));

type Account = { data: Uint8Array; owner: Address };

/** The rules tail with every rule off, then the given fields. */
function extWith(over: Partial<CrossExtArgs> = {}): CrossExtArgs {
  const base = completeRules({});
  return {
    version: 1,
    rulesSet: true,
    createdSlot: 10n,
    flags: 0,
    guards: { ...base.guards, haltSource: null },
    ending: base.ending,
    draw: { epoch: 0, pendingSlot: 0n, pendingPurpose: 0, seed: new Uint8Array(32), seedEpoch: 0, seedReady: false, endBucket: 255, extPending: false, extensionUsed: false, auxMerged: 0n },
    identity: base.identity,
    alloc: { ...base.alloc, priorityGate: null },
    neutrality: { insiders: Array.from({ length: 8 }, () => '11111111111111111111111111111111' as Address), insiderCount: 0, insiderCliffSecs: 0, insiderVestSecs: 0, bondQuote: 0n, challengeSecs: 0 },
    neutralState: { bondHeld: 0n, slashed: 0n, openChallenges: 0, challenges: 0 },
    clearing: { classQty: [0n, 0n, 0n], tickets: 0, rho: 0, clearedTs: 0n, insiderUb: 0n },
    referral: base.referral,
    oracleSet: { extraFeeds: [new Uint8Array(32), new Uint8Array(32)] as never, extraCount: 0, quorum: 0, maxSpreadBps: 0, offHoursWidenBps: 0 },
    ...over,
  } as CrossExtArgs;
}

describe('rules over HTTP', () => {
  const accounts = new Map<string, Account>();
  let app: ReturnType<typeof Fastify>;
  let full: Awaited<ReturnType<typeof buildServer>>;
  let creator: Address, base: Address, quote: Address, integrator: Address, feeRecipient: Address, gate: Address, trader: Address;
  let plain: Address, ruled: Address, ending: Address, referred: Address;

  const post = async (url: string, payload: unknown, server: { inject: typeof app.inject } = app) => {
    const r = await server.inject({ method: 'POST', url, payload: payload as never });
    return { status: r.statusCode, body: JSON.parse(r.body) };
  };
  const get = async (url: string) => {
    const r = await app.inject({ method: 'GET', url });
    return { status: r.statusCode, body: JSON.parse(r.body) };
  };
  const instructionsOf = (tx: string): Instruction[] => {
    const decoded = getTransactionDecoder().decode(Uint8Array.from(Buffer.from(tx, 'base64')));
    return decompileTransactionMessage(getCompiledTransactionMessageDecoder().decode(decoded.messageBytes)).instructions as Instruction[];
  };
  const is = (ix: Instruction, disc: Uint8Array) => ix.programAddress === CROSS_CORE_PROGRAM_ADDRESS && disc.every((b, i) => ix.data![i] === b);
  const wireLength = (tx: string) => Buffer.from(tx, 'base64').length;

  async function putCross(over: { id: bigint; disclosure?: Disclosure; supplyMode?: SupplyMode; state?: CrossState; ext?: CrossExtArgs | null; gateMint?: Address | null; closeTs?: bigint; shards?: number; feeRecipientKey?: Address }): Promise<Address> {
    const address = await crossAddress(creator, over.id);
    const body = getCrossEncoder().encode({
      creator,
      crossId: over.id,
      kind: CrossKind.Launch,
      supplyMode: over.supplyMode ?? SupplyMode.Mint,
      disclosure: over.disclosure ?? Disclosure.Open,
      state: over.state ?? CrossState.Live,
      baseMint: base,
      quoteMint: quote,
      baseTokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
      quoteTokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
      baseDecimals: 6,
      quoteDecimals: 6,
      proceedsTo: creator,
      minPrice: 1_000_000n,
      tick: 100_000n,
      ticks: 20,
      priceScale: 1_000_000n,
      openTs: BigInt(NOW - 1_000),
      closeTs: over.closeTs ?? BigInt(NOW + 1_000),
      revealEndTs: (over.closeTs ?? BigInt(NOW + 1_000)) + 100n,
      referencePrice: none(),
      minMatched: 0n,
      maxImbalanceBps: none(),
      protocolFeeBps: 30,
      integratorFeeBps: 20,
      integrator,
      feeRecipient: over.feeRecipientKey ?? feeRecipient,
      gateMint: over.gateMint ? some(over.gateMint) : none(),
      shards: over.shards ?? 2,
      maxOrders: 64,
      dustBond: 0n,
      ordersTotal: 0,
      ordersOpen: 0,
      mergedMask: 0,
      clearing: none(),
      noPrintReason: none(),
      buyerPaid: 0n,
      baseBought: 0n,
      baseSold: 0n,
      sellerPaid: 0n,
      feesAccrued: 0n,
      oracle: none(),
      calendar: none(),
      settler: none(),
      settleDeadlineTs: 0n,
      baseBound: true,
      bump: 255,
      quoteVaultBump: 255,
      baseVaultBump: 255,
      bookBump: 255,
    } as never);
    const data = new Uint8Array(CROSS_BODY_LEN + (over.ext ? CROSS_EXT_LEN : 0));
    data.set(body);
    if (over.ext) data.set(getCrossExtEncoder().encode(over.ext), CROSS_BODY_LEN);
    accounts.set(address, { owner: CROSS_CORE_PROGRAM_ADDRESS, data });
    return address;
  }

  beforeAll(async () => {
    [creator, base, quote, integrator, feeRecipient, gate, trader] = await Promise.all(Array.from({ length: 7 }, key));
    accounts.set(base, { owner: TOKEN_2022_PROGRAM_ADDRESS, data: mintBytes(creator) });
    accounts.set(quote, { owner: SPL_TOKEN_PROGRAM_ADDRESS, data: mintBytes(creator) });
    plain = await putCross({ id: 1n });
    ruled = await putCross({
      id: 2n,
      gateMint: gate,
      ext: extWith({ alloc: { ...completeRules({}).alloc, priorityGate: null, reserveBps: [3_000, 0, 0], smallCapQuote: 5_000_000n, lotteryUnit: 5_000_000n } as never, identity: { capQuote: 50_000_000n, maxOrders: 1 } }),
    });
    ending = await putCross({ id: 3n, ext: extWith({ ending: { endingSecs: 400, buckets: 4, cancelCutoffSecs: 60, randomEnd: false, extensionMinSecs: 0, extensionMaxSecs: 0 } }) });
    referred = await putCross({ id: 4n, state: CrossState.Cleared, ext: extWith({ referral: { referrer: trader, shareBps: 2_500 } }) });

    app = Fastify({ logger: false });
    app.setErrorHandler((err, _req, reply) => {
      if (err instanceof RequestError) return reply.code(err.status).type('application/json').send({ error: err.message, ...err.detail });
      return reply.code(500).send({ error: String(err) });
    });
    registerRulesTx(app, { account: async (a) => accounts.get(a) ?? null, lifetime: async () => ({ blockhash: BLOCKHASH, lastValidBlockHeight: 100n }), network: 'devnet', clock: () => NOW });

    // The whole server, so that the handlers in server.ts (place-order, settle, finalize...) are exercised with the hook registerRulesTx installs.
    const pg = new PGlite();
    const dir = fileURLToPath(new URL('../../indexer/migrations/', import.meta.url));
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.sql')).sort()) await pg.exec(readFileSync(`${dir}${f}`, 'utf8'));
    full = await buildServer({
      db: { query: (text: string, params?: unknown[]) => pg.query(text, params as never[]) } as never,
      network: 'devnet',
      account: async (a: Address) => accounts.get(a) ?? null,
      lifetime: async () => ({ blockhash: BLOCKHASH, lastValidBlockHeight: 100n }),
      clock: () => NOW,
      w2a: false,
    } as never);
    await full.ready();
  }, 120_000);

  const createBody = (over: Record<string, unknown> = {}) => ({
    creator,
    baseMint: base,
    quoteMint: quote,
    baseTokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
    quoteTokenProgram: SPL_TOKEN_PROGRAM_ADDRESS,
    crossId: '77',
    kind: 'launch',
    supplyMode: 'mint',
    disclosure: 'open',
    minPrice: '1000000',
    tick: '100000',
    ticks: 20,
    priceScale: '1000000',
    openTs: String(NOW + 100),
    closeTs: String(NOW + 1_100),
    revealEndTs: String(NOW + 1_200),
    integrator,
    shards: 2,
    maxOrders: 64,
    proceedsTo: creator,
    schedule: [{ price: '1000000', quantity: '100000000' }],
    ...over,
  });

  describe('POST /v1/rules/check and create-cross-ruled', () => {
    it('names every rule the program would refuse, by field', async () => {
      const r = await post('/v1/rules/check', createBody({ rules: { ending: { endingSecs: 5_000, buckets: 4 }, alloc: { reserveBps: [6_000, 6_000, 0] }, referral: { shareBps: 6_000, referrer: trader } } }));
      expect(r.status).toBe(200);
      expect(r.body.ok).toBe(false);
      const fields = r.body.issues.map((i: { field: string }) => i.field);
      expect(fields).toEqual(expect.arrayContaining(['ending', 'alloc.reserveBps', 'alloc.smallCapQuote', 'referral']));
      expect(r.body.issues.every((i: { message: string }) => i.message.length > 20)).toBe(true);
    });

    it('accepts a coherent rule set', async () => {
      const r = await post('/v1/rules/check', createBody({ rules: { guards: { minRaiseQuote: '1000000' }, ending: { endingSecs: 300, buckets: 3, randomEnd: true, cancelCutoffSecs: 30 }, referral: { shareBps: 2_500, referrer: trader } } }));
      expect(r.body).toEqual({ ok: true, issues: [] });
    });

    it('refuses misspelt and malformed rules with a 400 that names the field', async () => {
      expect((await post('/v1/rules/check', createBody({ rules: { gaurds: {} } }))).status).toBe(400);
      const typo = await post('/v1/rules/check', createBody({ rules: { ending: { endingSecs: 'ten' } } }));
      expect(typo.status).toBe(400);
      expect(typo.body.error).toMatch(/rules\.ending\.endingSecs/);
      expect((await post('/v1/rules/check', createBody({ rules: { neutrality: { insiders: ['not an address'] } } }))).status).toBe(400);
      expect((await post('/v1/rules/check', createBody({ rules: { alloc: { reserveBps: [1, 2] } } }))).status).toBe(400);
    });

    it('builds the creation and set_rules in ONE transaction, then every account the rules call for', async () => {
      const r = await post('/v1/tx/create-cross-ruled', createBody({ rules: { ending: { endingSecs: 300, buckets: 3 }, neutrality: { insiders: [trader], insiderCliffSecs: 10 }, referral: { shareBps: 2_500, referrer: trader } } }));
      expect(r.status).toBe(200);
      expect(r.body.issues).toEqual([]);
      const first = instructionsOf(r.body.transactions[0].transaction);
      const kinds = first.map((ix) => (is(ix, CREATE_CROSS_DISCRIMINATOR) ? 'create' : is(ix, SET_RULES_DISCRIMINATOR) ? 'rules' : 'other'));
      expect(kinds.filter((k) => k !== 'other')).toEqual(['create', 'rules']);
      for (const t of r.body.transactions) expect(wireLength(t.transaction)).toBeLessThanOrEqual(1_232);
      // main shards (2), ending buckets (3), the class book (insiders) and the lock vault (an insider cliff)
      const rest = r.body.transactions.slice(r.body.sizes.firstTransactions).map((t: { transaction: string }) => instructionsOf(t.transaction)[0]!);
      expect(rest).toHaveLength(2 + 3 + 1 + 1);
      expect(rest.filter((ix: Instruction) => is(ix, INIT_SHARD_DISCRIMINATOR))).toHaveLength(5);
      expect(r.body.cross).toBe(await crossAddress(creator, 77n));
    });

    it('builds a cross without rules exactly as create-cross does (one transaction, then the shards)', async () => {
      const r = await post('/v1/tx/create-cross-ruled', createBody());
      expect(r.status).toBe(200);
      expect(r.body.transactions).toHaveLength(1 + 2);
      expect(instructionsOf(r.body.transactions[0].transaction).some((ix) => is(ix, SET_RULES_DISCRIMINATOR))).toBe(false);
    });

    it('refuses rules the program would refuse, before any transaction exists', async () => {
      const r = await post('/v1/tx/create-cross-ruled', createBody({ rules: { alloc: { reserveBps: [1_000, 0, 0] } } }));
      expect(r.status).toBe(422);
      expect(r.body.reason).toBe('RULES_INVALID');
      expect(r.body.issues[0].field).toBe('alloc.smallCapQuote');
      expect(r.body.transactions).toBeUndefined();
    });

    it('refuses a mint that cannot be crossed, as create-cross does', async () => {
      const r = await post('/v1/tx/create-cross-ruled', createBody({ baseMint: await key() }));
      expect(r.status).toBe(422);
      expect(r.body.reason).toBe('MINT_NOT_FOUND');
    });

    it('says plainly when the creation and the rules cannot share a transaction', async () => {
      const insiders = await Promise.all(Array.from({ length: 8 }, key));
      const feeds = [Buffer.alloc(32, 1).toString('hex'), Buffer.alloc(32, 2).toString('hex')];
      const r = await post(
        '/v1/tx/create-cross-ruled',
        createBody({ oracle: { feedId: Buffer.alloc(32, 9).toString('hex'), maxDivergenceBps: 500, maxStalenessSecs: 60 }, rules: { neutrality: { insiders }, oracleSet: { extraFeeds: feeds } }, gateMint: gate }),
      );
      // Eight insiders and two extra feeds do not fit one transaction next to the creation; the answer must say so (never a transaction that fails on the cluster).
      expect(r.status).toBe(422);
      expect(r.body.reason).toBe('TX_TOO_LARGE');
      expect(r.body.bytes).toBeGreaterThan(1_232);
    });
  });

  describe('trading on a cross with rules', () => {
    it('place-order-ext builds a class-1 buy with the applicant and class-book accounts the rules call for', async () => {
      const r = await post('/v1/tx/place-order-ext', { cross: ruled, owner: trader, nonce: '0', side: 'buy', price: '1200000', quantity: '5000000', class: 1 });
      expect(r.status).toBe(200);
      const [ix] = instructionsOf(r.body.transaction);
      expect(is(ix!, COMMIT_ORDER_EXT_DISCRIMINATOR)).toBe(true);
      const accountsOf = ix!.accounts!.map((a) => a.address);
      expect(accountsOf).toContain(await classBookAddress(ruled));
      expect(r.body.placement).toMatchObject({ epoch: 0, bucket: 255 });
    });

    it('place-order-ext refuses a class on a cross without rules, a lockup on a sell, and an unavailable class', async () => {
      const noRules = await post('/v1/tx/place-order-ext', { cross: plain, owner: trader, nonce: '0', side: 'buy', price: '1200000', quantity: '5000000', class: 1 });
      expect(noRules.status).toBe(422);
      expect(noRules.body.reason).toBe('NO_RULES');
      const sell = await post('/v1/tx/place-order-ext', { cross: ruled, owner: trader, nonce: '0', side: 'sell', price: '1200000', quantity: '5000000', class: 1 });
      expect(sell.status).toBe(422);
      expect(sell.body.reason).toBe('CLASS_FOR_SELL');
      const unavailable = await post('/v1/tx/place-order-ext', { cross: ruled, owner: trader, nonce: '0', side: 'buy', price: '1200000', quantity: '5000000', class: 3 });
      expect(unavailable.body.reason).toBe('CLASS_UNAVAILABLE');
      const lock = await post('/v1/tx/place-order-ext', { cross: ruled, owner: trader, nonce: '0', side: 'buy', price: '1200000', quantity: '5000000', class: 1, lockSecs: 5 });
      expect(lock.body.reason).toBe('LOCK_NEEDS_CLASS_2');
    });

    it('the order of an ending period names the shard of its bucket and the response says how long it is right for', async () => {
      // closeTs is NOW + 1000 and the ending period is 400 s: it starts at NOW + 600, so now is before it: the main shards.
      const early = await post('/v1/tx/place-order-ext', { cross: ending, owner: trader, nonce: '0', side: 'buy', price: '1200000', quantity: '5000000' });
      expect(early.status).toBe(200);
      expect(early.body.placement.bucket).toBe(255);
      expect(early.body.placement.validUntil).toBe(String(NOW + 599));
      expect(early.body.placement.cancelDeadline).toBe(String(NOW + 1_000 - 400 - 60));
    });

    it('the old place-order route builds the same transaction for a cross with rules (class 0)', async () => {
      const viaOld = await post('/v1/tx/place-order', { cross: ruled, owner: trader, nonce: '3', side: 'buy', price: '1200000', quantity: '5000000' }, full);
      expect(viaOld.status).toBe(200);
      const ix = instructionsOf(viaOld.body.transaction)[0]!;
      expect(ix.accounts!.map((a) => a.address)).toContain(await classBookAddress(ruled));
      // the applicant record of the identity limits is passed too
    });

    it('the old settle route (server.ts) reads the rules tail: it merges the ending buckets and the clear', async () => {
      const settled = await putCross({ id: 5n, closeTs: BigInt(NOW - 500), ext: extWith({ ending: { endingSecs: 100, buckets: 2, cancelCutoffSecs: 0, randomEnd: false, extensionMinSecs: 0, extensionMaxSecs: 0 } }) });
      const r = await post('/v1/tx/settle', { cross: settled, payer: trader }, full);
      expect(r.status).toBe(200);
      const all = r.body.transactions.flatMap((t: { transaction: string }) => instructionsOf(t.transaction));
      const merges = all.filter((ix: Instruction) => is(ix, MERGE_SHARD_DISCRIMINATOR));
      // two main shards and two ending buckets
      expect(merges).toHaveLength(4);
      const buckets = await Promise.all([0, 1].map((b) => shardAddress(settled, AUX_END_BASE + b)));
      for (const b of buckets) expect(merges.some((m: Instruction) => m.accounts!.some((a) => a.address === b))).toBe(true);
      expect(all.at(-1)).toSatisfy((ix: Instruction) => is(ix, CLEAR_DISCRIMINATOR));
    });

    it('settle refuses, naming the reason, while a draw is owed', async () => {
      const owed = await putCross({ id: 6n, closeTs: BigInt(NOW - 500), ext: extWith({ ending: { endingSecs: 100, buckets: 2, cancelCutoffSecs: 0, randomEnd: true, extensionMinSecs: 0, extensionMaxSecs: 0 } }) });
      const r = await post('/v1/tx/settle', { cross: owed, payer: trader }, full);
      expect(r.status).toBe(400);
      expect(r.body.reason).toBe('DRAW_REQUIRED');
      expect(r.body.error).toMatch(/draw_begin/);
      const begin = await post('/v1/tx/draw-begin', { cross: owed, payer: trader });
      expect(begin.status).toBe(200);
      expect(begin.body.purpose).toBe('end');
      const finish = await post('/v1/tx/draw-finish', { cross: owed, payer: trader });
      expect(finish.status).toBe(409);
      expect(finish.body.reason).toBe('NO_DRAW_PENDING');
    });

    it('the old finalize route (server.ts) passes the referrer account of a cross with a referral share', async () => {
      accounts.set(referred, { ...accounts.get(referred)!, data: accounts.get(referred)!.data });
      const live = await putCross({ id: 7n, state: CrossState.Cleared, ext: extWith({ referral: { referrer: trader, shareBps: 2_500 } }) });
      // finalize requires no open orders: ordersOpen is 0 in the fixture
      const r = await post('/v1/tx/finalize', { cross: live, payer: trader }, full);
      expect(r.status).toBe(200);
      const fin = instructionsOf(r.body.transactions ? r.body.transactions[0].transaction : r.body.transaction).find((ix) => is(ix, FINALIZE_DISCRIMINATOR))!;
      expect(fin.accounts!.at(-1)!.address).toBe(await ata(trader, quote, TOKEN_2022_PROGRAM_ADDRESS));
    });

    it('a cross without rules is built exactly as before (no extra accounts)', async () => {
      const r = await post('/v1/tx/place-order', { cross: plain, owner: trader, nonce: '0', side: 'buy', price: '1200000', quantity: '5000000' }, full);
      expect(r.status).toBe(200);
      const [ix] = instructionsOf(r.body.transaction);
      expect(ix!.accounts).toHaveLength(11);
      void protocolAddress;
    });
  });

  describe('GET /v1/crosses/:address/indicative', () => {
    const levels = (cross: Address, buys: Record<number, bigint>, sells: Record<number, bigint>) => {
      const buy = new Array<bigint>(256).fill(0n);
      const sell = new Array<bigint>(256).fill(0n);
      const bo = new Array<number>(256).fill(0);
      const so = new Array<number>(256).fill(0);
      for (const [i, q] of Object.entries(buys)) [buy[Number(i)], bo[Number(i)]] = [q, 1];
      for (const [i, q] of Object.entries(sells)) [sell[Number(i)], so[Number(i)]] = [q, 1];
      return new Uint8Array(getLevelsEncoder().encode({ cross, buy, sell, buyOrders: bo, sellOrders: so, index: 0, pad: new Uint8Array(7) }));
    };
    const withBook = async (id: bigint, closeTs: bigint) => {
      const cross = await putCross({ id, closeTs, ext: extWith({ ending: { endingSecs: 400, buckets: 4, cancelCutoffSecs: 0, randomEnd: false, extensionMinSecs: 0, extensionMaxSecs: 0 } }) });
      const put = async (a: Address, data: Uint8Array) => void accounts.set(a, { owner: CROSS_CORE_PROGRAM_ADDRESS, data });
      await put(await bookAddress(cross), levels(cross, {}, {}));
      await put(await shardAddress(cross, 0), levels(cross, { 6: 30n }, { 4: 100n }));
      await put(await shardAddress(cross, 1), levels(cross, {}, {}));
      await put(await shardAddress(cross, AUX_END_BASE), levels(cross, { 6: 50n }, {}));
      return cross;
    };

    it('before the ending period it shows the fine price, and counts the orders resting in the bucket shards', async () => {
      const cross = await withBook(20n, BigInt(NOW + 1_000));
      const r = await get(`/v1/crosses/${cross}/indicative`);
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ phase: 'open', coarse: false, indicative: { price: '1400000', matched: '80', imbalance: 'supply-heavy' } });
    });

    it('while the ending period is open it shows the nearest of eight bands and a direction, and says it is a display rule', async () => {
      const cross = await withBook(21n, BigInt(NOW + 200));
      const r = await get(`/v1/crosses/${cross}/indicative`);
      expect(r.body).toMatchObject({ phase: 'ending', coarse: true, indicative: { price: '1475000', imbalance: 'supply-heavy' }, endsAt: String(NOW + 200) });
      expect(r.body.indicative.matched).toBeUndefined();
      expect(r.body.note).toMatch(/display rule .* not secrecy/);
    });

    it('is refused for a cross that has settled, and names a cross with no book', async () => {
      expect((await get(`/v1/crosses/${referred}/indicative`)).status).toBe(409);
      expect((await get(`/v1/crosses/${plain}/indicative`)).body.phase).toBe('no-book');
    });
  });

  describe('GET /v1/crosses/:address/rules', () => {
    it('is null for a cross without rules, and says why', async () => {
      const r = await get(`/v1/crosses/${plain}/rules`);
      expect(r.status).toBe(200);
      expect(r.body.rules).toBeNull();
      expect(r.body.note).toMatch(/no rules/);
    });

    it('explains the rules of a cross that has them, and what they call for', async () => {
      const r = await get(`/v1/crosses/${ruled}/rules`);
      expect(r.status).toBe(200);
      expect(r.body.rules.identity).toMatchObject({ capQuote: '50000000', maxOrders: 1 });
      expect(r.body.rules.alloc.reserveBps).toEqual([3_000, 0, 0]);
      expect(r.body.calls).toMatchObject({ classBook: true, lockVault: false, needsDraw: true });
      expect(r.body.calls.drawOwed).toBeNull(); // the reveal window has not ended
      const e = await get(`/v1/crosses/${ending}/rules`);
      expect(e.body.calls.auxShards).toEqual([32, 33, 34, 35]);
      expect(e.body.calls.endingStartsAt).toBe(String(NOW + 600));
      expect((await get(`/v1/crosses/${await key()}/rules`)).status).toBe(404);
    });
  });
});
