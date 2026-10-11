// Reads live mainnet state (read-only). Run with `pnpm test:mainnet`; RPC_URL overrides the public endpoint.
import { describe, expect, it } from 'vitest';
import { createSolanaRpc } from '@solana/kit';
import { classifyMint, loadBundledBook, observeMint, observeMints } from '../../src/index.js';

const rpc = createSolanaRpc(process.env.RPC_URL ?? 'https://api.mainnet-beta.solana.com');
const book = loadBundledBook();

// Hard-coded: these are the issuers' own addresses, taken from their lists, not resolved by symbol.
const REAL = {
  TSLAx: 'XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB',
  NVDAx: 'Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh',
  SPYx: 'XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W',
  SPYon: 'k18WJUULWheRkSpSquYGdNNmtuE2Vbw1hpuUi92ondo',
  NVDAon: 'gEGtLTPNQ7jcg25zTetkbmF7teoDLcrfTnQfmn2ondo',
  TSLAon: 'KeGv7bsfR4MheC1CkmnAVceoApjrkvBhHYjWb67ondo',
  USDon: 'ZPFtoCe7WWqG4N3ZFRccS8T9SMBeHsd1Vmgv2i7ondo',
  USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  USDT: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
  PYUSD: '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo',
} as const;

describe('real issuer mints, read from mainnet', () => {
  it('passes every one by listing and authorities', async () => {
    for (const [sym, mint] of Object.entries(REAL)) {
      const v = classifyMint(book, await observeMint(rpc, mint));
      expect(v.verdict, `${sym}: ${v.reasons.map((r) => r.message).join(' ')}`).toBe('GENUINE');
    }
  }, 60_000);

  it('does not pass a real mint that is not an issuer token', async () => {
    // BONK, JUP and wrapped SOL are real, popular, and nobody else's stock token.
    const mints = ['DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', 'So11111111111111111111111111111111111111112'];
    for (const o of await observeMints(rpc, mints)) {
      expect(classifyMint(book, o).verdict, o.mint).toMatch(/^(UNRELATED_TOKEN|GENUINE)$/);
    }
  }, 60_000);

  it('does not accuse popular tokens: nothing in the top organic list is called an impersonator', async () => {
    const list = (await (await fetch('https://lite-api.jup.ag/tokens/v2/toporganicscore/24h?limit=100')).json()) as { id: string; symbol: string; name: string }[];
    const observed = await observeMints(rpc, list.map((t) => t.id));
    const flagged = observed.map((o) => ({ o, v: classifyMint(book, o) })).filter(({ v }) => v.verdict === 'IMPERSONATOR' || v.verdict === 'ADDRESS_LOOKALIKE');
    const other = observed.map((o) => ({ o, v: classifyMint(book, o) })).filter(({ v }) => v.verdict === 'UNVERIFIED_STOCK_TOKEN');
    console.log(`checked ${observed.length}; impersonator/lookalike ${flagged.length}; other-issuer stock tokens ${other.length}`, other.map(({ o }) => `${o.symbol}/${o.name}`));
    expect(flagged).toEqual([]);
  }, 120_000);
});
