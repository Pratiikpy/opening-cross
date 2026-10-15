// The keeper's Wave 3D duties against an in-memory chain that applies what the keeper sends (test/helpers/world3d.ts): the pass does the work, a second pass finds nothing left to do
// (idempotence), a keeper started from nothing finds the same state and does not repeat the work (restart), a dry run sends nothing, and a call the program would refuse is never sent.
import { describe, expect, it } from 'vitest';
import { type Instruction } from '@solana/kit';
import { CrossState } from '@opening-cross/cross-core-client';
import * as backing from '@opening-cross/cross-backing-client';
import * as bounty from '@opening-cross/cross-bounty-client';
import * as graduate from '@opening-cross/cross-graduate-client';
import * as listing from '@opening-cross/cross-listing-client';
import { NoPrintReason, ata, backingAddresses, outcomeAddress, roundAddress } from '@opening-cross/sdk';
import { type Deferred, runOnce } from '../src/index.js';
import { DAY, NOW, World3d, key } from './helpers/world3d.js';

const SPL = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const startsWith = (ix: Instruction, d: ArrayLike<number>) => ix.data !== undefined && Array.from(d).every((b, i) => ix.data![i] === b);
const kinds = (r: Awaited<ReturnType<typeof runOnce>>) => r.done.map((d) => d.action.kind);
const errors = (r: Awaited<ReturnType<typeof runOnce>>) => r.failed.map((f) => `${f.action.kind}: ${f.error}`);

describe('graduation', () => {
  async function voted(o: { closesTs?: bigint; locked?: bigint; tallies?: bigint[]; supply?: bigint } = {}) {
    const w = await World3d.create3d();
    const cross = await w.cross({ state: CrossState.Finalized });
    w.mint(w.base, o.supply ?? 1_000n);
    await w.charter(cross, { rounds: 1, active: true });
    await w.round(cross, { baseMint: w.base, closesTs: o.closesTs ?? NOW - 10n, lockedTotal: o.locked ?? 500n, tallies: o.tallies ?? [0n, 500n, 0n, 0n] });
    return { w, cross };
  }

  it('finalizes a closed round and publishes its outcome in the same pass; a second pass and a restarted keeper find nothing to do', async () => {
    const { w, cross } = await voted();
    const r = await runOnce(w.deps({ duties: 'graduation' }));
    expect(errors(r)).toEqual([]);
    expect(kinds(r)).toEqual(['finalize-round', 'publish-outcome']);
    expect(graduate.getRoundDecoder().decode(w.get(await roundAddress(cross, 0)))).toMatchObject({ finalized: true, passed: true, winner: 1 });
    const outcome = graduate.getOutcomeDecoder().decode(w.get(await outcomeAddress(cross)));
    expect(outcome).toMatchObject({ cross, venue: 1, round: 0 });
    const sent = w.sent.length;
    const again = await runOnce(w.deps({ duties: 'graduation' }));
    expect(again.done).toEqual([]);
    expect(errors(again)).toEqual([]);
    expect(w.sent.length).toBe(sent);
    // a keeper started from nothing reads the same chain and sends nothing
    const restarted = await runOnce(w.deps({ duties: 'graduation', memory: new Map<string, Deferred>() }));
    expect(restarted.done).toEqual([]);
    expect(w.sent.length).toBe(sent);
  });

  it('waits while the window is open, then acts on the second it closes', async () => {
    const { w } = await voted({ closesTs: NOW + 5n });
    const early = await runOnce(w.deps({ duties: 'graduation' }));
    expect(early.done).toEqual([]);
    expect(early.skipped.map((s) => s.code)).toEqual(['GRADUATION_VOTING']);
    w.clock = NOW + 5n;
    expect(kinds(await runOnce(w.deps({ duties: 'graduation' })))).toEqual(['finalize-round', 'publish-outcome']);
  });

  it('finalizes a failed round and says why, publishes nothing, and leaves the next round to the creator', async () => {
    const { w, cross } = await voted({ locked: 300n, tallies: [0n, 300n, 0n, 0n] }); // 30% of 1,000 is under the 40% quorum
    const r = await runOnce(w.deps({ duties: 'graduation' }));
    expect(kinds(r)).toEqual(['finalize-round']);
    expect(w.accounts.has(await outcomeAddress(cross))).toBe(false);
    const again = await runOnce(w.deps({ duties: 'graduation' }));
    expect(again.done).toEqual([]);
    expect(again.skipped[0]).toMatchObject({ code: 'GRADUATION_FAILED' });
    expect(again.skipped[0]!.reason).toMatch(/below the quorum/);
  });

  it('plans a dry run and sends nothing', async () => {
    const { w } = await voted();
    const r = await runOnce(w.deps({ duties: 'graduation', dryRun: true }));
    expect(r.done).toEqual([]);
    expect(r.planned.map((a) => a.kind)).toEqual(['finalize-round']);
    expect(w.sent).toEqual([]);
  });

  it('serves only the crosses of its scope', async () => {
    const { w, cross } = await voted();
    const stranger = await key();
    const r = await runOnce(w.deps({ duties: 'graduation', accept: (c) => c.creator === stranger }));
    expect(r.done).toEqual([]);
    expect(w.sent).toEqual([]);
    expect(kinds(await runOnce(w.deps({ duties: 'graduation', accept: (c) => c.creator === w.payer.address })))).toEqual(['finalize-round', 'publish-outcome']);
    void cross;
  });

  it('is off when not named and on by default', async () => {
    const { w } = await voted();
    expect((await runOnce(w.deps({ duties: 'refunds' }))).done).toEqual([]);
    const byDefault = await runOnce(w.deps({ duties: 'default' }));
    expect(kinds(byDefault)).toEqual(['finalize-round', 'publish-outcome']);
  });

  it('a charter whose program is not on the cluster costs nothing: no accounts, no calls', async () => {
    const w = await World3d.create3d();
    await w.cross({ state: CrossState.Finalized });
    const r = await runOnce(w.deps({ duties: 'graduation,listings,bounties,backing' }));
    expect(r.done).toEqual([]);
    expect(r.failed).toEqual([]);
    expect(w.sent).toEqual([]);
  });
});

describe('listings', () => {
  async function listed(o: { state: CrossState; reason?: NoPrintReason; releaseAfter?: bigint; slashAccount?: boolean; settled?: boolean }) {
    const w = await World3d.create3d();
    const cross = await w.cross({ state: o.state });
    if (o.reason !== undefined) w.patchCross(cross, (c) => ({ ...c, noPrintReason: { __option: 'Some', value: o.reason } }));
    const bondMint = await key();
    const slashTo = await key();
    const venue = await w.venue({ bondMint, slashTo });
    if (o.slashAccount) w.tokenAccount(await ata(slashTo, bondMint, SPL as never), slashTo, bondMint, 0n);
    const l = await w.listed({ venue, lister: w.payer.address, cross, releaseAfter: o.releaseAfter ?? NOW - 1n, ...(o.settled !== undefined && { settled: o.settled }) });
    return { w, cross, venue, bondMint, slashTo, listing: l };
  }

  it('releases a listing whose cross finalized after the delay, once', async () => {
    const { w, listing: l } = await listed({ state: CrossState.Finalized });
    const r = await runOnce(w.deps({ duties: 'listings' }));
    expect(errors(r)).toEqual([]);
    expect(kinds(r)).toEqual(['release-listing']);
    expect(listing.getListingDecoder().decode(w.get(l)).settled).toBe(true);
    const sent = w.sent.length;
    expect((await runOnce(w.deps({ duties: 'listings' }))).done).toEqual([]);
    expect((await runOnce(w.deps({ duties: 'listings', memory: new Map() }))).done).toEqual([]);
    expect(w.sent.length).toBe(sent);
  });

  it('slashes an unbound settlement at once, creating the venue\'s account first when it is missing', async () => {
    const { w, listing: l, slashTo, bondMint } = await listed({ state: CrossState.NoPrint, reason: NoPrintReason.SettlementExpired, releaseAfter: NOW + 30n * DAY });
    const r = await runOnce(w.deps({ duties: 'listings' }));
    expect(errors(r)).toEqual([]);
    expect(kinds(r)).toEqual(['slash-listing']);
    const ixs = w.sent[0]!;
    expect(ixs.map((i) => (i.programAddress === ATA_PROGRAM ? 'create-account' : startsWith(i, listing.SLASH_LISTING_DISCRIMINATOR) ? 'slash' : '?'))).toEqual(['create-account', 'slash']);
    expect(w.accounts.has(await ata(slashTo, bondMint, SPL as never))).toBe(true);
    expect(listing.getListingDecoder().decode(w.get(l)).settled).toBe(true);
    expect((await runOnce(w.deps({ duties: 'listings' }))).done).toEqual([]);
  });

  it('does not create the account when it exists, and does nothing for a cross still open, a market no-print before the delay, or a settled listing', async () => {
    const exists = await listed({ state: CrossState.NoPrint, reason: NoPrintReason.SettlementExpired, slashAccount: true });
    await runOnce(exists.w.deps({ duties: 'listings' }));
    expect(exists.w.sent[0]!.map((i) => i.programAddress)).not.toContain(ATA_PROGRAM);
    for (const [label, o] of [['a cross still open', { state: CrossState.Live }], ['before the delay', { state: CrossState.Finalized, releaseAfter: NOW + 1n }], ['already settled', { state: CrossState.Finalized, settled: true }]] as const) {
      const { w } = await listed(o);
      const r = await runOnce(w.deps({ duties: 'listings' }));
      expect(r.done, label).toEqual([]);
      expect(r.failed, label).toEqual([]);
    }
  });

  it('is not part of the default duties: a keeper pays for the venue\'s account only when told to', async () => {
    const { w } = await listed({ state: CrossState.NoPrint, reason: NoPrintReason.SettlementExpired });
    expect((await runOnce(w.deps({ duties: 'default' }))).done).toEqual([]);
    expect(w.sent).toEqual([]);
    expect((await runOnce(w.deps({ duties: 'listings', dryRun: true }))).planned.map((a) => a.kind)).toEqual(['slash-listing']);
    expect(w.sent).toEqual([]);
  });

  it('reports a program refusal as a failure of that step and keeps going', async () => {
    const { w } = await listed({ state: CrossState.Finalized });
    const deps = w.deps({ duties: 'listings' });
    const r = await runOnce({ ...deps, send: async () => { throw new Error('Error Code: TooEarly'); } });
    expect(r.done).toEqual([]);
    expect(errors(r)).toEqual(['release-listing: Error Code: TooEarly']);
    expect(kinds(await runOnce(w.deps({ duties: 'listings' })))).toEqual(['release-listing']);
  });
});

describe('bounties', () => {
  async function pooled(o: { paidMask?: number; pool?: bigint; expiresAt?: bigint } = {}) {
    const w = await World3d.create3d();
    const rewardMint = await key();
    const b = await w.bounty({ rewardMint, expiresAt: o.expiresAt ?? NOW + 60n * DAY, ...(o.paidMask !== undefined && { paidMask: o.paidMask }), ...(o.pool !== undefined && { pool: o.pool }) });
    return { w, rewardMint, ...b };
  }

  it('claims an invariant a cross account breaks, to the keeper\'s own wallet, once; honest crosses are left alone', async () => {
    const { w, rewardMint, bounty: b, vault } = await pooled();
    const honest = await w.cross({ state: CrossState.Live }); // no orders, no clearing: breaks nothing
    const broken = await w.cross({ state: CrossState.Live });
    w.patchCross(broken, (c) => ({ ...c, ordersTotal: 1, ordersOpen: 3 })); // more open than ever placed: invariant 0
    const r = await runOnce(w.deps({ duties: 'bounties', crosses: async () => [] }));
    expect(errors(r)).toEqual([]);
    expect(kinds(r)).toEqual(['claim-invariant']);
    expect(r.done[0]!.action).toMatchObject({ kind: 'claim-invariant', cross: broken, invariant: 0, bounty: b });
    const mine = await ata(w.payer.address, rewardMint, SPL as never);
    expect(w.balance(mine)).toBe(10n); // invariant 0 pays 10
    expect(w.balance(vault)).toBe(990n);
    expect(bounty.getBountyDecoder().decode(w.get(b)).paidMask).toBe(1);
    // the claimant's token account was created first
    expect(w.sent[0]!.map((i) => (i.programAddress === ATA_PROGRAM ? 'create-account' : startsWith(i, bounty.CLAIM_INVARIANT_DISCRIMINATOR) ? 'claim' : '?'))).toEqual(['create-account', 'claim']);
    // idempotence and restart: the invariant has paid, so there is nothing more to claim
    const sent = w.sent.length;
    expect((await runOnce(w.deps({ duties: 'bounties', crosses: async () => [] }))).done).toEqual([]);
    expect((await runOnce(w.deps({ duties: 'bounties', crosses: async () => [], memory: new Map() }))).done).toEqual([]);
    expect(w.sent.length).toBe(sent);
    void honest;
  });

  it('looks at finalized crosses too (an invariant such as "finalized with an order still open" shows only on one)', async () => {
    const { w } = await pooled();
    const finalized = await w.cross({ state: CrossState.Finalized });
    w.patchCross(finalized, (c) => ({ ...c, ordersTotal: 2, ordersOpen: 1 }));
    // the lifecycle list does not include it; the bounty list does
    const r = await runOnce(w.deps({ duties: 'bounties', crosses: async () => [] }));
    expect(r.done[0]?.action).toMatchObject({ kind: 'claim-invariant', cross: finalized, invariant: 3 });
  });

  it('claims several invariants at once, one per invariant, never the same twice in a pass', async () => {
    const { w } = await pooled();
    const a = await w.cross({ state: CrossState.Live });
    w.patchCross(a, (c) => ({ ...c, ordersTotal: 1, ordersOpen: 3 })); // 0
    const b = await w.cross({ state: CrossState.NoPrint }); // no print with no reason: 2
    const c = await w.cross({ state: CrossState.Live });
    w.patchCross(c, (x) => ({ ...x, ordersTotal: 1, ordersOpen: 5 })); // 0 again
    const r = await runOnce(w.deps({ duties: 'bounties', crosses: async () => [] }));
    expect(r.done.map((d) => (d.action.kind === 'claim-invariant' ? [d.action.cross, d.action.invariant] : null))).toEqual([[a, 0], [b, 2]]);
    void c;
  });

  it('does nothing for an expired bounty, an empty pool, a bounty whose invariants have all paid, or a keeper not told to', async () => {
    const broken = async (w: World3d) => {
      const x = await w.cross({ state: CrossState.Live });
      w.patchCross(x, (c) => ({ ...c, ordersTotal: 1, ordersOpen: 3 }));
    };
    const expired = await pooled({ expiresAt: NOW });
    await broken(expired.w);
    expect((await runOnce(expired.w.deps({ duties: 'bounties' }))).done).toEqual([]);
    const empty = await pooled({ pool: 0n });
    await broken(empty.w);
    const r = await runOnce(empty.w.deps({ duties: 'bounties' }));
    expect(r.done).toEqual([]);
    expect(r.skipped.map((s) => s.code)).toEqual(['BOUNTY_EMPTY']);
    const allPaid = await pooled({ paidMask: (1 << 11) - 1 });
    await broken(allPaid.w);
    expect((await runOnce(allPaid.w.deps({ duties: 'bounties' }))).done).toEqual([]);
    const off = await pooled();
    await broken(off.w);
    expect((await runOnce(off.w.deps({ duties: 'default' }))).done).toEqual([]);
    expect(off.w.sent).toEqual([]);
  });
});

describe('backing', () => {
  async function asset(o: { attestation?: { backingAtoms: bigint; postedTs: bigint } | null; supply?: bigint; halted?: boolean; withHalt?: boolean } = {}) {
    const w = await World3d.create3d();
    const mint = await key();
    w.mint(mint, o.supply ?? 1_000n);
    await w.policy({ mint });
    if (o.attestation) await w.attest(mint, o.attestation.backingAtoms, o.attestation.postedTs);
    const halt = o.withHalt === false ? null : await w.haltState(mint, o.halted ?? false);
    return { w, mint, halt };
  }
  function decodeHalted(bytes: Uint8Array): boolean {
    // discriminator 8, base_mint 32, authority 32, venue_signer None (1), halted (1)
    return bytes[8 + 32 + 32 + 1] === 1;
  }

  it('halts an asset with no statement on anyone\'s call, once, and then only reports it', async () => {
    const { w, mint, halt } = await asset();
    const r = await runOnce(w.deps({ duties: 'backing' }));
    expect(errors(r)).toEqual([]);
    expect(kinds(r)).toEqual(['check-backing']);
    expect(r.done[0]!.action).toMatchObject({ mint, verdict: 'Missing' });
    expect(decodeHalted(w.get(halt!))).toBe(true);
    const a = await backingAddresses(mint);
    expect(w.sent[0]![0]!.accounts!.map((x) => x.address)).toEqual(expect.arrayContaining([a.policy, mint, a.attestation, a.watchdog, a.halt]));
    const sent = w.sent.length;
    const again = await runOnce(w.deps({ duties: 'backing' }));
    expect(again.done).toEqual([]);
    expect(again.skipped.map((s) => s.code)).toEqual(['BACKING_HALTED']);
    expect(w.sent.length).toBe(sent);
    expect((await runOnce(w.deps({ duties: 'backing', memory: new Map() }))).done).toEqual([]);
  });

  it('is on by default, exact at the boundaries, and leaves a backed asset alone', async () => {
    const fresh = { backingAtoms: 1_000n, postedTs: NOW - 60n };
    const ok = await asset({ attestation: fresh });
    expect((await runOnce(ok.w.deps({ duties: 'default' }))).done).toEqual([]);
    expect(ok.w.sent).toEqual([]);
    const atAge = await asset({ attestation: { backingAtoms: 1_000n, postedTs: NOW - 3_600n } });
    expect((await runOnce(atAge.w.deps({ duties: 'default' }))).done).toEqual([]);
    const stale = await asset({ attestation: { backingAtoms: 1_000n, postedTs: NOW - 3_601n } });
    expect((await runOnce(stale.w.deps({ duties: 'default' }))).done[0]!.action).toMatchObject({ verdict: 'Stale' });
    const short = await asset({ attestation: { backingAtoms: 999n, postedTs: NOW } });
    expect((await runOnce(short.w.deps({ duties: 'default' }))).done[0]!.action).toMatchObject({ verdict: 'Short' });
    // new supply makes a covering statement short
    const grown = await asset({ attestation: fresh });
    grown.w.mint(grown.mint, 1_001n);
    expect((await runOnce(grown.w.deps({ duties: 'backing' }))).done[0]!.action).toMatchObject({ verdict: 'Short' });
  });

  it('plans a dry run and sends nothing; does nothing when the duty is not named', async () => {
    const { w } = await asset();
    expect((await runOnce(w.deps({ duties: 'backing', dryRun: true }))).planned.map((a) => a.kind)).toEqual(['check-backing']);
    expect((await runOnce(w.deps({ duties: 'refunds' }))).done).toEqual([]);
    expect(w.sent).toEqual([]);
  });

  it('ignores a statement posted for another asset, and says it could not check when the mint cannot be read', async () => {
    const { w, mint } = await asset({ attestation: { backingAtoms: 1_000n, postedTs: NOW } });
    const other = await key();
    const a = await backingAddresses(mint);
    w.accounts.set(a.attestation, new Uint8Array(backing.getAttestationEncoder().encode({ mint: other, backingAtoms: 1_000n, postedTs: NOW, bump: 255 })));
    expect(kinds(await runOnce(w.deps({ duties: 'backing' })))).toEqual(['check-backing']);
    const unreadable = await asset();
    unreadable.w.accounts.delete(unreadable.mint);
    const r = await runOnce(unreadable.w.deps({ duties: 'backing' }));
    expect(r.done).toEqual([]);
    expect(r.skipped.map((s) => s.code)).toEqual(['BACKING_UNREADABLE']);
  });
});
