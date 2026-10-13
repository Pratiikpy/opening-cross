// Holder votes above the allowance (E1, E2) and the NAV floor with its redemption wall (E3, VM8):
// ADR-0471. Every refusal below is a state a careless or hostile caller can reach.
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ProposalKind } from '@opening-cross/treasury-client';
import { T0 } from '../src/harness.js';
import { DAY, TREASURY_SO, ZERO, type TW, type Wallet, treasuryWorld } from '../src/treasury-world.js';

const COIN = 1_000_000n; // one whole coin
const pass = async (t: TW, id: bigint, proposer: Wallet, kind: ProposalKind, amount = 0n, destination = ZERO) => {
  await t.h.send([await t.b.propose(proposer, id, kind, amount, destination)], proposer);
  // Everything alice and bob hold, up to 400 and 300 coins: 70% of the supply.
  for (const [who, cap] of [[t.alice, 400n * COIN], [t.bob, 300n * COIN]] as [Wallet, bigint][]) {
    const held = await t.coinBal(who);
    await t.h.send([await t.b.vote(who, id, true, held < cap ? held : cap)], who);
  }
};

describe.skipIf(!existsSync(TREASURY_SO))('holder votes above the allowance', () => {
  it('a passed proposal spends above the allowance after the vote and the timelock, and voters get their coins back', async () => {
    const t = await treasuryWorld({ extend: true });
    const dest = await t.quoteOf(t.carol);
    await pass(t, 0n, t.alice, ProposalKind.Spend, 4_000_000_000n, dest);
    // Coins are locked in the program while the vote runs: one coin, one vote.
    expect(await t.coinBal(t.alice)).toBe(0n);
    expect(t.h.balance(t.coinVault)).toBe(700n * COIN);
    expect(t.extState()?.votesLocked).toBe(700n * COIN);
    expect((await t.dec.proposal(0n)).yes).toBe(700n * COIN);

    expect(await t.h.fail([await t.b.execute(t.carol, 0n, dest)], t.carol)).toContain('TimelockPending'); // vote still open
    t.h.setTime(T0 + 3n * DAY);
    expect(await t.h.fail([await t.b.execute(t.carol, 0n, dest)], t.carol)).toContain('TimelockPending'); // vote over, timelock running
    expect(await t.h.fail([await t.b.vote(t.carol, 0n, false, 100n * COIN)], t.carol)).toContain('VotingClosed');
    t.h.setTime(T0 + 4n * DAY);
    await t.h.send([await t.b.execute(t.carol, 0n, dest)], t.carol);
    expect(await t.quoteBal(t.carol)).toBe(4_000_000_000n);
    expect(t.h.balance(t.vault)).toBe(6_000_000_000n);
    expect(await t.h.fail([await t.b.execute(t.carol, 0n, dest)], t.carol)).toContain('AlreadyExecuted');

    // Reclaim: the coins return, the record is closed, a second reclaim finds nothing.
    await t.h.send([await t.b.reclaim(t.alice, 0n)], t.alice);
    await t.h.send([await t.b.reclaim(t.bob, 0n)], t.bob);
    expect(await t.coinBal(t.alice)).toBe(400n * COIN);
    expect(await t.coinBal(t.bob)).toBe(300n * COIN);
    expect(t.h.balance(t.coinVault)).toBe(0n);
    expect(t.extState()?.votesLocked).toBe(0n);
    expect(await t.h.fail([await t.b.reclaim(t.alice, 0n)], t.alice)).toMatch(/AccountNotInitialized|not initialized|ConstraintSeeds|3012/i);
  });

  it('refuses a proposal that lacks quorum, a majority, or that asks for more than one proposal may move', async () => {
    const t = await treasuryWorld({ extend: true });
    const dest = await t.quoteOf(t.carol);
    // 0: only carol (10%) votes yes: below the 20% quorum.
    await t.h.send([await t.b.propose(t.carol, 0n, ProposalKind.Spend, 1_000_000_000n, dest)], t.carol);
    await t.h.send([await t.b.vote(t.carol, 0n, true, 100n * COIN)], t.carol);
    // 1: 100 yes against 100 no ties: quorum is met (exactly 20%) but a tie is not a strict majority.
    await t.h.send([await t.b.propose(t.alice, 1n, ProposalKind.Spend, 1_000_000_000n, dest)], t.alice);
    await t.h.send([await t.b.vote(t.alice, 1n, true, 100n * COIN)], t.alice);
    await t.h.send([await t.b.vote(t.bob, 1n, false, 100n * COIN)], t.bob);
    // 2: asks for 6,000 against a vault of 10,000 and a 50% cap; the vote is unanimous.
    await t.h.send([await t.b.propose(t.alice, 2n, ProposalKind.Spend, 6_000_000_000n, dest)], t.alice);
    await t.h.send([await t.b.vote(t.alice, 2n, true, 300n * COIN)], t.alice);
    await t.h.send([await t.b.vote(t.bob, 2n, true, 200n * COIN)], t.bob);

    t.h.setTime(T0 + 4n * DAY);
    expect(await t.h.fail([await t.b.execute(t.dave, 0n, dest)], t.dave)).toContain('ProposalFailed');
    expect(await t.h.fail([await t.b.execute(t.dave, 1n, dest)], t.dave)).toContain('ProposalFailed');
    expect(await t.h.fail([await t.b.execute(t.dave, 2n, dest)], t.dave)).toContain('OverProposalCap');
    expect(t.h.balance(t.vault)).toBe(10_000_000_000n); // nothing moved
    // A no-vote that outweighs the yes-vote also fails, and a passed vote cannot be redirected.
    const u = await treasuryWorld({ extend: true });
    const udest = await u.quoteOf(u.carol);
    await u.h.send([await u.b.propose(u.alice, 0n, ProposalKind.Spend, 1_000_000_000n, udest)], u.alice);
    await u.h.send([await u.b.vote(u.alice, 0n, true, 100n * COIN)], u.alice);
    await u.h.send([await u.b.vote(u.bob, 0n, false, 300n * COIN)], u.bob);
    await pass(u, 1n, u.alice, ProposalKind.Spend, 1_000_000_000n, udest).catch(() => undefined); // alice has 300 left; bob 0
    u.h.setTime(T0 + 4n * DAY);
    expect(await u.h.fail([await u.b.execute(u.dave, 0n, udest)], u.dave)).toContain('ProposalFailed');
    const v = await treasuryWorld({ extend: true });
    const vdest = await v.quoteOf(v.carol);
    await pass(v, 0n, v.alice, ProposalKind.Spend, 1_000_000_000n, vdest);
    v.h.setTime(T0 + 4n * DAY);
    expect(await v.h.fail([await v.b.execute(v.dave, 0n, await v.quoteOf(v.dave))], v.dave)).toContain('WrongDestination');
    // Outside the execution window a passed proposal is dead.
    v.h.setTime(T0 + 4n * DAY + 14n * DAY + 1n);
    expect(await v.h.fail([await v.b.execute(v.dave, 0n, vdest)], v.dave)).toContain('ProposalExpired');
  });

  it('refuses proposals from non-holders, with the wrong id, or for a disabled feature; refuses early reclaim and an empty vote', async () => {
    const t = await treasuryWorld({ extend: true });
    const dest = await t.quoteOf(t.carol);
    expect(await t.h.fail([await t.b.propose(t.dave, 0n, ProposalKind.Spend, 1n, dest)], t.dave)).toContain('NotHolder');
    expect(await t.h.fail([await t.b.propose(t.alice, 1n, ProposalKind.Spend, 1n, dest)], t.alice)).toContain('WrongProposalId');
    expect(await t.h.fail([await t.b.propose(t.alice, 0n, ProposalKind.Spend, 0n, dest)], t.alice)).toContain('InvalidParams');
    expect(await t.h.fail([await t.b.propose(t.alice, 0n, ProposalKind.OpenNav, 5n, ZERO)], t.alice)).toContain('InvalidParams');
    // The team (authority) may always propose, holding coins or not.
    await t.h.send([await t.b.propose(t.team, 0n, ProposalKind.Spend, 1n, dest)], t.team);
    await t.h.send([await t.b.vote(t.alice, 0n, true, 1n)], t.alice);
    expect(await t.h.fail([await t.b.vote(t.alice, 0n, true, 0n)], t.alice)).toContain('InvalidParams');
    expect(await t.h.fail([await t.b.vote(t.dave, 0n, true, 1n)], t.dave)).toMatch(/insufficient|0x1|TokenError/i); // dave holds no coins
    expect(await t.h.fail([await t.b.reclaim(t.alice, 0n)], t.alice)).toContain('VotingOpen');
    // More coins than held cannot be voted: alice has 399 left, not 400.
    expect(await t.h.fail([await t.b.vote(t.alice, 0n, true, 400n * COIN)], t.alice)).toMatch(/insufficient|0x1|TokenError/i);

    const off = await treasuryWorld({ extend: true, ext: { votePeriodSecs: 0n } });
    expect(await off.h.fail([await off.b.propose(off.alice, 0n, ProposalKind.Spend, 1n, dest)], off.alice)).toContain('Disabled');
    const noNav = await treasuryWorld({ extend: true, ext: { navPeriodSecs: 0n } });
    expect(await noNav.h.fail([await noNav.b.propose(noNav.alice, 0n, ProposalKind.OpenNav)], noNav.alice)).toContain('Disabled');
  });

  it('a holder-approved spend is still held back by the other conditions on team outflows', async () => {
    const t = await treasuryWorld({ extend: true, ext: { assignRequired: true } });
    const dest = await t.quoteOf(t.carol);
    await pass(t, 0n, t.alice, ProposalKind.Spend, 1_000_000_000n, dest);
    t.h.setTime(T0 + 4n * DAY);
    expect(await t.h.fail([await t.b.execute(t.carol, 0n, dest)], t.carol)).toContain('AssignmentRequired');
  });

  it('an executed spend cannot be pre-empted by a liquidation: execution is refused once the treasury liquidates', async () => {
    const t = await treasuryWorld({ extend: true });
    const dest = await t.quoteOf(t.carol);
    await pass(t, 0n, t.alice, ProposalKind.Spend, 1_000_000_000n, dest);
    const att = await t.attest(t.treasury, new Uint8Array([1]), T0 + 1n);
    t.h.setTime(T0 + 1n);
    await t.h.send([t.b.lapse(att)], t.dave);
    t.h.setTime(T0 + 8n * DAY);
    await t.h.send([t.b.liquidate()], t.dave);
    expect(await t.h.fail([await t.b.execute(t.carol, 0n, dest)], t.carol)).toContain('Liquidating');
    // Voters still get their coins back, so they can redeem.
    await t.h.send([await t.b.reclaim(t.alice, 0n)], t.alice);
    await t.h.send([await t.b.reclaim(t.bob, 0n)], t.bob);
    await t.h.send([await t.b.redeem(t.alice, 400n * COIN)], t.alice);
    expect(await t.quoteBal(t.alice)).toBe(4_000_000_000n);
  });
});

describe.skipIf(!existsSync(TREASURY_SO))('NAV floor and the redemption wall', () => {
  const openNav = async (t: TW) => {
    await pass(t, 0n, t.alice, ProposalKind.OpenNav);
    t.h.setTime(T0 + 4n * DAY);
    await t.h.send([await t.b.execute(t.dave, 0n, await t.quoteOf(t.dave))], t.dave);
    await t.h.send([await t.b.reclaim(t.alice, 0n)], t.alice);
    await t.h.send([await t.b.reclaim(t.bob, 0n)], t.bob);
  };

  it('is closed until holders vote it open; then holders redeem at NAV, rate limited per period', async () => {
    const t = await treasuryWorld({ extend: true });
    expect(await t.h.fail([await t.b.navRedeem(t.carol, 10n * COIN)], t.carol)).toContain('NavClosed');
    await openNav(t);
    expect(t.extState()?.navOpen).toBe(true);

    // Vault 10,000 for 1,000 coins: 10 quote per coin. The cap is 10% of the period's supply = 100 coins.
    await t.h.send([await t.b.navRedeem(t.carol, 60n * COIN)], t.carol);
    expect(await t.quoteBal(t.carol)).toBe(600_000_000n);
    expect(t.h.balance(t.vault)).toBe(9_400_000_000n);
    expect(t.h.mintInfo(t.coin).supply).toBe(940n * COIN);
    await t.h.send([await t.b.navRedeem(t.bob, 40n * COIN)], t.bob);
    expect(await t.quoteBal(t.bob)).toBe(400_000_000n);
    expect(await t.h.fail([await t.b.navRedeem(t.bob, 1n)], t.bob)).toContain('NavLimit'); // the period is used up
    // Redeeming coins you do not have fails; redeeming nothing fails.
    expect(await t.h.fail([await t.b.navRedeem(t.dave, 1n)], t.dave)).toMatch(/insufficient|0x1|TokenError|NavLimit/i);
    expect(await t.h.fail([await t.b.navRedeem(t.alice, 0n)], t.alice)).toContain('InvalidParams');

    // Next period: the limit resets against the new supply (900 coins: cap 90).
    t.h.setTime(T0 + 4n * DAY + 7n * DAY);
    await t.h.send([await t.b.navRedeem(t.alice, 90n * COIN)], t.alice);
    expect(await t.h.fail([await t.b.navRedeem(t.alice, 1n)], t.alice)).toContain('NavLimit');
    expect(t.extState()?.navBurned).toBe(90n * COIN);
    expect(await t.quoteBal(t.alice)).toBe(90n * (9_000_000_000n / 900n)); // 10 per coin still
  });

  it('never dilutes the holders who stay: value per coin only rises, and rounding is in the vault\'s favour', async () => {
    const t = await treasuryWorld({ extend: true, vault: 10_000_000_007n, ext: { navCapBps: 10_000 } });
    await openNav(t);
    let vault = t.h.balance(t.vault);
    let supply = t.h.mintInfo(t.coin).supply;
    for (const [who, n] of [[t.carol, 3n], [t.bob, 7n], [t.carol, 1n], [t.alice, 13n], [t.bob, 1n], [t.carol, 5n]] as [Wallet, bigint][]) {
      await t.h.send([await t.b.navRedeem(who, n * COIN + 1n)], who); // odd amounts force rounding
      const v2 = t.h.balance(t.vault);
      const s2 = t.h.mintInfo(t.coin).supply;
      // v2 / s2 >= vault / supply, compared by cross multiplication.
      expect(v2 * supply >= vault * s2).toBe(true);
      vault = v2;
      supply = s2;
    }
  });

  it('excludes insiders, freezes team spending, and ends with a close vote', async () => {
    const w = await treasuryWorld({ extend: true, insiders: ['carol'] });
    await openNav(w);
    // The team key and every listed insider are excluded, even holding coins.
    expect(await w.h.fail([await w.b.navRedeem(w.team, 10n * COIN)], w.team)).toContain('InsiderExcluded');
    expect(await w.h.fail([await w.b.navRedeem(w.carol, 10n * COIN)], w.carol)).toContain('InsiderExcluded');
    await w.h.send([await w.b.navRedeem(w.bob, 10n * COIN)], w.bob); // an outsider is not
    // Team spending is frozen while holders can exit.
    const att = await w.attest(w.treasury, new Uint8Array([1]), T0 + 40n * DAY);
    expect(await w.h.fail([await w.b.spend(w.team, 1n, att)], w.team)).toContain('NavMode');
    // A close vote ends the window.
    await pass(w, 1n, w.alice, ProposalKind.CloseNav);
    w.h.setTime(T0 + 9n * DAY);
    await w.h.send([await w.b.execute(w.dave, 1n, await w.quoteOf(w.dave))], w.dave);
    expect(w.extState()?.navOpen).toBe(false);
    expect(await w.h.fail([await w.b.navRedeem(w.bob, 1n * COIN)], w.bob)).toContain('NavClosed');
    await w.h.send([await w.b.spend(w.team, 1n, att)], w.team);
  });
});
