// The treasury extension tail (ADR-0470): a treasury written by the deployed first release keeps working
// after the upgrade, and the extension is added to it in place.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { TreasuryState, TREASURY_EXT_OFFSET, flagshipExtParams, getInitExtInstructionAsync, getTreasuryExtDecoder } from '@opening-cross/treasury-client';
import { T0 } from '../src/harness.js';
import { DAY, TP, TREASURY_SO, TREASURY_V1_SO, ZERO, treasuryWorld } from '../src/treasury-world.js';

const haveBinaries = existsSync(TREASURY_SO);
const haveBaseline = existsSync(TREASURY_V1_SO);
// The binary deployed on devnet before the extension (docs/evidence/L4-verifiable-build.md section 3).
const V1_SHA256 = 'ce6b2b6174622a77d3767f8e5fe5542b1fac537e944cd169e53155a7317cee2c';

describe.skipIf(!haveBinaries)('treasury extension tail', () => {
  it('the tail decoder reads exactly the bytes the program writes', async () => {
    const t = await treasuryWorld({ extend: true });
    const raw = t.raw();
    const e = t.extState();
    expect(e).not.toBeNull();
    // The program's tail is `Ext::INIT_SPACE` bytes after the first release's prefix, no more, no less.
    expect(raw.length).toBe(TREASURY_EXT_OFFSET + getTreasuryExtDecoder().fixedSize);
    expect(getTreasuryExtDecoder().decode(raw.subarray(TREASURY_EXT_OFFSET)).magic).toEqual(new Uint8Array([0x54, 0x45, 0x58, 0x31]));
    expect(e?.votePeriodSecs).toBe(3n * DAY);
    expect(e?.quorumBps).toBe(2_000);
    expect(e?.insiders[0]).toBe(t.team.address);
    expect(e?.insiders[1]).toBe(ZERO);
    expect(e?.proposalCount).toBe(0n);
    expect(e?.navOpen).toBe(false);
    // The extension created both vaults, owned by the treasury, empty.
    expect(t.vaults()).toEqual({ vault: 10_000_000_000n, dist: 0n, coins: 0n });
  });

  it('a treasury that was never extended refuses every extension instruction cleanly', async () => {
    const t = await treasuryWorld();
    expect(t.extState()).toBeNull();
    expect(t.raw().length).toBe(TREASURY_EXT_OFFSET);
    const log = await t.h.fail([await t.b.postDisclosure(t.team, new Uint8Array(32))], t.team);
    expect(log).toContain('NotExtended');
    const log2 = await t.h.fail([await t.b.recordAssignment(t.credential)], t.team);
    expect(log2).toMatch(/NotExtended|WrongAttestationAccount|AccountNotInitialized|ConstraintSeeds|AccountNotEnoughKeys/);
  });

  it('only the treasury authority extends, once, and unsafe parameters are refused', async () => {
    const t = await treasuryWorld();
    expect(await t.h.fail([await t.initExt({}, t.alice)], t.alice)).toMatch(/Unauthorized|ConstraintHasOne|ConstraintSeeds/);
    const bad: [string, Parameters<typeof t.initExt>[0]][] = [
      ['quorum below the floor', { quorumBps: 999 }],
      ['quorum above 100%', { quorumBps: 10_001 }],
      ['threshold at or below a bare majority', { thresholdBps: 4_999 }],
      ['threshold at 100%', { thresholdBps: 10_000 }],
      ['vote shorter than three days', { votePeriodSecs: 3n * DAY - 1n }],
      ['timelock shorter than a day', { timelockSecs: DAY - 1n }],
      ['a proposal may not move more than the vault', { maxProposalBps: 10_001 }],
      ['no proposal may move anything', { maxProposalBps: 0 }],
      ['sweep window under six months', { windowSecs: 180n * DAY - 1n }],
      ['sweep window with no recovery account', { recovery: ZERO }],
      ['NAV cap of zero', { navCapBps: 0 }],
      ['revenue share above 100%', { revShareBps: 10_001 }],
      ['revenue rounds of zero length', { roundSecs: 0n }],
      ['tranche without revenue rounds', { revShareBps: 0, trancheAmount: 1n }],
      ['disclosure period under a day', { disclosurePeriodSecs: DAY - 1n }],
      ['revenue rounds that start in the past', { revStart: T0 - 1n }],
    ];
    for (const [name, o] of bad) {
      const log = await t.h.fail([await t.initExt(o)], t.team);
      expect(log, name).toContain('InvalidParams');
    }
    expect(t.extState()).toBeNull(); // nothing was half-written
    await t.h.send([await t.initExt()], t.team);
    const again = await t.h.fail([await t.initExt()], t.team);
    expect(again).toMatch(/AlreadyExtended|already in use/);
  });

  it('the allowance spend keeps working on an extended treasury and does not disturb the tail', async () => {
    const t = await treasuryWorld({ extend: true, ext: { disclosurePeriodSecs: 0n } });
    const att = await t.attest(t.treasury, new Uint8Array([1]), T0 + 40n * DAY);
    const before = t.extState();
    await t.h.send([await t.b.spend(t.team, 600_000_000n, att)], t.team);
    expect(await t.quoteBal(t.team)).toBe(600_000_000n);
    expect(t.extState()).toEqual(before); // the prefix was rewritten, the tail was not
    expect(t.state().spentInPeriod).toBe(600_000_000n);
  });
});

describe.skipIf(!haveBinaries)('flagship preset', () => {
  it('is accepted by the program as written, and enables every protection', async () => {
    const t = await treasuryWorld();
    const params = flagshipExtParams({
      revenueCredential: t.credential, revenueSchema: t.revSchema, assignmentCredential: t.credential, assignmentSchema: t.assignSchema,
      revenueShareBps: 1_000, revenueStart: T0, recovery: t.recovery.address, insiders: [t.alice.address],
    });
    await t.h.send([await getInitExtInstructionAsync({ authority: t.team, treasury: t.treasury, coinMint: t.coin, quoteMint: t.quote, coinTokenProgram: TP, quoteTokenProgram: TP, ...params })], t.team);
    const e = t.extState()!;
    expect([e.assignRequired, e.windowSecs, e.minLockupSecs, e.disclosurePeriodSecs]).toEqual([true, 365n * DAY, 365n * DAY, 35n * DAY]);
    expect(e.insiders[0]).toBe(t.alice.address);
  });
});

describe.skipIf(!haveBinaries || !haveBaseline)('upgrade from the deployed first release', () => {
  it('the baseline fixture is the binary that is on devnet', () => {
    expect(createHash('sha256').update(readFileSync(TREASURY_V1_SO)).digest('hex')).toBe(V1_SHA256);
  });

  it('a treasury created and operated by the old binary keeps working under the new one, then extends in place', async () => {
    const t = await treasuryWorld({ baseline: true });
    const att = await t.attest(t.treasury, new Uint8Array([1]), T0 + 10n * DAY);
    // Old binary: spend within the allowance.
    await t.h.send([await t.b.spend(t.team, 400_000_000n, att)], t.team);
    // The old binary has no extension instructions: its account is the 237-byte prefix.
    expect(t.raw().length).toBe(TREASURY_EXT_OFFSET);

    // Upgrade: same program id, new bytes.
    t.withProgram(TREASURY_SO);
    expect(t.state().spentInPeriod).toBe(400_000_000n);
    await t.h.send([await t.b.spend(t.team, 600_000_000n, att)], t.team); // old account, new code
    expect(await t.quoteBal(t.team)).toBe(1_000_000_000n);
    expect(await t.h.fail([await t.b.spend(t.team, 1n, att)], t.team)).toContain('OverAllowance');
    // New instructions refuse the un-extended account until the team extends it.
    expect(await t.h.fail([await t.b.postDisclosure(t.team, new Uint8Array(32))], t.team)).toContain('NotExtended');

    // Extend the old account in place, then keep going: lapse, liquidation, redemption.
    const prior = t.state();
    await t.h.send([await t.initExt()], t.team);
    const after = t.state();
    expect(after).toEqual(prior);
    expect(t.extState()).not.toBeNull();

    t.h.setTime(T0 + 10n * DAY); // the attestation expires
    await t.h.send([t.b.lapse(att)], t.alice);
    t.h.setTime(T0 + 17n * DAY);
    await t.h.send([t.b.liquidate()], t.alice);
    const st = t.state();
    expect(st.state).toBe(TreasuryState.Liquidating);
    expect([st.snapshotVault, st.snapshotSupply]).toEqual([9_000_000_000n, 1_000_000_000n]); // 10,000 less the 1,000 spent
    expect(t.extState()?.windStart).toBe(T0 + 17n * DAY);
    await t.h.send([await t.b.redeem(t.alice, 400_000_000n)], t.alice);
    expect(await t.quoteBal(t.alice)).toBe(3_600_000_000n);
  });

  it('a treasury the old binary put into liquidation can still be redeemed under the new one', async () => {
    const t = await treasuryWorld({ baseline: true });
    const att = await t.attest(t.treasury, new Uint8Array([1]), T0 + 10n * DAY);
    t.h.setTime(T0 + 10n * DAY);
    await t.h.send([t.b.lapse(att)], t.alice);
    t.h.setTime(T0 + 17n * DAY);
    await t.h.send([t.b.liquidate()], t.alice); // old binary
    t.withProgram(TREASURY_SO);
    await t.h.send([await t.b.redeem(t.bob, 300_000_000n)], t.bob); // new binary, never extended
    expect(await t.quoteBal(t.bob)).toBe(3_000_000_000n);
  });
});
