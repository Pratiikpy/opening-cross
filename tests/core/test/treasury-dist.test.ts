// Pro-rata distributions to staked coins (E8), verified-revenue rounds and tranches (V3, Y6), and the
// withdraw-only wind-down (E7): ADR-0472 and ADR-0474.
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { T0 } from '../src/harness.js';
import { DAY, TREASURY_SO, type TW, type Wallet, roundNonce, treasuryWorld } from '../src/treasury-world.js';

const COIN = 1_000_000n;
const have = existsSync(TREASURY_SO);

/** Every coin the program holds is accounted for, and the distribution vault covers what it owes. */
async function invariants(t: TW, stakers: Wallet[]) {
  const e = t.extState();
  if (!e) throw new Error('not extended');
  expect(t.h.balance(t.coinVault)).toBe(e.votesLocked + e.totalStaked + e.grantsUnreleased);
  let staked = 0n;
  let pending = 0n;
  for (const s of stakers) {
    const p = await t.dec.position(s).catch(() => null);
    if (p) { staked += p.amount; pending += p.pending; }
  }
  expect(staked).toBe(e.totalStaked);
  // Settled-but-unclaimed rewards plus the unreleased stream can never exceed the vault.
  expect(t.h.balance(t.distVault) >= pending + e.streamAmount).toBe(true);
}

describe.skipIf(!have)('distributions to staked coins (E8)', () => {
  it('pays stakers pro rata to their stake at the time of each deposit, exactly, and to nobody else', async () => {
    const t = await treasuryWorld({ extend: true });
    await t.h.send([await t.b.stake(t.alice, 400n * COIN)], t.alice);
    await t.h.send([await t.b.stake(t.bob, 100n * COIN)], t.bob);
    await t.h.send([await t.b.deposit(t.company, 1_000_000_000n)], t.company);
    await invariants(t, [t.alice, t.bob, t.carol]);
    // Carol arrives after the deposit: she shares only what comes next.
    await t.h.send([await t.b.stake(t.carol, 100n * COIN)], t.carol);
    expect(await t.h.fail([await t.b.claim(t.carol)], t.carol)).toContain('NothingToClaim');
    await t.h.send([await t.b.deposit(t.company, 600_000_000n)], t.company); // 400:100:100
    await t.h.send([await t.b.claim(t.alice)], t.alice);
    await t.h.send([await t.b.claim(t.bob)], t.bob);
    await t.h.send([await t.b.claim(t.carol)], t.carol);
    expect(await t.quoteBal(t.alice)).toBe(800_000_000n + 400_000_000n); // 4/5 of 1000 + 4/6 of 600
    expect(await t.quoteBal(t.bob)).toBe(200_000_000n + 100_000_000n);
    expect(await t.quoteBal(t.carol)).toBe(100_000_000n);
    expect(t.h.balance(t.distVault)).toBe(0n);
    expect(await t.h.fail([await t.b.claim(t.alice)], t.alice)).toContain('NothingToClaim'); // no double claim
    await invariants(t, [t.alice, t.bob, t.carol]);
  });

  it('settles before a stake changes: unstaking and re-staking neither loses nor duplicates a reward', async () => {
    const t = await treasuryWorld({ extend: true });
    await t.h.send([await t.b.stake(t.alice, 300n * COIN)], t.alice);
    await t.h.send([await t.b.stake(t.bob, 100n * COIN)], t.bob);
    await t.h.send([await t.b.deposit(t.company, 400_000_000n)], t.company); // alice 300, bob 100
    await t.h.send([await t.b.unstake(t.alice, 300n * COIN)], t.alice);       // alice leaves with her 300 pending
    await t.h.send([await t.b.deposit(t.company, 100_000_000n)], t.company); // bob alone: all 100
    await t.h.send([await t.b.stake(t.alice, 100n * COIN)], t.alice);         // alice returns; the 100 is not hers
    await t.h.send([await t.b.deposit(t.company, 200_000_000n)], t.company); // 100:100
    for (const w of [t.alice, t.bob]) await t.h.send([await t.b.claim(w)], w);
    expect(await t.quoteBal(t.alice)).toBe(300_000_000n + 100_000_000n);
    expect(await t.quoteBal(t.bob)).toBe(100_000_000n + 100_000_000n + 100_000_000n);
    expect(await t.coinBal(t.alice)).toBe(400n * COIN - 100n * COIN);
    await invariants(t, [t.alice, t.bob]);
  });

  it('holds a deposit made while nobody is staked and gives it to the first staker', async () => {
    const t = await treasuryWorld({ extend: true });
    await t.h.send([await t.b.deposit(t.company, 50_000_000n)], t.company);
    expect(t.extState()?.streamAmount).toBe(50_000_000n);
    await t.h.send([await t.b.stake(t.bob, 1n)], t.bob); // one atom is enough
    expect(t.extState()?.streamAmount).toBe(0n);
    await t.h.send([await t.b.claim(t.bob)], t.bob);
    expect(await t.quoteBal(t.bob)).toBe(50_000_000n);
    expect(t.h.balance(t.distVault)).toBe(0n);
  });

  it('rounds in the vault\'s favour: random operations never pay out more than was deposited', async () => {
    const t = await treasuryWorld({ extend: true });
    const people = [t.alice, t.bob, t.carol];
    let seed = 0x9e3779b9;
    const rnd = (n: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
    let deposited = 0n;
    await t.h.send([await t.b.stake(t.alice, 1_000n)], t.alice);
    const staked = new Map<Wallet, bigint>(people.map((p) => [p, p === t.alice ? 1_000n : 0n]));
    for (let i = 0; i < 40; i++) {
      const who = people[rnd(3)]!;
      const kind = rnd(4);
      try {
        if (kind === 0) {
          const bal = await t.coinBal(who);
          if (bal === 0n) continue;
          const amt = BigInt(1 + rnd(Number(bal > 7_000_000n ? 7_000_000n : bal)));
          await t.h.send([await t.b.stake(who, amt)], who);
          staked.set(who, staked.get(who)! + amt);
        } else if (kind === 1) {
          const have = staked.get(who)!;
          if (have === 0n) continue;
          const amt = BigInt(1 + rnd(Number(have)));
          await t.h.send([await t.b.unstake(who, amt)], who);
          staked.set(who, have - amt);
        } else if (kind === 2) {
          const amt = BigInt(1 + rnd(999_999_999));
          await t.h.send([await t.b.deposit(t.company, amt)], t.company);
          deposited += amt;
        } else {
          await t.h.send([await t.b.claim(who)], who).catch(() => undefined);
        }
      } catch (e) {
        throw new Error(`step ${i} (${kind}) failed: ${(e as Error).message.slice(0, 300)}`);
      }
      await invariants(t, people);
    }
    for (const w of people) {
      if (staked.get(w)! > 0n) await t.h.send([await t.b.unstake(w, staked.get(w)!)], w);
      await t.h.send([await t.b.claim(w)], w).catch(() => undefined);
    }
    const paid = (await Promise.all(people.map((w) => t.quoteBal(w)))).reduce((a, b) => a + b, 0n);
    const left = t.h.balance(t.distVault);
    expect(paid + left).toBe(deposited); // nothing created, nothing lost
    // What stays behind is rounding dust (bounded: an atom or so per operation) plus any stream nobody staked to receive.
    expect(left - t.extState()!.streamAmount < 200n).toBe(true);
  });

  it('refuses the careless: zero amounts, other people\'s positions, over-unstaking, deposits and stakes when liquidating', async () => {
    const t = await treasuryWorld({ extend: true });
    expect(await t.h.fail([await t.b.stake(t.alice, 0n)], t.alice)).toContain('InvalidParams');
    expect(await t.h.fail([await t.b.deposit(t.company, 0n)], t.company)).toContain('InvalidParams');
    await t.h.send([await t.b.stake(t.alice, 10n * COIN)], t.alice);
    expect(await t.h.fail([await t.b.unstake(t.alice, 11n * COIN)], t.alice)).toContain('Overflow');
    expect(await t.h.fail([await t.b.unstake(t.bob, 1n)], t.bob)).toMatch(/AccountNotInitialized|ConstraintSeeds|3012|2006/);
    expect(await t.h.fail([await t.b.stake(t.dave, 1n)], t.dave)).toMatch(/insufficient|0x1|TokenError/i); // dave holds no coins
    await t.h.send([await t.b.deposit(t.company, 10_000_000n)], t.company);

    const att = await t.attest(t.treasury, new Uint8Array([1]), T0 + 1n);
    t.h.setTime(T0 + 1n);
    await t.h.send([t.b.lapse(att)], t.dave);
    t.h.setTime(T0 + 8n * DAY);
    await t.h.send([t.b.liquidate()], t.dave);
    expect(await t.h.fail([await t.b.stake(t.alice, 1n)], t.alice)).toContain('Liquidating');
    expect(await t.h.fail([await t.b.deposit(t.company, 1n)], t.company)).toContain('Liquidating');
    // Exits are never blocked: unstake and claim still work in liquidation, then the coins redeem.
    await t.h.send([await t.b.claim(t.alice)], t.alice);
    expect(await t.quoteBal(t.alice)).toBe(10_000_000n);
    await t.h.send([await t.b.unstake(t.alice, 10n * COIN)], t.alice);
    await t.h.send([await t.b.redeem(t.alice, 400n * COIN)], t.alice);
    expect(await t.quoteBal(t.alice)).toBe(10_000_000n + 4_000_000_000n);
  });
});

describe.skipIf(!have)('verified-revenue rounds (V3, Y6)', () => {
  const REV = 5_000_000_000n; // 5,000 quote of attested revenue; the holders' share is 10%
  const setup = async (o: Parameters<typeof treasuryWorld>[0] = {}) => {
    const t = await treasuryWorld({ extend: true, ...o });
    await t.h.send([await t.b.stake(t.alice, 300n * COIN)], t.alice);
    await t.h.send([await t.b.stake(t.bob, 100n * COIN)], t.bob);
    return t;
  };

  it('pays the attested share into the stakers\' pot once the round is over, and only once', async () => {
    const t = await setup();
    await t.attestRevenue(0n, REV);
    expect(await t.h.fail([await t.b.payRound(t.company, 0n)], t.company)).toContain('RoundOpen'); // round 0 runs to T0+7d
    t.h.setTime(T0 + 7n * DAY);
    const before = await t.quoteBal(t.company);
    await t.h.send([await t.b.payRound(t.company, 0n)], t.company);
    expect(before - (await t.quoteBal(t.company))).toBe(500_000_000n);
    const r = await t.dec.round(0n);
    expect([r.revenue, r.due, r.missed]).toEqual([REV, 500_000_000n, false]);
    for (const w of [t.alice, t.bob]) await t.h.send([await t.b.claim(w)], w);
    expect(await t.quoteBal(t.alice)).toBe(375_000_000n);
    expect(await t.quoteBal(t.bob)).toBe(125_000_000n);
    // The same round cannot be paid twice, nor marked missed afterwards.
    expect(await t.h.fail([await t.b.payRound(t.company, 0n)], t.company)).toMatch(/already in use|0x0/);
    t.h.setTime(T0 + 11n * DAY);
    expect(await t.h.fail([await t.b.markMissed(t.dave, 0n)], t.dave)).toMatch(/already in use|0x0/);
    expect(t.extState()?.navOpen).toBe(false);
  });

  it('rounds the share up, accepts zero revenue, and refuses forged, missing, malformed and expired attestations', async () => {
    const t = await setup();
    t.h.setTime(T0 + 7n * DAY);
    await t.attestRevenue(0n, 1n); // 10% of one atom rounds up to one atom
    await t.h.send([await t.b.payRound(t.company, 0n)], t.company);
    expect((await t.dec.round(0n)).due).toBe(1n);

    t.h.setTime(T0 + 14n * DAY);
    await t.attestRevenue(1n, 0n);
    await t.h.send([await t.b.payRound(t.company, 1n)], t.company); // a zero-revenue quarter is reported, not missed
    expect((await t.dec.round(1n)).due).toBe(0n);

    t.h.setTime(T0 + 21n * DAY);
    expect(await t.h.fail([await t.b.payRound(t.company, 2n)], t.company)).toContain('NotAttested'); // nothing attested
    // An attestation for another round is the wrong account.
    expect(await t.h.fail([await t.b.payRound(t.company, 2n, await t.attestationAddress(t.treasury, t.revSchema))], t.company)).toContain('WrongAttestationAccount');
    // Expired attestation.
    await t.attestRevenue(3n, REV, T0 + 22n * DAY);
    t.h.setTime(T0 + 28n * DAY + 1n);
    expect(await t.h.fail([await t.b.payRound(t.company, 3n)], t.company)).toContain('NotAttested');
    // The payer must hold the quote and sign: a poor payer fails inside the token program.
    await t.attestRevenue(4n, REV);
    t.h.setTime(T0 + 35n * DAY);
    expect(await t.h.fail([await t.b.payRound(t.dave, 4n)], t.dave)).toMatch(/insufficient|0x1|TokenError/i);
  });

  it('refuses revenue data that is not a u64 even when the schema lets it through', async () => {
    // SAS itself refuses data that does not fit a u64 schema, so this needs a treasury whose revenue schema is a one-byte one.
    const t = await treasuryWorld({ extend: true, revenueSchemaIsOneByte: true });
    await t.h.send([await t.b.stake(t.alice, 100n * COIN)], t.alice);
    const a = await t.attest(await roundNonce(t.treasury, 0n), new Uint8Array([9]), 0n, t.schema);
    t.h.setTime(T0 + 7n * DAY);
    expect(await t.h.fail([await t.b.payRound(t.company, 0n, a)], t.company)).toContain('BadRevenueData');
  });

  it('a late round is missed: anyone records it and holders get the NAV exit; a late payment is refused', async () => {
    const t = await setup();
    t.h.setTime(T0 + 7n * DAY + 3n * DAY); // exactly at the payment deadline: still payable
    expect(await t.h.fail([await t.b.markMissed(t.dave, 0n)], t.dave)).toContain('RoundNotLate');
    t.h.setTime(T0 + 10n * DAY + 1n);
    expect(await t.h.fail([await t.b.payRound(t.company, 0n)], t.company)).toContain('RoundClosed');
    await t.h.send([await t.b.markMissed(t.dave, 0n)], t.dave);
    const e = t.extState()!;
    expect([e.navOpen, e.missedRounds]).toEqual([true, 1]);
    expect((await t.dec.round(0n)).missed).toBe(true);
    // The exit works at NAV (10 per coin; carol's 100 coins, capped at 10% of 1,000).
    await t.h.send([await t.b.navRedeem(t.carol, 100n * COIN)], t.carol);
    expect(await t.quoteBal(t.carol)).toBe(1_000_000_000n);
    // And the team's allowance is frozen.
    const att = await t.attest(t.treasury, new Uint8Array([1]), T0 + 90n * DAY);
    expect(await t.h.fail([await t.b.spend(t.team, 1n, att)], t.team)).toContain('NavMode');
    // Marking the same round again, or paying it, finds the record.
    expect(await t.h.fail([await t.b.markMissed(t.dave, 0n)], t.dave)).toMatch(/already in use|0x0/);
  });

  it('releases a tranche once per paid round whose attested revenue meets the bar', async () => {
    const t = await setup();
    const dest = await t.quoteOf(t.team);
    await t.attestRevenue(0n, REV);
    await t.attestRevenue(1n, 100_000_000n); // below the 1,000 bar
    t.h.setTime(T0 + 7n * DAY);
    await t.h.send([await t.b.payRound(t.company, 0n)], t.company);
    t.h.setTime(T0 + 14n * DAY);
    await t.h.send([await t.b.payRound(t.company, 1n)], t.company);
    expect(await t.h.fail([await t.b.tranche(t.alice, 0n, dest)], t.alice)).toMatch(/Unauthorized|ConstraintHasOne/);
    await t.h.send([await t.b.tranche(t.team, 0n, dest)], t.team);
    expect(await t.quoteBal(t.team)).toBe(500_000_000n);
    expect(await t.h.fail([await t.b.tranche(t.team, 0n, dest)], t.team)).toContain('TrancheNotEligible'); // once per round
    expect(await t.h.fail([await t.b.tranche(t.team, 1n, dest)], t.team)).toContain('TrancheNotEligible'); // revenue below the bar
    expect(await t.h.fail([await t.b.tranche(t.team, 7n, dest)], t.team)).toMatch(/AccountNotInitialized|3012|ConstraintSeeds/); // no such round

    // A missed round releases nothing, and NAV mode freezes tranches.
    t.h.setTime(T0 + 21n * DAY + 3n * DAY + 1n);
    await t.h.send([await t.b.markMissed(t.dave, 2n)], t.dave);
    expect(await t.h.fail([await t.b.tranche(t.team, 2n, dest)], t.team)).toMatch(/NavMode|TrancheNotEligible/);
  });
});

describe.skipIf(!have)('withdraw-only wind-down (E7)', () => {
  const liquidate = async (t: TW) => {
    const att = await t.attest(t.treasury, new Uint8Array([1]), T0 + 1n);
    t.h.setTime(T0 + 1n);
    await t.h.send([t.b.lapse(att)], t.dave);
    t.h.setTime(T0 + 8n * DAY);
    await t.h.send([t.b.liquidate()], t.dave);
  };

  it('keeps redemption open for the whole window, then sweeps the rest to the recovery account, once', async () => {
    const t = await treasuryWorld({ extend: true });
    const recoveryQuote = await t.quoteOf(t.recovery);
    expect(await t.h.fail([await t.b.sweep(recoveryQuote)], t.dave)).toContain('NotLiquidating');
    await liquidate(t);
    const start = t.extState()!.windStart;
    expect(start).toBe(T0 + 8n * DAY);
    await t.h.send([await t.b.redeem(t.alice, 400n * COIN)], t.alice);
    expect(await t.quoteBal(t.alice)).toBe(4_000_000_000n);
    expect(await t.h.fail([await t.b.sweep(recoveryQuote)], t.dave)).toContain('WindowOpen');
    t.h.setTime(start + 180n * DAY - 1n);
    expect(await t.h.fail([await t.b.sweep(recoveryQuote)], t.dave)).toContain('WindowOpen');
    await t.h.send([await t.b.redeem(t.bob, 300n * COIN)], t.bob); // still redeemable on the last day
    t.h.setTime(start + 180n * DAY);
    expect(await t.h.fail([await t.b.sweep(await t.quoteOf(t.dave))], t.dave)).toContain('WrongRecovery');
    await t.h.send([await t.b.sweep(recoveryQuote)], t.dave);
    expect(await t.quoteBal(t.recovery)).toBe(3_000_000_000n); // carol's and the team's 300 coins' share
    expect(t.h.balance(t.vault)).toBe(0n);
    expect(await t.h.fail([await t.b.sweep(recoveryQuote)], t.dave)).toContain('AlreadySwept');
    expect(await t.h.fail([await t.b.redeem(t.carol, 100n * COIN)], t.carol)).toContain('WoundDown');
  });

  it('is off unless the treasury asked for it', async () => {
    const t = await treasuryWorld({ extend: true, ext: { windowSecs: 0n } });
    await liquidate(t);
    t.h.setTime(T0 + 900n * DAY);
    expect(await t.h.fail([await t.b.sweep(await t.quoteOf(t.recovery))], t.dave)).toContain('Disabled');
    await t.h.send([await t.b.redeem(t.carol, 100n * COIN)], t.carol); // redemption never expires
    expect(await t.quoteBal(t.carol)).toBe(1_000_000_000n);
  });
});

describe.skipIf(!have)('streamed distributions: staking for one block to catch a deposit earns one block\'s share', () => {
  const streamed = async () => {
    const t = await treasuryWorld({ extend: true, ext: { streamSecs: 7n * DAY } });
    await t.h.send([await t.b.stake(t.alice, 300n * COIN)], t.alice);
    await t.h.send([await t.b.stake(t.bob, 100n * COIN)], t.bob);
    return t;
  };

  it('releases a deposit in proportion to time: half way through, the stakers have half of it, exactly', async () => {
    const t = await streamed();
    await t.h.send([await t.b.deposit(t.company, 400_000_000n)], t.company);
    await expect(t.h.fail([await t.b.claim(t.alice)], t.alice)).resolves.toContain('NothingToClaim'); // nothing has streamed yet
    t.h.setTime(T0 + 3n * DAY + 12n * 3600n);
    await t.h.send([await t.b.claim(t.alice)], t.alice);
    await t.h.send([await t.b.claim(t.bob)], t.bob);
    expect(await t.quoteBal(t.alice)).toBe(150_000_000n); // 300/400 of the 200 released
    expect(await t.quoteBal(t.bob)).toBe(50_000_000n);
    t.h.setTime(T0 + 8n * DAY);
    await t.h.send([await t.b.claim(t.alice)], t.alice);
    await t.h.send([await t.b.claim(t.bob)], t.bob);
    expect(await t.quoteBal(t.alice)).toBe(300_000_000n);
    expect(await t.quoteBal(t.bob)).toBe(100_000_000n);
    expect(t.h.balance(t.distVault)).toBe(0n);
    expect(t.extState()?.streamAmount).toBe(0n);
  });

  it('a coin staked just before a deposit and withdrawn just after earns almost nothing', async () => {
    const t = await streamed();
    await t.h.send([await t.b.stake(t.carol, 100n * COIN)], t.carol); // 100 of 500 staked: would be 20% if paid at once
    await t.h.send([await t.b.deposit(t.company, 500_000_000n)], t.company);
    t.h.setTime(T0 + 60n); // one minute later she leaves
    await t.h.send([await t.b.unstake(t.carol, 100n * COIN)], t.carol);
    await t.h.send([await t.b.claim(t.carol)], t.carol);
    const got = await t.quoteBal(t.carol);
    expect(got < 100_000n).toBe(true); // one minute of a week: about 1/10,080 of her 100 quote share, vs 100,000,000 at once
    expect(got > 0n).toBe(true);
    // The rest still reaches the stakers who stayed.
    t.h.setTime(T0 + 8n * DAY);
    await t.h.send([await t.b.claim(t.alice)], t.alice);
    await t.h.send([await t.b.claim(t.bob)], t.bob);
    const total = got + (await t.quoteBal(t.alice)) + (await t.quoteBal(t.bob));
    expect(500_000_000n - total < 10n).toBe(true);
  });

  it('merges a second deposit into the stream; nothing is created or lost; an empty pool waits for the first staker', async () => {
    const t = await streamed();
    await t.h.send([await t.b.deposit(t.company, 400_000_000n)], t.company);
    t.h.setTime(T0 + 2n * DAY);
    await t.h.send([await t.b.deposit(t.company, 300_000_000n)], t.company);
    expect(t.extState()!.streamEnd).toBe(T0 + 9n * DAY); // the whole runs for a fresh week
    t.h.setTime(T0 + 20n * DAY);
    for (const w of [t.alice, t.bob]) await t.h.send([await t.b.claim(w)], w);
    expect((await t.quoteBal(t.alice)) + (await t.quoteBal(t.bob)) + t.h.balance(t.distVault)).toBe(700_000_000n);
    expect(t.h.balance(t.distVault) < 4n).toBe(true);

    const e = await treasuryWorld({ extend: true, ext: { streamSecs: 7n * DAY } }); // nobody staked
    await e.h.send([await e.b.deposit(e.company, 70_000_000n)], e.company);
    e.h.setTime(T0 + 30n * DAY); // the whole window passes with nobody to receive it
    await e.h.send([await e.b.stake(e.bob, 1n)], e.bob);
    await e.h.send([await e.b.claim(e.bob)], e.bob);
    expect(await e.quoteBal(e.bob)).toBe(70_000_000n);
  });

  it('refuses a stream shorter than an hour', async () => {
    const t = await treasuryWorld();
    expect(await t.h.fail([await t.initExt({ streamSecs: 3_599n })], t.team)).toContain('InvalidParams');
    await t.h.send([await t.initExt({ streamSecs: 3_600n })], t.team);
  });
});
