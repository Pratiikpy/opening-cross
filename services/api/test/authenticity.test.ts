// The authenticity endpoints over HTTP. The account reader is mainnet itself, so these read real mints (read-only).
import { describe, expect, it } from 'vitest';
import { type Address, createSolanaRpc, fetchEncodedAccount } from '@solana/kit';
import type pg from 'pg';
import { buildServer } from '../src/server.js';

const rpc = createSolanaRpc(process.env.RPC_URL ?? 'https://api.mainnet-beta.solana.com');
const account = async (a: Address) => {
  const x = await fetchEncodedAccount(rpc, a);
  return x.exists ? { data: x.data as Uint8Array, owner: x.programAddress } : null;
};
// These endpoints never touch the database.
const db = {} as pg.Pool;
const lifetime = async () => ({ blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 0n }) as never;

const TSLAX = 'XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';

describe('GET /v1/tokens/:mint/authenticity', () => {
  it('passes the real TSLAx and USDC on mainnet and does not pass BONK', async () => {
    const app = await buildServer({ db, account, lifetime, network: 'mainnet-beta' });
    const get = async (mint: string) => (await app.inject({ method: 'GET', url: `/v1/tokens/${mint}/authenticity` })).json();
    const tsla = await get(TSLAX);
    expect(tsla.comparable).toBe(true);
    expect(tsla.verdict.verdict).toBe('GENUINE');
    expect(tsla.verdict.listing.symbol).toBe('TSLAx');
    expect(tsla.registry.sources.map((s: { id: string }) => s.id)).toEqual(expect.arrayContaining(['xstocks_api', 'ondo_csv']));
    expect((await get(USDC)).verdict.verdict).toBe('GENUINE');
    expect((await get(BONK)).verdict.verdict).toBe('UNRELATED_TOKEN');
  }, 60_000);

  it('says so instead of guessing when the API follows another network', async () => {
    const app = await buildServer({ db, account, lifetime, network: 'devnet' });
    const r = await app.inject({ method: 'GET', url: `/v1/tokens/${TSLAX}/authenticity` });
    expect(r.statusCode).toBe(200);
    expect(r.json().comparable).toBe(false);
    expect(r.json().verdict).toBeUndefined();
  });

  it('rejects an address that is not base58 and reports an absent account as NOT_A_MINT', async () => {
    const app = await buildServer({ db, account, lifetime, network: 'mainnet-beta' });
    expect((await app.inject({ method: 'GET', url: '/v1/tokens/not-an-address/authenticity' })).statusCode).toBe(400);
    const absent = await app.inject({ method: 'GET', url: '/v1/tokens/4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T/authenticity' });
    expect(absent.json().verdict.verdict).toMatch(/NOT_A_MINT|UNRELATED_TOKEN/);
  }, 30_000);
});
