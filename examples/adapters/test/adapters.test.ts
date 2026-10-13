import { describe, expect, it } from 'vitest';
import { type Address, generateKeyPair, generateKeyPairSigner, getAddressFromPublicKey } from '@solana/kit';
import { buildAllowlist } from '@opening-cross/sdk';
import { verifyQuote } from '@opening-cross/liquidity';
import { PlanError, gridAround, planBlockSale, planHaltResume, planReopen, planTender, publishQuote, routeOrder } from '../src/index.js';

const B = 'So11111111111111111111111111111111111111112';
const Q = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const TP = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const NOW = 1_800_000_000n;
const WHO = 'DTB3Jtxb6dy7GvocUbypiJb548ZLGRzVdPrNNCWAKEdC';
const common = { creator: WHO, baseMint: B, quoteMint: Q, baseProgram: TP, quoteProgram: TP, baseDecimals: 6, now: NOW, crossId: 7n };

describe('gridAround', () => {
  it('puts the reference on the grid, in the middle, and covers at least the band', () => {
    const g = gridAround(1_500_000n, 1_000, 41);
    expect(g).toEqual({ minPrice: 1_350_000n, tick: 7_500n, ticks: 41 }); // 10% of 1.5 is 150,000; 20 ticks each side
    expect(g.minPrice + 20n * g.tick).toBe(1_500_000n);
    expect(g.minPrice + 40n * g.tick).toBe(1_650_000n);
  });
  it('rounds the tick up so the band is not narrower than asked, and refuses what cannot be centred', () => {
    const g = gridAround(1_000_003n, 1_000, 41);
    expect(g.tick * 20n >= 100_001n).toBe(true);
    expect(g.minPrice + g.tick * 20n).toBe(1_000_003n);
    expect(() => gridAround(0n, 100, 41)).toThrow(PlanError);
    expect(() => gridAround(1_000n, 100, 40)).toThrow(/odd number/);
    expect(() => gridAround(1_000n, 10_000, 41)).toThrow(/half band/);
    expect(() => gridAround(5n, 9_000, 41)).toThrow(/too small/);
    expect(gridAround(100n, 9_000, 3).minPrice).toBeGreaterThan(0n);
  });
});

describe('reopen adapter', () => {
  it('closes before the market reopens, with the guards and a grid centred on the reference', () => {
    const p = planReopen({ ...common, sessionOpenTs: NOW + 7_200n, referencePrice: 1_500_000n, disclosure: 'sealed' });
    const r = p.request;
    expect(r.kind).toBe('reopen');
    expect(r.closeTs).toBe(NOW + 7_200n - 300n - 300n); // settle time and reveal time both fit before the open
    expect(r.revealEndTs).toBe(r.closeTs + 300n);
    expect(r.openTs).toBe(r.closeTs - 3_600n);
    expect(r.referencePrice).toBe(1_500_000n);
    expect(r.priceScale).toBe(1_000_000n);
    expect(r.maxImbalanceBps).toBe(5_000);
    expect(r.minMatched).toBe(1n);
    expect(p.explanation[0]).toContain(`reopens at ${NOW + 7_200n}`);
    expect(p.warnings.join(' ')).toContain('No oracle guard');
    expect(p.warnings.join(' ')).toContain('not bound to a calendar');
  });

  it('opens at once when the session is closer than a full call, takes an oracle and a calendar, and drops those warnings', () => {
    const p = planReopen({ ...common, sessionOpenTs: NOW + 900n, referencePrice: 1_500_000n, oracle: { feedId: 'ab'.repeat(32), maxDivergenceBps: 300, maxStalenessSecs: 60 }, calendar: WHO });
    expect(p.request.openTs).toBe(NOW);
    expect(p.request.closeTs).toBe(NOW + 600n);
    expect(p.request.oracle).toMatchObject({ maxDivergenceBps: 300 });
    expect(p.request.calendar).toBe(WHO);
    expect(p.warnings.join(' ')).not.toContain('oracle guard:');
  });

  it('refuses a session that is too close for the call, the clear and the reveal', () => {
    expect(() => planReopen({ ...common, sessionOpenTs: NOW + 300n, referencePrice: 1n, disclosure: 'sealed' })).toThrow(/needs at least 660 seconds/);
  });
});

describe('halt-resume adapter', () => {
  const base = { ...common, risks: [], wasHalted: true, lastPrint: 1_500_000n };
  it('waits while the token is halted or unusable, or was never halted, or never printed, and says which', () => {
    expect(planHaltResume({ ...base, risks: [{ severity: 'halt', code: 'PAUSED', message: 'the issuer paused the token' }] })).toEqual({ action: 'wait', reason: 'still halted: the issuer paused the token' });
    expect(planHaltResume({ ...base, risks: [{ severity: 'block', code: 'HOOK', message: 'it has a transfer hook' }] })).toMatchObject({ action: 'wait', reason: expect.stringContaining('cannot be crossed') });
    expect(planHaltResume({ ...base, wasHalted: false })).toMatchObject({ action: 'wait', reason: expect.stringContaining('not halted') });
    expect(planHaltResume({ ...base, lastPrint: null })).toMatchObject({ action: 'wait', reason: expect.stringContaining('never printed') });
  });
  it('once the halt has lifted, plans a short sealed call on a grid twice as wide as a reopen', () => {
    const p = planHaltResume({ ...base, risks: [{ severity: 'disclose', code: 'MINT_AUTHORITY', message: 'the issuer can mint' }] });
    if ('action' in p) throw new Error('expected a plan');
    expect(p.request.disclosure).toBe('sealed');
    expect(p.request.kind).toBe('reopen');
    expect(p.request.closeTs - p.request.openTs).toBeLessThanOrEqual(600n);
    expect(p.request.ticks).toBe(41);
    const reopen = planReopen({ ...common, referencePrice: 1_500_000n, sessionOpenTs: NOW + 7_200n });
    expect(p.request.tick).toBeGreaterThan(reopen.request.tick);
    expect(p.explanation[0]).toContain('Trading resumes through a call');
  });
});

describe('tender adapter', () => {
  const holders = [WHO, 'Ao9ZJvc133Ui22aKTfSvoP5WdEVJxF25ns25uL1ipaFc', 'ESbKzKFcLz4g5m4rhzSHk9YHCT6skkEZgmEPZa9kAUfm'];
  const input = { ...common, issuer: WHO, floorPrice: 1_000_000n, ceilingPrice: 2_000_000n, quantity: 1_000_000_000n, holders, acknowledgeNotLegalAdvice: true };

  it('refuses to plan a tender before the legal question has been asked', () => {
    expect(() => planTender({ ...input, acknowledgeNotLegalAdvice: false })).toThrow(/HS4/);
  });

  it('plans a gated, sealed offer with a floor, a minimum fill, and prints the allowlist root the gate needs', () => {
    const p = planTender(input);
    expect(p.request).toMatchObject({ kind: 'tender', disclosure: 'sealed', minPrice: 1_000_000n, ticks: 41, tick: 25_000n, gateMint: B, proceedsTo: WHO });
    expect(p.request.minMatched).toBe(500_000_000n);
    expect(p.request.closeTs).toBe(NOW + 7n * 86_400n);
    const { root } = buildAllowlist(B as Address, holders as Address[]);
    expect(p.gate).toEqual({ mint: B, holders: 3, merkleRoot: Buffer.from(root).toString('hex') });
    expect(p.warnings.join(' ')).toContain('legal questions');
  });

  it('refuses an empty or repeating holder list, a window under the floor, a ceiling below the floor', () => {
    expect(() => planTender({ ...input, holders: [] })).toThrow(/at least one/);
    expect(() => planTender({ ...input, holders: [WHO, WHO] })).toThrow(/repeats 1/);
    expect(() => planTender({ ...input, windowSecs: 3_600 })).toThrow(/at least 604800/);
    expect(planTender({ ...input, windowSecs: 3_600, minWindowSecs: 60 }).request.closeTs).toBe(NOW + 3_600n);
    expect(() => planTender({ ...input, ceilingPrice: 1_000_000n })).toThrow(/above the floor/);
  });
});

describe('block-sale adapter', () => {
  const input = { ...common, seller: WHO, amount: 5_000_000_000n, reservePrice: 2_000_000n };
  it('makes the reserve the lowest price on the grid and the whole block one sell order', () => {
    const p = planBlockSale(input);
    expect(p.request).toMatchObject({ kind: 'tender', creator: WHO, proceedsTo: WHO, minPrice: 2_000_000n, supplyMode: 'escrow', disclosure: 'sealed' });
    expect(p.request.minPrice + BigInt(p.request.ticks - 1) * p.request.tick).toBeGreaterThanOrEqual(8_000_000n); // four times the reserve by default
    expect(p.request.minMatched).toBe(2_500_000_000n);
    expect(p.sellOrder).toEqual({ side: 'sell', price: 2_000_000n, quantity: 5_000_000_000n });
    expect(p.warnings.join(' ')).toContain('two transactions');
  });
  it('refuses a block of nothing, a zero reserve and a ceiling that is not above it', () => {
    expect(() => planBlockSale({ ...input, amount: 0n })).toThrow(PlanError);
    expect(() => planBlockSale({ ...input, reservePrice: 0n })).toThrow(PlanError);
    expect(() => planBlockSale({ ...input, ceilingPrice: 2_000_000n })).toThrow(/above the reserve/);
  });
});

describe('aggregator adapter', () => {
  const order = { base: B, quote: Q, side: 'buy' as const, amount: '1000000', owner: WHO };
  it('asks for the ranking and then for the winner\'s transaction', async () => {
    const calls: string[] = [];
    const f = (async (u: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${String(u).replace('https://api.test', '')}`);
      if (String(u).includes('/v1/router/quote')) return new Response(JSON.stringify({ best: { venue: 'cross' }, venues: [] }), { status: 200 });
      return new Response(JSON.stringify({ venue: 'cross', cross: 'X', transaction: 'AQID', signers: [WHO], limit: { price: '1' }, message: 'Join the cross' }), { status: 200 });
    }) as unknown as typeof fetch;
    const r = await routeOrder('https://api.test', order, f);
    expect(calls).toEqual([`GET /v1/router/quote?base=${B}&quote=${Q}&side=buy&amount=1000000`, 'POST /v1/route/execute']);
    expect(r.built).toMatchObject({ venue: 'cross', transaction: 'AQID', signers: [WHO] });
  });
  it('reports why nothing was built instead of inventing a transaction', async () => {
    const f = (async (u: string) => (String(u).includes('/quote') ? new Response(JSON.stringify({ venues: [] }), { status: 200 }) : new Response(JSON.stringify({ error: 'no venue can fill this order right now' }), { status: 422 }))) as unknown as typeof fetch;
    expect((await routeOrder('https://api.test', order, f)).built).toEqual({ none: 'no venue can fill this order right now' });
  });
});

describe('market-maker quote publisher', () => {
  it('signs a quote the API can verify and posts it', async () => {
    const kp = await generateKeyPair();
    const maker = await getAddressFromPublicKey(kp.publicKey);
    const cross = (await generateKeyPairSigner()).address;
    let posted: unknown;
    const f = (async (_u: string, init: RequestInit) => ((posted = JSON.parse(String(init.body))), new Response(JSON.stringify({ id: 'x' }), { status: 201 }))) as unknown as typeof fetch;
    const out = await publishQuote('https://api.test', { address: maker, keyPair: kp }, { cross, side: 'sell', price: 1_550_000n, quantity: 200_000_000n, nonce: 9n }, { now: 1_800_000_000, ttlSeconds: 300, fetchImpl: f });
    expect(out.status).toBe(201);
    expect(await verifyQuote(posted as never, 1_800_000_000)).toEqual({ ok: true });
    expect((posted as { body: { orderNonce: string; expiresAt: number } }).body).toMatchObject({ orderNonce: '9', expiresAt: 1_800_000_300 });
  });
});
