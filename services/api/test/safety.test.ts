// Mint safety service: caching, retry on rate limits, error typing, and the block / warn split.
// Pure: accounts are encoded in memory, no network and no database.
import { describe, expect, it, vi } from 'vitest';
import { type Address, some } from '@solana/kit';
import { createSafety, gate, isTransient } from '../src/safety.js';
import { RequestError } from '../src/tx.js';
import { mintAccount } from './helpers/mint.js';

const MINT = 'So11111111111111111111111111111111111111112' as Address;
const ISSUER = 'DTB3Jtxb6dy7GvocUbypiJb548ZLGRzVdPrNNCWAKEdC' as Address;
const SPL = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' as Address;

const rateLimited = () => Object.assign(new Error('HTTP error (429): Too Many Requests'), { context: { statusCode: 429 } });

describe('createSafety', () => {
  it('reads once and reuses the verdict until the ttl passes', async () => {
    let t = 1_000_000;
    const account = vi.fn(async () => mintAccount(null, { freeze: true }));
    const s = createSafety({ account, now: () => t, ttlMs: 30_000 });
    const a = await s.get(MINT);
    expect(a.verdict).toBe('disclosures');
    expect(a.risks.map((r) => r.code)).toEqual(['FREEZE_AUTHORITY']);
    await s.get(MINT);
    expect(account).toHaveBeenCalledTimes(1);
    t += 30_001;
    await s.get(MINT);
    expect(account).toHaveBeenCalledTimes(2);
  });

  it('concurrent callers share one read', async () => {
    const account = vi.fn(async () => mintAccount(null));
    const s = createSafety({ account });
    await Promise.all([s.get(MINT), s.get(MINT), s.get(MINT)]);
    expect(account).toHaveBeenCalledTimes(1);
  });

  it('retries a 429 with growing waits and then succeeds', async () => {
    const waits: number[] = [];
    let n = 0;
    const account = vi.fn(async () => {
      if (++n < 3) throw rateLimited();
      return mintAccount(null);
    });
    const s = createSafety({ account, sleep: async (ms) => void waits.push(ms) });
    expect((await s.get(MINT)).verdict).toBe('clear');
    expect(account).toHaveBeenCalledTimes(3);
    expect(waits).toEqual([250, 500]);
  });

  it('gives up after the configured attempts and does not cache the failure', async () => {
    const account = vi.fn(async (): Promise<never> => {
      throw rateLimited();
    });
    const s = createSafety({ account, attempts: 3, sleep: async () => {} });
    await expect(s.get(MINT)).rejects.toThrow(/429/);
    expect(account).toHaveBeenCalledTimes(3);
    account.mockImplementation(async () => mintAccount(null) as never);
    expect((await s.get(MINT)).verdict).toBe('clear');
  });

  it('does not retry an error that is not transient', async () => {
    const account = vi.fn(async (): Promise<never> => {
      throw new Error('account data too short');
    });
    const s = createSafety({ account, sleep: async () => {} });
    await expect(s.get(MINT)).rejects.toThrow(/too short/);
    expect(account).toHaveBeenCalledTimes(1);
  });

  it('404 for a mint that does not exist', async () => {
    const s = createSafety({ account: async () => null });
    await expect(s.get(MINT)).rejects.toMatchObject({ status: 404 });
  });

  it('422 for an account another program owns, and for bytes that are not a mint', async () => {
    const foreign = createSafety({ account: async () => ({ ...mintAccount(null), owner: ISSUER }) });
    await expect(foreign.get(MINT)).rejects.toMatchObject({ status: 422 });
    const junk = createSafety({ account: async () => ({ data: new Uint8Array(5), owner: SPL }) });
    await expect(junk.get(MINT)).rejects.toBeInstanceOf(RequestError);
    await expect(junk.get(MINT)).rejects.toMatchObject({ status: 422 });
  });

  it('a paused mint is halted and not crossable, with the issuer named', async () => {
    const s = createSafety({ account: async () => mintAccount([{ __kind: 'PausableConfig', authority: some(ISSUER), paused: true }]) });
    const v = await s.get(MINT);
    expect(v.verdict).toBe('halted');
    expect(v.crossable).toBe(false);
    expect(v.risks[0]).toMatchObject({ code: 'MINT_PAUSED', severity: 'halt', level: 'halt', holder: ISSUER });
    expect(v.summary).toMatch(/none can print/);
  });

  it('blockers are split from warnings by the package policy', async () => {
    const s = createSafety({
      account: async () =>
        mintAccount(
          [
            { __kind: 'TransferHook', authority: ISSUER, programId: ISSUER },
            { __kind: 'PausableConfig', authority: some(ISSUER), paused: true },
            { __kind: 'PermanentDelegate', delegate: ISSUER },
          ],
          { freeze: true },
        ),
    });
    const v = await s.get(MINT);
    expect(v.verdict).toBe('blocked');
    expect(v.risks.map((r) => r.level)).toEqual(['blocker', 'halt', 'disclosure', 'disclosure']);
    const g = gate(v);
    expect(g.blockers.map((r) => r.code)).toEqual(['TRANSFER_HOOK']);
    expect(g.warnings.map((r) => r.code).sort()).toEqual(['FREEZE_AUTHORITY', 'MINT_PAUSED', 'PERMANENT_DELEGATE']);
  });

  it('a clean mint has no risks', async () => {
    const v = await createSafety({ account: async () => mintAccount(null, { decimals: 9 }) }).get(MINT);
    expect(v).toMatchObject({ verdict: 'clear', crossable: true, decimals: 9, risks: [], uiMultiplier: 1 });
  });
});

describe('isTransient', () => {
  it('recognises rate limits and dropped connections only', () => {
    expect(isTransient(rateLimited())).toBe(true);
    expect(isTransient(new Error('fetch failed'))).toBe(true);
    expect(isTransient(new Error('ECONNRESET'))).toBe(true);
    expect(isTransient(new Error('Invalid param: could not find account'))).toBe(false);
  });
});
