// /v1/tokens/:mint/safety, the `safety` field of /v1/crosses/:address and the create-cross gate, over HTTP with
// accounts injected in memory. No database is read on these paths, so a stub pool stands in and the file always runs.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { type Address, generateKeyPairSigner, some } from '@solana/kit';
import { CROSS_CORE_PROGRAM_ADDRESS, CROSS_DISCRIMINATOR, CrossState, getCrossDecoder, getCrossEncoder } from '@opening-cross/sdk';
import { buildServer } from '../src/server.js';
import { mintAccount } from './helpers/mint.js';

const ISSUER = 'DTB3Jtxb6dy7GvocUbypiJb548ZLGRzVdPrNNCWAKEdC' as Address;
const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

const noDb = { query: async () => { throw new Error('this path must not read the database'); } } as unknown as pg.Pool;

describe('mint safety over HTTP', () => {
  const accounts = new Map<string, { data: Uint8Array; owner: Address }>();
  const reads = new Map<string, number>();
  let app: Awaited<ReturnType<typeof buildServer>>;
  let m: Record<string, Address>;
  let creator: Address;
  let crossAddress: Address;

  const mint = async (name: string, acct: { data: Uint8Array; owner: Address }) => {
    const a = (await generateKeyPairSigner()).address;
    accounts.set(a, acct);
    m[name] = a;
  };

  beforeAll(async () => {
    m = {};
    creator = (await generateKeyPairSigner()).address;
    await mint('plain', mintAccount(null, { decimals: 6 }));
    await mint('stock', mintAccount([{ __kind: 'PausableConfig', authority: some(ISSUER), paused: false }, { __kind: 'PermanentDelegate', delegate: ISSUER }], { freeze: true, mintAuth: true, decimals: 8 }));
    await mint('paused', mintAccount([{ __kind: 'PausableConfig', authority: some(ISSUER), paused: true }]));
    await mint('hooked', mintAccount([{ __kind: 'TransferHook', authority: ISSUER, programId: ISSUER }]));
    await mint('fee', mintAccount([{ __kind: 'TransferFeeConfig', transferFeeConfigAuthority: ISSUER, withdrawWithheldAuthority: ISSUER, withheldAmount: 0n, olderTransferFee: { epoch: 0n, maximumFee: 10n, transferFeeBasisPoints: 25 }, newerTransferFee: { epoch: 0n, maximumFee: 10n, transferFeeBasisPoints: 25 } }]));
    await mint('wallet', { data: new Uint8Array(0), owner: '11111111111111111111111111111111' as Address });

    const z = new Uint8Array(4096);
    z.set(CROSS_DISCRIMINATOR as Uint8Array, 0);
    const base = getCrossDecoder().decode(z);
    crossAddress = (await generateKeyPairSigner()).address;
    accounts.set(crossAddress, {
      owner: CROSS_CORE_PROGRAM_ADDRESS,
      data: new Uint8Array(getCrossEncoder().encode({ ...base, state: CrossState.Live, baseBound: true, baseMint: m.stock, quoteMint: m.plain, creator, priceScale: 1_000_000n, baseDecimals: 8, quoteDecimals: 6 } as never)),
    });
    const unbound = (await generateKeyPairSigner()).address;
    accounts.set(unbound, { owner: CROSS_CORE_PROGRAM_ADDRESS, data: new Uint8Array(getCrossEncoder().encode({ ...base, state: CrossState.Live, baseBound: false, quoteMint: m.plain, creator } as never)) });
    m.unboundCross = unbound;

    app = await buildServer({
      db: noDb,
      network: 'devnet',
      account: async (a) => {
        reads.set(a, (reads.get(a) ?? 0) + 1);
        return accounts.get(a) ?? null;
      },
      lifetime: async () => ({ blockhash: '4NCYB3kRT8sCNodPNuCZo8VkwveZSHhg7R7mrRBFM1Uy' as never, lastValidBlockHeight: 100n }),
    });
  });
  afterAll(async () => app.close());

  const get = async (url: string) => {
    const r = await app.inject({ method: 'GET', url });
    return { status: r.statusCode, body: JSON.parse(r.body) };
  };
  const post = async (url: string, payload: unknown) => {
    const r = await app.inject({ method: 'POST', url, payload: payload as never });
    return { status: r.statusCode, body: JSON.parse(r.body) };
  };

  it('GET safety for a plain mint is clear', async () => {
    const { status, body } = await get(`/v1/tokens/${m.plain}/safety`);
    expect(status).toBe(200);
    expect(body).toMatchObject({ mint: m.plain, decimals: 6, verdict: 'clear', crossable: true, risks: [], uiMultiplier: 1, clock: 'api wall clock' });
    expect(body.summary).toMatch(/No issuer powers/);
  });

  it('GET safety lists every issuer power of a stock-style token with plain-language levels', async () => {
    const { body } = await get(`/v1/tokens/${m.stock}/safety`);
    expect(body.verdict).toBe('disclosures');
    expect(body.crossable).toBe(true);
    expect(body.risks.map((r: { code: string }) => r.code).sort()).toEqual(['FREEZE_AUTHORITY', 'MINT_AUTHORITY', 'PAUSE_AUTHORITY', 'PERMANENT_DELEGATE']);
    expect(body.risks.every((r: { level: string; holder: string }) => r.level === 'disclosure' && r.holder === ISSUER)).toBe(true);
    expect(body.tokenProgram).toBe(TOKEN_2022);
    expect(body.supply).toBe('1000');
  });

  it('GET safety reports a paused mint as halted and a hooked or fee-charging mint as blocked', async () => {
    expect((await get(`/v1/tokens/${m.paused}/safety`)).body).toMatchObject({ verdict: 'halted', crossable: false });
    const hooked = (await get(`/v1/tokens/${m.hooked}/safety`)).body;
    expect(hooked).toMatchObject({ verdict: 'blocked', crossable: false });
    expect(hooked.risks[0]).toMatchObject({ code: 'TRANSFER_HOOK', level: 'blocker' });
    expect((await get(`/v1/tokens/${m.fee}/safety`)).body.risks[0]).toMatchObject({ code: 'TRANSFER_FEE', level: 'blocker' });
  });

  it('GET safety: 400 for a bad address, 404 for a missing account, 422 for a non-mint, with the same error shape', async () => {
    expect((await get('/v1/tokens/not-an-address/safety')).status).toBe(400);
    const missing = (await generateKeyPairSigner()).address;
    expect(await get(`/v1/tokens/${missing}/safety`)).toMatchObject({ status: 404, body: { error: expect.stringMatching(/does not exist/) } });
    expect(await get(`/v1/tokens/${m.wallet}/safety`)).toMatchObject({ status: 422, body: { error: expect.stringMatching(/not a token mint/) } });
  });

  it('repeated requests are served from the cache', async () => {
    const before = reads.get(m.plain!) ?? 0;
    await get(`/v1/tokens/${m.plain}/safety`);
    await get(`/v1/tokens/${m.plain}/safety`);
    expect((reads.get(m.plain!) ?? 0) - before).toBe(0);
  });

  it('the cross carries the base mint verdict; an unbound base mint gives null; the cross never fails on it', async () => {
    const live = await get(`/v1/crosses/${crossAddress}`);
    expect(live.status).toBe(200);
    expect(live.body.safety).toMatchObject({ mint: m.stock, verdict: 'disclosures' });
    expect((await get(`/v1/crosses/${m.unboundCross}`)).body.safety).toBeNull();
    accounts.delete(m.stock!);
    const cached = await get(`/v1/crosses/${crossAddress}`);
    expect(cached.status).toBe(200); // verdict still cached
  });

  describe('create-cross gate', () => {
    const body = (over: Record<string, unknown>) => ({
      creator,
      quoteMint: m.plain,
      baseTokenProgram: TOKEN_2022,
      quoteTokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
      crossId: '1',
      kind: 'launch',
      supplyMode: 'escrow',
      disclosure: 'open',
      minPrice: '1000',
      tick: '1000',
      ticks: 10,
      priceScale: '1000000',
      openTs: '1800000000',
      closeTs: '1800003600',
      revealEndTs: '1800003600',
      integrator: creator,
      shards: 1,
      maxOrders: 100,
      proceedsTo: creator,
      ...over,
    });

    it('refuses an active transfer hook with HTTP 422 and a typed reason, building nothing', async () => {
      const r = await post('/v1/tx/create-cross', body({ baseMint: m.hooked }));
      expect(r.status).toBe(422);
      expect(r.body).toMatchObject({ reason: 'MINT_NOT_CROSSABLE', code: 'TRANSFER_HOOK', role: 'base', mint: m.hooked });
      expect(r.body.blockers[0].level).toBe('blocker');
      expect(r.body.transactions).toBeUndefined();
    });

    it('refuses a transfer-fee base mint and a blocked quote mint, naming the role', async () => {
      expect((await post('/v1/tx/create-cross', body({ baseMint: m.fee }))).body).toMatchObject({ reason: 'MINT_NOT_CROSSABLE', code: 'TRANSFER_FEE', role: 'base' });
      expect((await post('/v1/tx/create-cross', body({ baseMint: m.plain, quoteMint: m.hooked }))).body).toMatchObject({ reason: 'MINT_NOT_CROSSABLE', role: 'quote' });
    });

    it('refuses a base mint that does not exist or is not a token mint, with typed reasons', async () => {
      const missing = (await generateKeyPairSigner()).address;
      expect((await post('/v1/tx/create-cross', body({ baseMint: missing }))).body).toMatchObject({ reason: 'MINT_NOT_FOUND', role: 'base' });
      expect((await post('/v1/tx/create-cross', body({ baseMint: m.wallet }))).body).toMatchObject({ reason: 'NOT_A_TOKEN_MINT' });
    });

    it('still validates the request first: a malformed field is a 400, not a safety answer', async () => {
      expect((await post('/v1/tx/create-cross', body({ baseMint: m.hooked, ticks: -1 }))).status).toBe(400);
    });

    it('a paused or privileged base mint is allowed, with the powers returned as warnings next to the transactions', async () => {
      const paused = await post('/v1/tx/create-cross', body({ baseMint: m.paused }));
      expect(paused.status).toBe(200);
      expect(paused.body.transactions.length).toBeGreaterThan(0);
      expect(paused.body.warnings).toEqual([expect.objectContaining({ code: 'MINT_PAUSED', level: 'halt', message: expect.stringMatching(/^base mint: /) })]);
      const stock = await post('/v1/tx/create-cross', body({ baseMint: m.stock, crossId: '2' }));
      expect(stock.status).toBe(200);
      expect(stock.body.warnings.map((w: { code: string }) => w.code).sort()).toEqual(['FREEZE_AUTHORITY', 'MINT_AUTHORITY', 'PAUSE_AUTHORITY', 'PERMANENT_DELEGATE']);
    });

    it('a clean base mint returns no warnings; a deferred-mint cross (no base mint) is not gated', async () => {
      const clean = await post('/v1/tx/create-cross', body({ baseMint: m.plain, crossId: '3' }));
      expect(clean.status).toBe(200);
      expect(clean.body.warnings).toEqual([]);
      const deferred = await post('/v1/tx/create-cross', body({ supplyMode: 'deferred-mint', crossId: '4', settleDeadlineTs: '1800009999' }));
      expect(deferred.status).toBe(200);
      expect(deferred.body.warnings).toEqual([]);
      expect(deferred.body.reason).toBeUndefined();
    });
  });
});
