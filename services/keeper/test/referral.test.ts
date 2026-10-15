// A cross that names a referrer pays it at finalize (ADR-0460), and `finalize` refuses to run unless the referrer's quote token account exists. Anyone may open it first;
// the SDK's `buildFinalizeWithAccounts` does, which the keeper sends, so a referrer who has never held the quote mint cannot leave a cross unfinalized. The in-memory chain
// refuses finalize the way the program does.
import { describe, expect, it } from 'vitest';
import { type Instruction } from '@solana/kit';
import { CrossState, FINALIZE_DISCRIMINATOR, getCrossDecoder, readCrossExt } from '@opening-cross/cross-core-client';
import { ASSOCIATED_TOKEN_PROGRAM, ata, buildFinalize, buildFinalizeWithAccounts } from '@opening-cross/sdk';
import { runOnce } from '../src/index.js';
import { referralOwed } from '../src/referral.js';
import { World, key } from './helpers/world.js';

const startsWith = (ix: Instruction, d: ArrayLike<number>) => Array.from(d).every((b, i) => ix.data![i] === b);
// The figures of the real program's run (tests/core/test/rules-safety.test.ts): 100,000,000 raised, integrator 200 bps, protocol 30 bps, 10% of the protocol fee to the referrer.
const FEES = { protocolBps: 30, integratorBps: 200, buyerPaid: 100_000_000n };

async function referred(w: World, shareBps: number, over: { fees?: Parameters<World['cross']>[0] extends infer O ? NonNullable<O extends { fees?: infer F } ? F : never> : never } = {}) {
  const referrer = await key();
  const cross = await w.cross({ state: CrossState.Cleared, rules: { referral: { referrer, shareBps } }, fees: over.fees ?? FEES });
  return { cross, referrer };
}

describe('referralOwed: what finalize would pay the referrer', () => {
  it('is 30,000 on the program\'s own figures: 300,000 of protocol fee, 10% of it', async () => {
    const w = await World.create();
    const { cross } = await referred(w, 1_000);
    const raw = w.get(cross);
    expect(referralOwed(getCrossDecoder().decode(raw), readCrossExt(raw))).toBe(30_000n);
  });

  it('follows the supply mode: an escrow cross splits what its sellers were charged', async () => {
    const w = await World.create();
    const { cross } = await referred(w, 5_000, { fees: { protocolBps: 30, integratorBps: 200, feesAccrued: 2_300_000n, escrow: true } });
    const raw = w.get(cross);
    // 2,300,000 of fees: protocol 300,000, half of it to the referrer.
    expect(referralOwed(getCrossDecoder().decode(raw), readCrossExt(raw))).toBe(150_000n);
  });

  it('is nothing for a cross with no referrer, a zero share, no fee, or a share that rounds to nothing', async () => {
    const w = await World.create();
    const none = await w.cross({ state: CrossState.Cleared, rules: {}, fees: FEES });
    const legacy = await w.cross({ state: CrossState.Cleared, rules: null, fees: FEES });
    const free = await referred(w, 1_000, { fees: { protocolBps: 0, integratorBps: 0, buyerPaid: 100_000_000n } });
    const dust = await referred(w, 1, { fees: { protocolBps: 30, integratorBps: 200, buyerPaid: 1_000n } });
    for (const c of [none, legacy, free.cross, dust.cross]) {
      const raw = w.get(c);
      expect(referralOwed(getCrossDecoder().decode(raw), readCrossExt(raw))).toBe(0n);
    }
  });
});

describe('the keeper finalizes a cross that names a referrer', () => {
  it('a bare finalize is refused when the referrer has no quote account (the model of the program), and the SDK builder opens it', async () => {
    const w = await World.create();
    const { cross } = await referred(w, 1_000);
    const raw = w.get(cross);
    const view = { address: cross, data: getCrossDecoder().decode(raw), ext: readCrossExt(raw) };
    await expect(w.deps().send([await buildFinalize(view, w.payer)])).rejects.toThrow('ReferralAccountMissing');
    await w.deps().send(await buildFinalizeWithAccounts(view, w.payer));
    expect(getCrossDecoder().decode(w.get(cross)).state).toBe(CrossState.Finalized);
  });

  it('opens the referrer\'s quote account in the same transaction, then finalizes; a second pass has nothing to do', async () => {
    const w = await World.create();
    const { cross, referrer } = await referred(w, 1_000);
    const r = await runOnce(w.deps({ duties: 'none' }));
    expect(r.failed).toEqual([]);
    expect(r.done.map((d) => d.action.kind)).toEqual(['finalize']);
    expect(getCrossDecoder().decode(w.get(cross)).state).toBe(CrossState.Finalized);

    const want = await ata(referrer, w.quote, getCrossDecoder().decode(w.get(cross)).quoteTokenProgram);
    const tx = w.sent.at(-1)!;
    const at = tx.findIndex((ix) => ix.programAddress === ASSOCIATED_TOKEN_PROGRAM && ix.accounts![1]!.address === want);
    expect(at).toBeGreaterThanOrEqual(0);
    // The account is created before finalize runs, and finalize is the last instruction and names it.
    expect(startsWith(tx.at(-1)!, FINALIZE_DISCRIMINATOR)).toBe(true);
    expect(at).toBeLessThan(tx.length - 1);
    expect(tx.at(-1)!.accounts!.map((a) => a.address)).toContain(want);
    expect(w.accounts.has(want)).toBe(true);

    const before = w.sent.length;
    expect((await runOnce(w.deps({ duties: 'none' }))).done).toEqual([]);
    expect(w.sent.length).toBe(before);
  });

  it('is not a failure when the referrer already holds the account (the creation is idempotent)', async () => {
    const w = await World.create();
    const { cross, referrer } = await referred(w, 2_500);
    w.accounts.set(await ata(referrer, w.quote, getCrossDecoder().decode(w.get(cross)).quoteTokenProgram), new Uint8Array(165));
    const r = await runOnce(w.deps({ duties: 'none' }));
    expect(r.failed).toEqual([]);
    expect(getCrossDecoder().decode(w.get(cross)).state).toBe(CrossState.Finalized);
  });

  it('opens the account of the referrer for any referral, and adds nothing for a cross with no referral or of the earlier layout', async () => {
    const w = await World.create();
    const plain = await w.cross({ state: CrossState.Cleared, rules: {}, fees: FEES });
    const dust = (await referred(w, 1, { fees: { protocolBps: 30, integratorBps: 200, buyerPaid: 1_000n } })).cross;
    const legacy = await w.cross({ state: CrossState.Cleared, rules: null });
    const r = await runOnce(w.deps({ duties: 'none' }));
    expect(r.failed).toEqual([]);
    for (const c of [plain, dust, legacy]) expect(getCrossDecoder().decode(w.get(c)).state).toBe(CrossState.Finalized);
    // Three finalize transactions. The two minting crosses differ by the referrer's account: the SDK opens it whenever the rules name a referrer, also for a share that
    // rounds to nothing (it is idempotent, and the builder does not read the fees). The earlier-layout cross is an escrow cross and opens a base account as well, so it is not compared.
    const finalizes = w.sent.filter((tx) => startsWith(tx.at(-1)!, FINALIZE_DISCRIMINATOR));
    expect(finalizes).toHaveLength(3);
    expect(finalizes[1]!.length).toBe(finalizes[0]!.length + 1);
  });

  it('finalizes every referred cross of a pass, one referrer account opened once however many crosses name the referrer', async () => {
    const w = await World.create();
    const referrer = await key();
    const crosses = [] as Awaited<ReturnType<World['cross']>>[];
    for (let i = 0; i < 3; i++) crosses.push(await w.cross({ state: CrossState.Cleared, rules: { referral: { referrer, shareBps: 1_000 } }, fees: FEES }));
    const r = await runOnce(w.deps({ duties: 'none' }));
    expect(r.failed).toEqual([]);
    expect(r.done.filter((d) => d.action.kind === 'finalize')).toHaveLength(3);
    const want = await ata(referrer, w.quote, getCrossDecoder().decode(w.get(crosses[0]!)).quoteTokenProgram);
    expect([...w.accounts.keys()].filter((k) => k === want)).toHaveLength(1);
  });
});
