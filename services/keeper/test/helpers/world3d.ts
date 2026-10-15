// An in-memory chain for the keeper's Wave 3D duties, on top of the lifecycle world: accounts of cross_graduate, cross_listing, cross_bounty and cross_backing are bytes in the map, and `send`
// applies the effect of each instruction the keeper sends (a round finalizes, an outcome appears, a listing settles, an invariant pays, an asset halts) with the program's own refusals, so a
// second pass reads what the first one did and a call the program would refuse fails here too. It is the programs' behaviour as far as the keeper depends on it, written from
// programs/cross_graduate, cross_listing, cross_bounty and cross_backing and the pure functions of @opening-cross/sdk, and not the programs themselves.
import { type Address, type Instruction, none, some } from '@solana/kit';
import { type Cross, getCrossDecoder, getHaltStateDecoder, getHaltStateEncoder, haltStateAddress } from '@opening-cross/cross-core-client';
import * as backing from '@opening-cross/cross-backing-client';
import * as bounty from '@opening-cross/cross-bounty-client';
import * as graduate from '@opening-cross/cross-graduate-client';
import * as listing from '@opening-cross/cross-listing-client';
import { ata, backingAddresses, backingVerdict, bondAddresses, bountyAddresses, crossViolates, decideRound, listingVerdict, outcomeAddress, roundAddress } from '@opening-cross/sdk';
import { type KeeperDeps } from '../../src/index.js';
import { NOW, World, key } from './world.js';

export { NOW, key };
export const DAY = 86_400n;
const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const SPL = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' as Address;
const eq = (a: ArrayLike<number> | undefined, b: ArrayLike<number>) => a !== undefined && Array.from(b).every((v, i) => a[i] === v);

export class World3d extends World {
  charterList: Address[] = [];
  listingList: Address[] = [];
  bountyList: Address[] = [];
  policyList: Address[] = [];

  static async create3d(): Promise<World3d> {
    const w = new World3d();
    w.payer = (await World.create()).payer;
    w.base = await key();
    w.quote = await key();
    return w;
  }

  // ------------------------------------------------------------------------------------------------------------ token accounts and mints

  mint(address: Address, supply: bigint, decimals = 6): Address {
    const data = new Uint8Array(82);
    new DataView(data.buffer).setBigUint64(36, supply, true);
    data[44] = decimals;
    data[45] = 1;
    this.accounts.set(address, data);
    return address;
  }
  tokenAccount(address: Address, owner: Address, mint: Address, amount: bigint): Address {
    const data = new Uint8Array(165);
    new DataView(data.buffer).setBigUint64(64, amount, true);
    this.accounts.set(address, data);
    void owner;
    void mint;
    return address;
  }
  balance(address: Address): bigint {
    return new DataView(this.get(address).buffer).getBigUint64(64, true);
  }

  // ------------------------------------------------------------------------------------------------------------ cross_graduate

  async charter(cross: Address, o: { rounds?: number; active?: boolean; passed?: boolean; creator?: Address } = {}): Promise<Address> {
    const address = await graduate.findCharterPda({ cross }).then(([a]) => a);
    this.accounts.set(address, new Uint8Array(graduate.getCharterEncoder().encode({ cross, creator: o.creator ?? this.payer.address, quorumBps: 4_000, windowSecs: 7n * DAY, minVolume: 0n, volumeAttester: none(), rounds: o.rounds ?? 0, active: o.active ?? false, passed: o.passed ?? false, bump: 255 })));
    if (!this.charterList.includes(address)) this.charterList.push(address);
    return address;
  }
  async round(cross: Address, o: { index?: number; baseMint: Address; closesTs: bigint; tallies?: bigint[]; lockedTotal?: bigint; quorumBps?: number; finalized?: boolean; passed?: boolean; winner?: number; minVolume?: bigint; volume?: bigint }): Promise<Address> {
    const index = o.index ?? 0;
    const address = await roundAddress(cross, index);
    this.accounts.set(
      address,
      new Uint8Array(
        graduate.getRoundEncoder().encode({
          cross, index, baseMint: o.baseMint, baseTokenProgram: SPL, opensTs: o.closesTs - 7n * DAY, closesTs: o.closesTs, quorumBps: o.quorumBps ?? 4_000, minVolume: o.minVolume ?? 0n, volumeAttester: o.minVolume ? some(this.payer.address) : none(),
          tallies: o.tallies ?? [0n, 0n, 0n, 0n], lockedTotal: o.lockedTotal ?? 0n, volumeQuote: o.volume ?? 0n, volumeSet: o.volume !== undefined, finalized: o.finalized ?? false, passed: o.passed ?? false, winner: o.winner ?? 0, bump: 255,
        }),
      ),
    );
    return address;
  }

  // ------------------------------------------------------------------------------------------------------------ cross_listing

  async venue(o: { id?: bigint; bondMint: Address; slashTo: Address; minBond?: bigint; releaseDelaySecs?: bigint }): Promise<Address> {
    const id = o.id ?? 0n;
    const address = await listing.findVenuePda({ creator: this.payer.address, id }).then(([a]) => a);
    this.accounts.set(address, new Uint8Array(listing.getVenueEncoder().encode({ creator: this.payer.address, id, bondMint: o.bondMint, bondTokenProgram: SPL, minBond: o.minBond ?? 100n, releaseDelaySecs: o.releaseDelaySecs ?? 2n * DAY, slashTo: o.slashTo, bump: 255 })));
    return address;
  }
  async listed(o: { venue: Address; lister: Address; cross: Address; amount?: bigint; releaseAfter: bigint; settled?: boolean }): Promise<Address> {
    const address = await listing.findListingPda({ venue: o.venue, cross: o.cross }).then(([a]) => a);
    this.accounts.set(address, new Uint8Array(listing.getListingEncoder().encode({ venue: o.venue, lister: o.lister, cross: o.cross, amount: o.amount ?? 100n, releaseAfter: o.releaseAfter, settled: o.settled ?? false, bump: 255 })));
    if (!this.listingList.includes(address)) this.listingList.push(address);
    return address;
  }

  // ------------------------------------------------------------------------------------------------------------ cross_bounty

  async bounty(o: { rewardMint: Address; expiresAt: bigint; rewards?: bigint[]; paidMask?: number; pool?: bigint; id?: bigint }): Promise<{ bounty: Address; vault: Address }> {
    const id = o.id ?? 0n;
    const sponsor = this.payer.address;
    const a = await bountyAddresses(sponsor, id, o.rewardMint, SPL);
    this.accounts.set(a.bounty, new Uint8Array(bounty.getBountyEncoder().encode({ sponsor, id, arbiter: sponsor, rewardMint: o.rewardMint, tokenProgram: SPL, expiresAt: o.expiresAt, rewards: o.rewards ?? Array.from({ length: 11 }, (_, i) => BigInt(10 * (i + 1))), paidMask: o.paidMask ?? 0, awarded: 0n, bump: 255 })));
    this.tokenAccount(a.vault, a.bounty, o.rewardMint, o.pool ?? 1_000n);
    if (!this.bountyList.includes(a.bounty)) this.bountyList.push(a.bounty);
    return a;
  }

  // ------------------------------------------------------------------------------------------------------------ cross_backing

  async policy(o: { mint: Address; attester?: Address; minCoverageBps?: number; maxAgeSecs?: bigint }): Promise<Address> {
    const a = await backingAddresses(o.mint);
    this.accounts.set(a.policy, new Uint8Array(backing.getPolicyEncoder().encode({ mint: o.mint, attester: o.attester ?? this.payer.address, minCoverageBps: o.minCoverageBps ?? 10_000, maxAgeSecs: o.maxAgeSecs ?? 3_600n, bump: 255 })));
    if (!this.policyList.includes(a.policy)) this.policyList.push(a.policy);
    return a.policy;
  }
  async attest(mint: Address, backingAtoms: bigint, postedTs: bigint): Promise<void> {
    const a = await backingAddresses(mint);
    this.accounts.set(a.attestation, new Uint8Array(backing.getAttestationEncoder().encode({ mint, backingAtoms, postedTs, bump: 255 })));
  }
  async haltState(mint: Address, halted = false): Promise<Address> {
    const address = await haltStateAddress(mint);
    const padded = new Uint8Array(512);
    padded.set(getHaltStateEncoder().encode({ baseMint: mint, authority: this.payer.address, venueSigner: none(), halted, reason: halted ? 2 : 0, corporateAction: false, sinceTs: 0n, sinceSlot: 0n, issuerUnpaused: false, breaker: none(), lastResumeCross: none(), lastResumePrice: 0n, lastResumeTs: 0n, bump: 255 } as never));
    this.accounts.set(address, padded);
    return address;
  }

  // ------------------------------------------------------------------------------------------------------------ the chain's answer

  private apply3d(ix: Instruction): void {
    const data = ix.data;
    if (!data) return;
    const at = (i: number) => ix.accounts![i]!.address;
    if (ix.programAddress === ATA_PROGRAM) {
      // create_associated_token_account_idempotent: payer, ata, owner, mint, ...
      if (!this.accounts.has(at(1))) this.tokenAccount(at(1), at(2), at(3), 0n);
      return;
    }
    if (ix.programAddress === graduate.CROSS_GRADUATE_PROGRAM_ADDRESS) {
      if (eq(data, graduate.FINALIZE_ROUND_DISCRIMINATOR)) {
        const [roundAddr, charterAddr, mint] = [at(0), at(1), at(2)];
        const r = graduate.getRoundDecoder().decode(this.get(roundAddr));
        if (r.finalized) throw new Error('Error Code: NotVoting');
        if (this.clock < r.closesTs) throw new Error('Error Code: WindowOpen');
        const supply = new DataView(this.get(mint).buffer).getBigUint64(36, true);
        const winner = decideRound({ lockedTotal: r.lockedTotal, supply, quorumBps: r.quorumBps, tallies: r.tallies, minVolume: r.minVolume, volume: r.volumeSet ? r.volumeQuote : null });
        this.accounts.set(roundAddr, new Uint8Array(graduate.getRoundEncoder().encode({ ...r, finalized: true, passed: winner !== null, winner: winner ?? 0 })));
        const c = graduate.getCharterDecoder().decode(this.get(charterAddr));
        this.accounts.set(charterAddr, new Uint8Array(graduate.getCharterEncoder().encode({ ...c, active: false, passed: winner !== null })));
      } else if (eq(data, graduate.PUBLISH_OUTCOME_DISCRIMINATOR)) {
        const [roundAddr, outcome] = [at(1), at(2)];
        const r = graduate.getRoundDecoder().decode(this.get(roundAddr));
        if (!r.finalized || !r.passed) throw new Error('Error Code: NotPassed');
        if (this.accounts.has(outcome)) throw new Error('account already in use');
        this.accounts.set(outcome, new Uint8Array(graduate.getOutcomeEncoder().encode({ cross: r.cross, venue: r.winner, round: r.index, publishedTs: this.clock, bump: 255 })));
      }
      return;
    }
    if (ix.programAddress === listing.CROSS_LISTING_PROGRAM_ADDRESS) {
      const isRelease = eq(data, listing.RELEASE_LISTING_DISCRIMINATOR);
      const isSlash = eq(data, listing.SLASH_LISTING_DISCRIMINATOR);
      if (!isRelease && !isSlash) return;
      const listingAddr = at(0);
      const l = listing.getListingDecoder().decode(this.get(listingAddr));
      const cross = getCrossDecoder().decode(this.get(l.cross));
      const verdict = listingVerdict({ listing: l, cross, now: this.clock });
      if (verdict === 'settled') throw new Error('Error Code: AlreadySettled');
      if (verdict !== (isRelease ? 'release' : 'slash')) throw new Error(`Error Code: ${isRelease ? 'NotEnded' : 'NoFault'}`);
      if (isSlash) {
        // the slash account must exist: the keeper creates it first when it does not
        if (!this.accounts.has(at(7))) throw new Error('AccountNotInitialized: slash_account');
      }
      this.accounts.set(listingAddr, new Uint8Array(listing.getListingEncoder().encode({ ...l, settled: true })));
      return;
    }
    if (ix.programAddress === bounty.CROSS_BOUNTY_PROGRAM_ADDRESS && eq(data, bounty.CLAIM_INVARIANT_DISCRIMINATOR)) {
      const [bountyAddr, crossAddr, vault, claimant] = [at(1), at(3), at(4), at(5)];
      const b = bounty.getBountyDecoder().decode(this.get(bountyAddr));
      const invariant = data[8]!;
      if (this.clock >= b.expiresAt) throw new Error('Error Code: Expired');
      if (invariant >= 11) throw new Error('Error Code: UnknownInvariant');
      if (b.rewards[invariant]! === 0n) throw new Error('Error Code: NotCovered');
      if ((b.paidMask & (1 << invariant)) !== 0) throw new Error('Error Code: AlreadyPaid');
      const cross = getCrossDecoder().decode(this.get(crossAddr));
      if (!crossViolates(invariant, cross)) throw new Error('Error Code: NoViolation');
      const held = this.balance(vault);
      const pay = b.rewards[invariant]! < held ? b.rewards[invariant]! : held;
      if (pay === 0n) throw new Error('Error Code: PoolEmpty');
      if (!this.accounts.has(claimant)) throw new Error('AccountNotInitialized: claimant_token');
      new DataView(this.get(vault).buffer).setBigUint64(64, held - pay, true);
      new DataView(this.get(claimant).buffer).setBigUint64(64, this.balance(claimant) + pay, true);
      this.accounts.set(bountyAddr, new Uint8Array(bounty.getBountyEncoder().encode({ ...b, paidMask: b.paidMask | (1 << invariant) })));
      return;
    }
    if (ix.programAddress === backing.CROSS_BACKING_PROGRAM_ADDRESS && eq(data, backing.CHECK_DISCRIMINATOR)) {
      const [policyAddr, mint, attestation, , halt] = [at(0), at(1), at(2), at(3), at(4)];
      const p = backing.getPolicyDecoder().decode(this.get(policyAddr));
      const supply = new DataView(this.get(mint).buffer).getBigUint64(36, true);
      const raw = this.accounts.get(attestation);
      const decoded = raw && eq(raw, backing.ATTESTATION_DISCRIMINATOR) ? backing.getAttestationDecoder().decode(raw) : null;
      const att = decoded && decoded.mint === mint ? decoded : null; // the program reads a statement only if it names this mint
      const verdict = backingVerdict({ attestation: att, supply, now: this.clock, minCoverageBps: p.minCoverageBps, maxAgeSecs: p.maxAgeSecs });
      if (verdict === 'Backed') throw new Error('Error Code: Backed');
      const h = getHaltStateDecoder().decode(this.get(halt));
      if (!h.halted) this.get(halt).set(getHaltStateEncoder().encode({ ...h, halted: true, reason: 2, sinceTs: this.clock } as never));
    }
  }

  // ------------------------------------------------------------------------------------------------------------ the keeper's dependencies

  override deps(over: Partial<KeeperDeps> & { duties?: string } = {}): KeeperDeps {
    const base = super.deps(over);
    const send = base.send;
    return {
      ...base,
      // the lifecycle of crosses has its own suites; these duties are tested on their own
      crosses: async () => [],
      charters: async () => this.charterList,
      listings: async () => this.listingList,
      bounties: async () => this.bountyList,
      bountyCrosses: async () => this.crosses.filter((c) => this.accounts.has(c)),
      policies: async () => this.policyList,
      ...over,
      send: async (ixs) => {
        for (const ix of ixs) this.apply3d(ix);
        return (over.send ?? send)(ixs);
      },
      duties: base.duties!,
    };
  }

  /** Helpers for tests that read the crosses the world holds. */
  crossData(a: Address): Cross {
    return getCrossDecoder().decode(this.get(a));
  }
}

export { bondAddresses, ata, outcomeAddress };
