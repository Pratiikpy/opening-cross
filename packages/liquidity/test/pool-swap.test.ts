// The swap instructions for Meteora pools (ADR-0923), checked against the IDLs the programs publish and against two swaps that really landed on
// devnet: the DAMM v2 swap of docs/evidence/A2-damm-v2-devnet.md (step swap-near-pstar) and the DLMM swap of A3-dlmm-devnet.md. The values in REAL are
// read from those transactions on chain, not computed here.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AccountRole, type Address } from '@solana/kit';
import { DAMM_V2_PROGRAM, DLMM_PROGRAM, MEMO_PROGRAM, buildDammSwap, buildDlmmSwap, dammPoolAuthority, dlmmBinArrayAddress, eventAuthority, minimumOut } from '../src/index.js';

type IdlAccount = { name: string; writable?: boolean; signer?: boolean; optional?: boolean };
const idl = (file: string) => JSON.parse(readFileSync(new URL(`../../../idls/${file}`, import.meta.url), 'utf8')) as { instructions: { name: string; discriminator: number[]; accounts: IdlAccount[] }[] };

const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb' as Address;
const REAL = {
  damm: {
    pool: '5fDuBQZnim5qF8gJHQebPfqS1eLSEhHxo6hurXsmP8AU',
    poolAuthority: 'HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC',
    eventAuthority: '3rmHSu74h1ZcmAisVcWerTCiRDQbUrBKmcwptYGjHfet',
    tokenAVault: 'FGwgPPbJgnBJYNWsrH43KmPbuay1B6KwTtUdFVY5Rq3c',
    tokenBVault: 'FAqAB7XjciwjpkDevQEgi8G74eJHtfraQyemDv9bBtFi',
    tokenAMint: 'EkisVxYv7x5pJfXUM75WiQC9AgYKy2ps5R3pyTEeovCV',
    tokenBMint: '7BavPghywmfMMvt7VctXpFvqKCB8kwnXDyA2iZUQzidy',
  },
  dlmm: {
    pair: '9zCyWgZoDLutMeci2ntdfsYR4Dnu4TXi81RivPBY4125',
    reserveX: '6LyAqFk9J91ff4haV7bJ8m9szuG3eJq6aFCWtKhHVt1o',
    reserveY: '4YbCMBstoZ2JQbvtahAMvF5t844hFmCwH3heLmYEU3ET',
    mintX: 'AypfHSmpMQ2C1zaGRHRyoYbQBjFA8Wphc7AQrkmCLZXN',
    mintY: 'HRYt8BVWnDkBNXJQ8CUpAkVEaQUgFeUAshGCRAk8JEGN',
    oracle: '6KUjUeH9u4v8khGUubWVWEnYA7j56V9gu1iYh8zpa1EB',
    eventAuthority: 'D1ZN9Wj1fRSUQfCjhvnu1hqDMT7hzjzBBpi12nVniYD6',
    trader: 'BfrnK5gPk8ce9umsehWEiWmiKCAVVkT61J7kcUzQaPoB',
    inputAccount: '9EMD9eFGuo3qgnhdWUPsuw8ZddBv8VkBqH9HmKqmHH2G',
    outputAccount: '3BnJJdcGLrWSv9TLAjM3zx83Hp685MMQYifmppJXPrxF',
    binArray3: 'WWDM6AdbPGZZTzuFnN54R1jbiTRz56b8gnKt9xMMQMN',
    /** The instruction data of the swap: swap2, amount_in 5,000,000, minimum_amount_out 0, no remaining-accounts slices. */
    swapData: '414b3f4ceb5b5b88404b4c0000000000000000000000000000000000',
    /** Every account of that instruction, in order. */
    swapAccounts: [
      '9zCyWgZoDLutMeci2ntdfsYR4Dnu4TXi81RivPBY4125', 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo', '6LyAqFk9J91ff4haV7bJ8m9szuG3eJq6aFCWtKhHVt1o', '4YbCMBstoZ2JQbvtahAMvF5t844hFmCwH3heLmYEU3ET',
      '9EMD9eFGuo3qgnhdWUPsuw8ZddBv8VkBqH9HmKqmHH2G', '3BnJJdcGLrWSv9TLAjM3zx83Hp685MMQYifmppJXPrxF', 'AypfHSmpMQ2C1zaGRHRyoYbQBjFA8Wphc7AQrkmCLZXN', 'HRYt8BVWnDkBNXJQ8CUpAkVEaQUgFeUAshGCRAk8JEGN',
      '6KUjUeH9u4v8khGUubWVWEnYA7j56V9gu1iYh8zpa1EB', 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo', 'BfrnK5gPk8ce9umsehWEiWmiKCAVVkT61J7kcUzQaPoB', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
      'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr', 'D1ZN9Wj1fRSUQfCjhvnu1hqDMT7hzjzBBpi12nVniYD6', 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo', 'WWDM6AdbPGZZTzuFnN54R1jbiTRz56b8gnKt9xMMQMN',
    ],
  },
} as const;
const A = (n: number) => `${String.fromCharCode(65 + n)}${'1'.repeat(43)}` as Address;
// An optional account the IDL marks writable is passed as the program's own address when absent, and a program is never writable in a transaction.
const roleOf = (writable: boolean | undefined, signer: boolean | undefined, optional?: boolean) => (optional ? AccountRole.READONLY : signer ? (writable ? AccountRole.WRITABLE_SIGNER : AccountRole.READONLY_SIGNER) : writable ? AccountRole.WRITABLE : AccountRole.READONLY);

describe('DAMM v2 swap2', () => {
  const input = () => ({
    pool: REAL.damm.pool as Address,
    tokenAMint: REAL.damm.tokenAMint as Address,
    tokenBMint: REAL.damm.tokenBMint as Address,
    tokenAVault: REAL.damm.tokenAVault as Address,
    tokenBVault: REAL.damm.tokenBVault as Address,
    tokenAProgram: TOKEN_2022,
    tokenBProgram: TOKEN_2022,
    trader: A(1),
    inputAccount: A(2),
    outputAccount: A(3),
    amountIn: 5_000_000n,
    minimumAmountOut: 6_000_000n,
  });
  const swap2 = () => idl('cp_amm.json').instructions.find((i) => i.name === 'swap2')!;

  it('has the discriminator, account order and writability the IDL declares', async () => {
    const ix = await buildDammSwap(input());
    expect(ix.programAddress).toBe(DAMM_V2_PROGRAM);
    expect([...ix.data!.subarray(0, 8)]).toEqual(swap2().discriminator);
    expect(ix.accounts!.map((a) => a.role)).toEqual(swap2().accounts.map((a) => roleOf(a.writable, a.signer, a.optional)));
    expect(ix.accounts).toHaveLength(swap2().accounts.length);
  });

  it('carries amount_in, minimum_amount_out and swap mode ExactIn, little-endian', async () => {
    const d = Buffer.from((await buildDammSwap(input())).data!);
    expect(d).toHaveLength(8 + 8 + 8 + 1);
    expect(d.readBigUInt64LE(8)).toBe(5_000_000n);
    expect(d.readBigUInt64LE(16)).toBe(6_000_000n);
    expect(d[24]).toBe(0);
  });

  it('names the pool authority and event authority the real swap passed', async () => {
    expect(await dammPoolAuthority()).toBe(REAL.damm.poolAuthority);
    expect(await eventAuthority(DAMM_V2_PROGRAM)).toBe(REAL.damm.eventAuthority);
    const ix = await buildDammSwap(input());
    const names = swap2().accounts.map((x) => x.name);
    expect(ix.accounts![names.indexOf('pool_authority')]!.address).toBe(REAL.damm.poolAuthority);
    expect(ix.accounts![names.indexOf('event_authority')]!.address).toBe(REAL.damm.eventAuthority);
    expect(ix.accounts![names.indexOf('token_a_vault')]!.address).toBe(REAL.damm.tokenAVault);
    expect(ix.accounts![names.indexOf('payer')]!.address).toBe(A(1));
    // no referral: the optional account is the program's own address, as in the real swap
    expect(ix.accounts![names.indexOf('referral_token_account')]!.address).toBe(DAMM_V2_PROGRAM);
  });

  it('refuses an amount outside u64', async () => {
    await expect(buildDammSwap({ ...input(), amountIn: 1n << 64n })).rejects.toThrow(/u64/);
  });
});

describe('DLMM swap2', () => {
  const d = REAL.dlmm;
  const base = {
    lbPair: d.pair as Address,
    reserveX: d.reserveX as Address,
    reserveY: d.reserveY as Address,
    tokenXMint: d.mintX as Address,
    tokenYMint: d.mintY as Address,
    tokenXProgram: TOKEN_2022,
    tokenYProgram: TOKEN_2022,
    oracle: d.oracle as Address,
    trader: d.trader as Address,
    inputAccount: d.inputAccount as Address,
    outputAccount: d.outputAccount as Address,
    amountIn: 5_000_000n,
    minimumAmountOut: 0n,
    binArrays: [3],
  };
  const swap2 = () => idl('lb_clmm.json').instructions.find((i) => i.name === 'swap2')!;

  it('is byte for byte the instruction the real devnet swap sent: same data, same accounts in the same order', async () => {
    const ix = await buildDlmmSwap(base);
    expect(Buffer.from(ix.data!).toString('hex')).toBe(d.swapData);
    expect(ix.accounts!.map((a) => a.address)).toEqual([...d.swapAccounts]);
  });

  it('has the discriminator, account order and writability the IDL declares, then the bin arrays as writable remaining accounts', async () => {
    const ix = await buildDlmmSwap({ ...base, binArrays: [3, 4] });
    const fixed = swap2().accounts.length;
    expect(ix.programAddress).toBe(DLMM_PROGRAM);
    expect([...ix.data!.subarray(0, 8)]).toEqual(swap2().discriminator);
    expect(ix.accounts!.slice(0, fixed).map((a) => a.role)).toEqual(swap2().accounts.map((a) => roleOf(a.writable, a.signer, a.optional)));
    expect(ix.accounts!.slice(fixed).every((a) => a.role === AccountRole.WRITABLE)).toBe(true);
    expect(ix.accounts).toHaveLength(fixed + 2);
    expect(ix.accounts![swap2().accounts.findIndex((a) => a.name === 'memo_program')]!.address).toBe(MEMO_PROGRAM);
  });

  it('encodes any amounts little-endian after the discriminator, then an empty RemainingAccountsInfo', async () => {
    const data = Buffer.from((await buildDlmmSwap({ ...base, amountIn: 100_000_000n, minimumAmountOut: 90_000_000n })).data!);
    expect(data).toHaveLength(8 + 8 + 8 + 4);
    expect(data.readBigUInt64LE(8)).toBe(100_000_000n);
    expect(data.readBigUInt64LE(16)).toBe(90_000_000n);
    expect(data.readUInt32LE(24)).toBe(0);
  });

  it('derives the address of a bin array that exists on chain, and the event authority the real swap named', async () => {
    expect(await dlmmBinArrayAddress(d.pair as Address, 3)).toBe(d.binArray3);
    expect(await eventAuthority(DLMM_PROGRAM)).toBe(d.eventAuthority);
    // negative indexes use the two's-complement i64 the program seeds with
    expect(await dlmmBinArrayAddress(d.pair as Address, -1)).not.toBe(await dlmmBinArrayAddress(d.pair as Address, 1));
  });

  it('names the optional accounts as the program itself, never a made-up address', async () => {
    const ix = await buildDlmmSwap(base);
    const names = swap2().accounts.map((a) => a.name);
    expect(ix.accounts![names.indexOf('bin_array_bitmap_extension')]!.address).toBe(DLMM_PROGRAM);
    expect(ix.accounts![names.indexOf('host_fee_in')]!.address).toBe(DLMM_PROGRAM);
  });

  it('refuses a swap with no bin arrays, and a bin array the pair’s own bitmap cannot hold', async () => {
    await expect(buildDlmmSwap({ ...base, binArrays: [] })).rejects.toThrow(/at least one bin array/);
    await expect(buildDlmmSwap({ ...base, binArrays: [600] })).rejects.toThrow(/bitmap extension/);
    await expect(buildDlmmSwap({ ...base, binArrays: [-513] })).rejects.toThrow(/bitmap extension/);
  });
});

describe('minimumOut', () => {
  it('is the quoted output less the tolerance, rounded up', () => {
    expect(minimumOut(1_000_000n, 50)).toBe(995_000n);
    // 1,000 less 1 bp is 999.9: the smallest whole amount that does not exceed the tolerance is 1,000
    expect(minimumOut(1_000n, 1)).toBe(1_000n);
    expect(minimumOut(7n, 0)).toBe(7n);
    expect(minimumOut(7n, 10_000)).toBe(0n);
  });
  it('refuses a tolerance that is not whole basis points from 0 to 10,000', () => {
    expect(() => minimumOut(1n, -1)).toThrow();
    expect(() => minimumOut(1n, 10_001)).toThrow();
    expect(() => minimumOut(1n, 0.5)).toThrow();
  });
});
