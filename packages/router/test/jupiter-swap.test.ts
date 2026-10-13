import { describe, expect, it } from 'vitest';
import type { Address } from '@solana/kit';
import { jupiterSwapTransaction } from '../src/index.js';

const BASE = 'So11111111111111111111111111111111111111112' as Address;
const QUOTE = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' as Address;
const USER = 'DTB3Jtxb6dy7GvocUbypiJb548ZLGRzVdPrNNCWAKEdC' as Address;

function fakeJupiter(over: { quoteStatus?: number; swapStatus?: number; noTx?: boolean } = {}) {
  const calls: { url: string; body?: unknown }[] = [];
  const fetchImpl = (async (input: URL | string, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    if (url.includes('/quote')) {
      if (over.quoteStatus) return new Response('no route', { status: over.quoteStatus });
      return new Response(JSON.stringify({ inAmount: '1500000', outAmount: '1000000', priceImpactPct: '0.01', routePlan: [{ swapInfo: { label: 'Meteora DLMM' } }, { swapInfo: { label: 'Orca' } }] }), { status: 200 });
    }
    if (over.swapStatus) return new Response('bad', { status: over.swapStatus });
    return new Response(JSON.stringify(over.noTx ? {} : { swapTransaction: 'AQID', lastValidBlockHeight: 123 }), { status: 200 });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe('jupiterSwapTransaction', () => {
  it('asks for an exact-out quote for a buy and then for the swap of that very quote, for the user', async () => {
    const f = fakeJupiter();
    const out = await jupiterSwapTransaction({ baseMint: BASE, quoteMint: QUOTE, intent: { side: 'buy', quantity: 1_000_000n }, userPublicKey: USER, fetchImpl: f.fetchImpl });
    const q = new URL(f.calls[0]!.url);
    expect(q.searchParams.get('swapMode')).toBe('ExactOut');
    expect(q.searchParams.get('inputMint')).toBe(QUOTE);
    expect(q.searchParams.get('outputMint')).toBe(BASE);
    expect(q.searchParams.get('amount')).toBe('1000000');
    expect(q.searchParams.get('slippageBps')).toBe('50');
    expect(f.calls[1]!.body).toMatchObject({ userPublicKey: USER, quoteResponse: { inAmount: '1500000' } });
    expect(out).toEqual({ transaction: 'AQID', lastValidBlockHeight: 123n, quote: { inAmount: 1_500_000n, outAmount: 1_000_000n, priceImpactPct: '0.01', route: ['Meteora DLMM', 'Orca'], swapMode: 'ExactOut', slippageBps: 50 } });
  });

  it('sells with an exact-in quote and passes a chosen slippage', async () => {
    const f = fakeJupiter();
    await jupiterSwapTransaction({ baseMint: BASE, quoteMint: QUOTE, intent: { side: 'sell', quantity: 7n }, userPublicKey: USER, slippageBps: 25, fetchImpl: f.fetchImpl });
    const q = new URL(f.calls[0]!.url);
    expect([q.searchParams.get('swapMode'), q.searchParams.get('inputMint'), q.searchParams.get('slippageBps')]).toEqual(['ExactIn', BASE, '25']);
  });

  it('fails with Jupiter\'s own words when the quote, the swap or the transaction is missing', async () => {
    const run = (o: Parameters<typeof fakeJupiter>[0]) => jupiterSwapTransaction({ baseMint: BASE, quoteMint: QUOTE, intent: { side: 'buy', quantity: 1n }, userPublicKey: USER, fetchImpl: fakeJupiter(o).fetchImpl });
    await expect(run({ quoteStatus: 404 })).rejects.toThrow(/quote answered HTTP 404: no route/);
    await expect(run({ swapStatus: 400 })).rejects.toThrow(/swap answered HTTP 400/);
    await expect(run({ noTx: true })).rejects.toThrow(/no transaction/);
  });
});
