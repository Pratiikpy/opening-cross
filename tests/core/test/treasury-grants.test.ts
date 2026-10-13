// Milestone team tokens with a minimum lockup, earn-out and carve-out terms (E4, A6), the disclosure
// feed (E5) and the IP and asset assignment gate (E6): ADR-0473 and ADR-0475.
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { T0 } from '../src/harness.js';
import { DAY, TREASURY_SO, type TW, milestoneNonce, treasuryWorld } from '../src/treasury-world.js';

const COIN = 1_000_000n;
const have = existsSync(TREASURY_SO);

async function coinsHeld(t: TW) {
  const e = t.extState()!;
  expect(t.h.balance(t.coinVault)).toBe(e.votesLocked + e.totalStaked + e.grantsUnreleased);
  return e;
}

describe.skipIf(!have)('team grants with milestones, lockup, earn-out and carve-out (E4, A6)', () => {
  const grant = (t: TW, o: Partial<{ total: bigint; lockupEnd: bigint; expiryTs: bigint; ms: { bps: number; requiresAttestation: boolean }[] }> = {}) => ({
    beneficiary: t.dave.address,
    total: o.total ?? 100n * COIN,
    lockupEnd: o.lockupEnd ?? T0 + 90n * DAY,
    expiryTs: o.expiryTs ?? T0 + 365n * DAY,
    milestones: o.ms ?? [{ bps: 2_500, requiresAttestation: false }, { bps: 5_000, requiresAttestation: true }],
  });

  it('escrows the coins, releases a carve-out after the lockup and an earn-out against an attestation, and burns the unearned rest', async () => {
    const t = await treasuryWorld({ extend: true });
    await t.h.send([await t.b.createGrant(t.team, 0n, grant(t))], t.team);
    expect(await t.coinBal(t.team)).toBe(100n * COIN);
    expect((await coinsHeld(t)).grantsUnreleased).toBe(100n * COIN);
    const g0 = await t.dec.grantAddress(0n);

    expect(await t.h.fail([await t.b.releaseMilestone(t.carol, g0, 0, t.dave)], t.carol)).toContain('MilestoneNotReady');
    t.h.setTime(T0 + 90n * DAY);
    await t.h.send([await t.b.releaseMilestone(t.carol, g0, 0, t.dave)], t.carol); // anyone may crank; the coins go to the beneficiary
    expect(await t.coinBal(t.dave)).toBe(25n * COIN);
    expect(await t.h.fail([await t.b.releaseMilestone(t.carol, g0, 0, t.dave)], t.carol)).toContain('AlreadyReleased');
    // The earn-out needs the attestation, at the right address, under the grant's credential and schema.
    expect(await t.h.fail([await t.b.releaseMilestone(t.carol, g0, 1, t.dave, await t.attestationAddress(await milestoneNonce(g0, 1)))], t.carol)).toContain('NotAttested');
    expect(await t.h.fail([await t.b.releaseMilestone(t.carol, g0, 1, t.dave)], t.carol)).toContain('WrongAttestationAccount'); // ZERO address
    const att = await t.attest(await milestoneNonce(g0, 1), new Uint8Array([1]), 0n);
    expect(await t.h.fail([await t.b.releaseMilestone(t.carol, g0, 1, t.alice, att)], t.carol)).toContain('WrongBeneficiary'); // someone else's coin account
    expect(await t.h.fail([await t.b.releaseMilestone(t.carol, g0, 2, t.dave, att)], t.carol)).toContain('GrantInvalid'); // no third milestone
    await t.h.send([await t.b.releaseMilestone(t.carol, g0, 1, t.dave, att)], t.carol);
    expect(await t.coinBal(t.dave)).toBe(75n * COIN);
    expect((await coinsHeld(t)).grantsUnreleased).toBe(25n * COIN);

    // 25% of the grant had no milestone: it is not releasable and burns at expiry, to the benefit of every other coin.
    expect(await t.h.fail([await t.b.expireGrant(t.carol, g0)], t.carol)).toContain('GrantNotExpired');
    t.h.setTime(T0 + 365n * DAY);
    expect(await t.h.fail([await t.b.releaseMilestone(t.carol, g0, 0, t.dave)], t.carol)).toMatch(/GrantExpired|AlreadyReleased/);
    const supply = t.h.mintInfo(t.coin).supply;
    await t.h.send([await t.b.expireGrant(t.carol, g0)], t.carol);
    expect(t.h.mintInfo(t.coin).supply).toBe(supply - 25n * COIN);
    expect((await coinsHeld(t)).grantsUnreleased).toBe(0n);
    expect((await t.dec.grant(0n)).burned).toBe(true);
    expect(await t.h.fail([await t.b.expireGrant(t.carol, g0)], t.carol)).toContain('GrantExpired');
  });

  it('an earn-out that is never attested is burned whole at expiry', async () => {
    const t = await treasuryWorld({ extend: true });
    await t.h.send([await t.b.createGrant(t.team, 0n, grant(t, { ms: [{ bps: 10_000, requiresAttestation: true }] }))], t.team);
    const g0 = await t.dec.grantAddress(0n);
    t.h.setTime(T0 + 400n * DAY);
    await t.h.send([await t.b.expireGrant(t.dave, g0)], t.dave);
    expect(await t.coinBal(t.dave)).toBe(0n);
    expect(t.h.mintInfo(t.coin).supply).toBe(900n * COIN);
  });

  it('refuses grants with a short lockup, bad terms, the wrong id or the wrong signer, and an expired attestation', async () => {
    const t = await treasuryWorld({ extend: true });
    const bad: [string, Parameters<typeof grant>[1], string][] = [
      ['lockup under the 90-day minimum', { lockupEnd: T0 + 90n * DAY - 1n }, 'LockupTooShort'],
      ['milestones over 100%', { ms: [{ bps: 6_000, requiresAttestation: false }, { bps: 4_001, requiresAttestation: false }] }, 'GrantInvalid'],
      ['a zero-share milestone', { ms: [{ bps: 0, requiresAttestation: false }] }, 'GrantInvalid'],
      ['no milestones', { ms: [] }, 'GrantInvalid'],
      ['expiry not after the lockup', { expiryTs: T0 + 90n * DAY }, 'GrantInvalid'],
      ['an empty grant', { total: 0n }, 'GrantInvalid'],
    ];
    for (const [name, o, err] of bad) expect(await t.h.fail([await t.b.createGrant(t.team, 0n, grant(t, o))], t.team), name).toContain(err);
    expect(await t.h.fail([await t.b.createGrant(t.team, 1n, grant(t))], t.team)).toContain('WrongProposalId');
    expect(await t.h.fail([await t.b.createGrant(t.alice, 0n, grant(t))], t.alice)).toMatch(/Unauthorized|ConstraintHasOne/);
    expect(await t.h.fail([await t.b.createGrant(t.team, 0n, grant(t, { total: 201n * COIN }))], t.team)).toMatch(/insufficient|0x1|TokenError/i); // more than the team holds

    await t.h.send([await t.b.createGrant(t.team, 0n, grant(t))], t.team);
    const g0 = await t.dec.grantAddress(0n);
    const att = await t.attest(await milestoneNonce(g0, 1), new Uint8Array([1]), T0 + 100n * DAY);
    t.h.setTime(T0 + 101n * DAY);
    expect(await t.h.fail([await t.b.releaseMilestone(t.carol, g0, 1, t.dave, att)], t.carol)).toContain('NotAttested'); // the attestation lapsed
  });

  it('a liquidation forfeits unvested grants without stranding anyone\'s share of the vault', async () => {
    const t = await treasuryWorld({ extend: true });
    await t.h.send([await t.b.createGrant(t.team, 0n, grant(t))], t.team);
    const g0 = await t.dec.grantAddress(0n);
    const att = await t.attest(t.treasury, new Uint8Array([1]), T0 + 1n);
    t.h.setTime(T0 + 1n);
    await t.h.send([t.b.lapse(att)], t.dave);
    t.h.setTime(T0 + 8n * DAY);
    await t.h.send([t.b.liquidate()], t.dave);
    const st = t.state();
    expect([st.snapshotVault, st.snapshotSupply]).toEqual([10_000_000_000n, 900n * COIN]); // the 100 unvested coins are not in the denominator
    expect(await t.h.fail([await t.b.releaseMilestone(t.carol, g0, 0, t.dave)], t.carol)).toContain('Liquidating');
    await t.h.send([await t.b.expireGrant(t.dave, g0)], t.dave); // forfeited now, not at expiry
    expect(t.h.mintInfo(t.coin).supply).toBe(900n * COIN);
    let paid = 0n;
    for (const [w, n] of [[t.alice, 400n], [t.bob, 300n], [t.carol, 100n], [t.team, 100n]] as const) {
      await t.h.send([await t.b.redeem(w, n * COIN)], w);
      paid += await t.quoteBal(w);
    }
    expect(10_000_000_000n - paid < 4n).toBe(true); // all of the vault went to the 900 circulating coins, up to rounding dust
  });
});

describe.skipIf(!have)('disclosure feed (E5)', () => {
  it('a holder request starts a clock; while it is overdue the team cannot spend; a disclosure clears it', async () => {
    const t = await treasuryWorld({ extend: true });
    const att = await t.attest(t.treasury, new Uint8Array([1]), T0 + 200n * DAY);
    expect(await t.h.fail([await t.b.requestDisclosure(t.dave)], t.dave)).toContain('NotHolder');
    await t.h.send([await t.b.requestDisclosure(t.carol)], t.carol);
    t.h.setTime(T0 + 5n * DAY);
    await t.h.send([await t.b.requestDisclosure(t.bob)], t.bob); // a second request does not restart the clock
    expect(t.extState()?.openRequestTs).toBe(T0);
    await t.h.send([await t.b.spend(t.team, 1n, att)], t.team); // inside the 14 days
    t.h.setTime(T0 + 14n * DAY);
    await t.h.send([await t.b.spend(t.team, 1n, att)], t.team); // the deadline itself is still on time
    t.h.setTime(T0 + 14n * DAY + 1n);
    expect(await t.h.fail([await t.b.spend(t.team, 1n, att)], t.team)).toContain('DisclosureOverdue');
    const hash = new Uint8Array(32).fill(7);
    expect(await t.h.fail([await t.b.postDisclosure(t.alice, hash)], t.alice)).toMatch(/Unauthorized|ConstraintHasOne/);
    await t.h.send([await t.b.postDisclosure(t.team, hash)], t.team);
    const e = t.extState()!;
    expect([e.openRequestTs, e.disclosures, e.lastDisclosureTs]).toEqual([0n, 1, T0 + 14n * DAY + 1n]);
    expect(Array.from(e.lastDisclosureHash)).toEqual(Array.from(hash));
    await t.h.send([await t.b.spend(t.team, 1n, att)], t.team);
  });

  it('asks for a minimum stake to request, and is off unless enabled', async () => {
    const t = await treasuryWorld({ extend: true, ext: { requestMinBps: 2_000 } }); // 20% of the supply
    expect(await t.h.fail([await t.b.requestDisclosure(t.carol)], t.carol)).toContain('NotHolder'); // 10%
    await t.h.send([await t.b.requestDisclosure(t.alice)], t.alice); // 40%
    const off = await treasuryWorld({ extend: true, ext: { disclosurePeriodSecs: 0n } });
    expect(await off.h.fail([await off.b.requestDisclosure(off.alice)], off.alice)).toContain('Disabled');
    expect(await off.h.fail([await off.b.postDisclosure(off.team, new Uint8Array(32))], off.team)).toContain('Disabled');
  });
});

describe.skipIf(!have)('IP and asset assignment gate (E6)', () => {
  it('blocks team outflows until counsel\'s attestation is recorded, once', async () => {
    const t = await treasuryWorld({ extend: true, ext: { assignRequired: true, disclosurePeriodSecs: 0n } });
    const spendAtt = await t.attest(t.treasury, new Uint8Array([1]), T0 + 200n * DAY);
    expect(await t.h.fail([await t.b.spend(t.team, 1n, spendAtt)], t.team)).toContain('AssignmentRequired');
    expect(await t.h.fail([await t.b.recordAssignment(await t.attestationAddress(t.treasury, t.assignSchema))], t.dave)).toContain('NotAttested');
    expect(await t.h.fail([await t.b.recordAssignment(t.credential)], t.dave)).toContain('WrongAttestationAccount');
    // The treasury's spend attestation is under another schema, so it cannot stand in for counsel's.
    expect(await t.h.fail([await t.b.recordAssignment(spendAtt)], t.dave)).toContain('WrongAttestationAccount');
    const assignment = await t.attest(t.treasury, new Uint8Array([1]), 0n, t.assignSchema);
    await t.h.send([await t.b.recordAssignment(assignment)], t.dave);
    expect(t.extState()?.assigned).toBe(true);
    await t.h.send([await t.b.spend(t.team, 1n, spendAtt)], t.team);
    expect(await t.h.fail([await t.b.recordAssignment(assignment)], t.dave)).toContain('AlreadyAssigned');
  });

  it('is off unless the treasury was created with the requirement', async () => {
    const t = await treasuryWorld({ extend: true });
    const assignment = await t.attest(t.treasury, new Uint8Array([1]), 0n, t.assignSchema);
    expect(await t.h.fail([await t.b.recordAssignment(assignment)], t.dave)).toContain('Disabled');
    expect(t.extState()?.assignRequired).toBe(false);
  });
});
