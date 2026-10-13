import { beforeAll, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { type Address, generateKeyPairSigner } from '@solana/kit';
import { ata } from '@opening-cross/sdk';
import { RequestError } from '../src/tx.js';
import { MAX_MINTS, mintDecimals, registerHolderBalances, tokenAmount } from '../src/routes/holder-balances.js';
import { TOKEN_PROGRAM, tokenAccount } from './helpers/holder-cross.js';

const mintAccount = (decimals: number) => {
  const d = new Uint8Array(82);
  d[44] = decimals;
  return { data: d, owner: TOKEN_PROGRAM };
};

describe('mint and token account layouts', () => {
  it('reads decimals at byte 44 and the amount at byte 64, and refuses short data', () => {
    expect(mintDecimals(mintAccount(9).data)).toBe(9);
    expect(mintDecimals(new Uint8Array(40))).toBeNull();
    expect(tokenAmount(tokenAccount('11111111111111111111111111111112' as Address, '11111111111111111111111111111113' as Address, 123_456_789n).data)).toBe(123_456_789n);
    expect(tokenAmount(new Uint8Array(10))).toBe(0n);
  });
});

describe('GET /v1/balances/:owner', () => {
  const accounts = new Map<string, { data: Uint8Array; owner: Address }>();
  let app: ReturnType<typeof Fastify>;
  let owner: Address, mintA: Address, mintB: Address, notMint: Address, broken: Address;

  beforeAll(async () => {
    [owner, mintA, mintB, notMint, broken] = await Promise.all(Array.from({ length: 5 }, async () => (await generateKeyPairSigner()).address));
    accounts.set(mintA, mintAccount(6));
    accounts.set(mintB, mintAccount(9));
    accounts.set(notMint, { data: new Uint8Array(10), owner: TOKEN_PROGRAM });
    accounts.set(await ata(owner, mintA, TOKEN_PROGRAM), tokenAccount(owner, mintA, 2_500_000n));
    app = Fastify();
    app.setErrorHandler((err, _req, reply) => {
      if (err instanceof RequestError) return reply.code(err.status).send({ error: err.message });
      return reply.code(500).send({ error: String(err) });
    });
    registerHolderBalances(app, {
      account: async (a) => {
        if (a === broken) throw new Error('RPC kept answering 429');
        return accounts.get(a) ?? null;
      },
      lamports: async (a) => {
        if (a === owner) return 1_234_567n;
        throw new Error('down');
      },
    });
    await app.ready();
  });

  it('reads balances from the associated token accounts, zero where the wallet has none', async () => {
    const r = (await app.inject(`/v1/balances/${owner}?mints=${mintA},${mintB}`)).json();
    expect(r.balances).toEqual([
      { mint: mintA, status: 'ok', amount: '2500000', decimals: 6, tokenProgram: TOKEN_PROGRAM },
      { mint: mintB, status: 'ok', amount: '0', decimals: 9, tokenProgram: TOKEN_PROGRAM },
    ]);
  });

  it('says what it could not read instead of reporting zero', async () => {
    const r = (await app.inject(`/v1/balances/${owner}?mints=${notMint},${broken}`)).json();
    expect(r.balances[0]).toEqual({ mint: notMint, status: 'not-a-mint' });
    expect(r.balances[1]).toMatchObject({ mint: broken, status: 'unavailable' });
    expect(r.balances[1].reason).toContain('429');
  });

  it('adds the SOL balance on request, and marks it unavailable when the cluster is down', async () => {
    expect((await app.inject(`/v1/balances/${owner}?sol=1`)).json().sol).toEqual({ status: 'ok', lamports: '1234567' });
    const other = (await generateKeyPairSigner()).address;
    expect((await app.inject(`/v1/balances/${other}?sol=1`)).json().sol).toEqual({ status: 'unavailable' });
  });

  it('refuses junk: a bad owner, a bad mint, nothing asked for, too many mints', async () => {
    expect((await app.inject('/v1/balances/nope?sol=1')).statusCode).toBe(400);
    expect((await app.inject(`/v1/balances/${owner}?mints=nope`)).statusCode).toBe(400);
    expect((await app.inject(`/v1/balances/${owner}`)).statusCode).toBe(400);
    const many = Array.from({ length: MAX_MINTS + 1 }, () => mintA).join(',');
    expect((await app.inject(`/v1/balances/${owner}?mints=${many}`)).statusCode).toBe(400);
  });
});
