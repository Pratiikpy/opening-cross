// Compute units of the extension instructions, measured on LiteSVM against the real binary. The
// bounds are about 1.5 times the figures recorded in docs/evidence/W2D-treasury-compute.md.
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ProposalKind } from '@opening-cross/treasury-client';
import { T0 } from '../src/harness.js';
import { DAY, TREASURY_SO, treasuryWorld } from '../src/treasury-world.js';

const COIN = 1_000_000n;

describe.skipIf(!existsSync(TREASURY_SO))('treasury compute units', () => {
  it('every extension instruction stays well inside one transaction\'s budget', async () => {
    const t = await treasuryWorld();
    const cu: Record<string, bigint> = {};
    const run = async (name: string, ix: Awaited<ReturnType<typeof t.initExt>>, who = t.team) => { cu[name] = await t.h.send([ix], who); };
    await run('init_ext', await t.initExt());
    const dest = await t.quoteOf(t.carol);
    await run('propose', await t.b.propose(t.alice, 0n, ProposalKind.Spend, 1_000_000_000n, dest), t.alice);
    await run('vote', await t.b.vote(t.alice, 0n, true, 400n * COIN), t.alice);
    await t.h.send([await t.b.vote(t.bob, 0n, true, 300n * COIN)], t.bob);
    t.h.setTime(T0 + 4n * DAY);
    await run('execute_proposal', await t.b.execute(t.dave, 0n, dest), t.dave);
    await run('reclaim_vote', await t.b.reclaim(t.alice, 0n), t.alice);
    await t.h.send([await t.b.reclaim(t.bob, 0n)], t.bob);
    await t.h.send([await t.b.propose(t.alice, 1n, ProposalKind.OpenNav)], t.alice);
    await t.h.send([await t.b.vote(t.alice, 1n, true, 400n * COIN)], t.alice);
    await t.h.send([await t.b.vote(t.bob, 1n, true, 300n * COIN)], t.bob);
    t.h.setTime(T0 + 8n * DAY);
    await t.h.send([await t.b.execute(t.dave, 1n, dest)], t.dave);
    await run('nav_redeem', await t.b.navRedeem(t.carol, 10n * COIN), t.carol);
    await run('stake', await t.b.stake(t.carol, 10n * COIN), t.carol);
    await run('deposit_distribution', await t.b.deposit(t.company, 100_000_000n), t.company);
    await run('claim_distribution', await t.b.claim(t.carol), t.carol);
    await run('unstake', await t.b.unstake(t.carol, 5n * COIN), t.carol);
    await t.attestRevenue(0n, 5_000_000_000n);
    await run('pay_round', await t.b.payRound(t.company, 0n), t.company);
    t.h.setTime(T0 + 18n * DAY);
    await run('mark_missed', await t.b.markMissed(t.dave, 1n), t.dave);
    await run('create_grant', await t.b.createGrant(t.team, 0n, { beneficiary: t.dave.address, total: 10n * COIN, lockupEnd: T0 + 120n * DAY, expiryTs: T0 + 300n * DAY, milestones: [{ bps: 5_000, requiresAttestation: false }, { bps: 5_000, requiresAttestation: true }] }), t.team);
    const g = await t.dec.grantAddress(0n);
    t.h.setTime(T0 + 120n * DAY);
    await run('release_milestone', await t.b.releaseMilestone(t.carol, g, 0, t.dave), t.carol);
    await run('post_disclosure', await t.b.postDisclosure(t.team, new Uint8Array(32)), t.team);
    await run('request_disclosure', await t.b.requestDisclosure(t.carol), t.carol);
    t.h.setTime(T0 + 300n * DAY);
    await run('expire_grant', await t.b.expireGrant(t.carol, g), t.carol);
    console.log('COMPUTE', JSON.stringify(Object.fromEntries(Object.entries(cu).map(([k, v]) => [k, Number(v)]))));
    for (const v of Object.values(cu)) expect(v < 65_000n).toBe(true);
  });
});
