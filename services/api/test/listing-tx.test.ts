// cross_listing over HTTP with accounts injected in memory: the release gate, the terms the program refuses, the bond arithmetic, and the verdict on a listing from the state
// of its cross (release, slash or wait). The program is not run here (tests/core/test/listing.test.ts runs it against the real cross_core).
import { describe, expect, it } from 'vitest';
import {
  CREATE_VENUE_DISCRIMINATOR,
  DEPOSIT_BOND_DISCRIMINATOR,
  LIST_CROSS_DISCRIMINATOR,
  OPEN_BOND_DISCRIMINATOR,
  RELEASE_LISTING_DISCRIMINATOR,
  SLASH_LISTING_DISCRIMINATOR,
  WITHDRAW_BOND_DISCRIMINATOR,
  getBondEncoder,
  getCreateVenueInstructionDataDecoder,
  getListingEncoder,
  getVenueEncoder,
  getWithdrawBondInstructionDataDecoder,
} from '@opening-cross/cross-listing-client';
import { CROSS_LISTING_PROGRAM_ADDRESS, CrossState, NoPrintReason, ata, bondAddresses, listingAddress, venueAddress } from '@opening-cross/sdk';
import { registerListingTx } from '../src/routes/listing-tx.js';
import { type Db } from '../src/routes/programs-support.js';
import { Chain, NOW, SPL, caller, database, decode, key, ready, server, startsWith } from './helpers/wave3d.js';

const DAY = 86_400;
const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';

async function fixture() {
  const chain = new Chain();
  const [creator, lister, slashTo, bondMint, quote, stranger] = await Promise.all([key(), key(), key(), key(), key(), key()]);
  chain.mint(bondMint, { decimals: 6 });
  chain.mint(quote, { decimals: 6 });
  chain.deploy('crossListing');
  const venue = await venueAddress(creator, 0n);
  chain.put(venue, CROSS_LISTING_PROGRAM_ADDRESS, getVenueEncoder().encode({ creator, id: 0n, bondMint, bondTokenProgram: SPL, minBond: 100n, releaseDelaySecs: BigInt(2 * DAY), slashTo, bump: 1 }));
  const bonds = await bondAddresses(venue, lister, bondMint, SPL);
  const putBond = (amount: bigint, encumbered = 0n) => chain.put(bonds.bond, CROSS_LISTING_PROGRAM_ADDRESS, getBondEncoder().encode({ venue, lister, amount, encumbered, bump: 1 }));
  putBond(250n);
  await chain.token(lister, bondMint, 1_000n);
  const app = server();
  registerListingTx(app, { account: chain.account, lifetime: chain.lifetime, clock: () => NOW, gate: ready });
  const putListing = async (cross: Awaited<ReturnType<Chain['cross']>>, o: { releaseAfter?: number; settled?: boolean } = {}) => {
    const listing = await listingAddress(venue, cross);
    chain.put(listing, CROSS_LISTING_PROGRAM_ADDRESS, getListingEncoder().encode({ venue, lister, cross, amount: 100n, releaseAfter: BigInt(o.releaseAfter ?? NOW - 1), settled: o.settled ?? false, bump: 1 }));
    return listing;
  };
  return { chain, creator, lister, slashTo, bondMint, quote, stranger, venue, bonds, putBond, putListing, app, ...caller(app) };
}
const programIxs = (tx: string) => decode(tx).filter((i) => i.programAddress === CROSS_LISTING_PROGRAM_ADDRESS);

describe('cross_listing', () => {
  it('refuses every route when the program is not on the cluster, and the reads say so', async () => {
    const f = await fixture();
    const app = server();
    const absent = new Chain();
    registerListingTx(app, { account: absent.account, lifetime: absent.lifetime, clock: () => NOW, db: (await database()).db as Db });
    const c = caller(app);
    const cross = f.venue;
    const bodies: [string, Record<string, unknown>][] = [
      ['listing-create-venue', { creator: f.creator, bondMint: f.bondMint, minBond: '1', releaseDelaySecs: DAY, slashTo: f.slashTo }],
      ['listing-open-bond', { lister: f.lister, venue: f.venue }],
      ['listing-deposit-bond', { lister: f.lister, venue: f.venue, amount: '1' }],
      ['listing-withdraw-bond', { lister: f.lister, venue: f.venue }],
      ['listing-list-cross', { lister: f.lister, venue: f.venue, cross }],
      ['listing-release', { payer: f.lister, listing: cross }],
      ['listing-slash', { payer: f.lister, listing: cross }],
    ];
    for (const [route, body] of bodies) {
      const r = await c.post(`/v1/tx/${route}`, body);
      expect(r.status, route).toBe(409);
      expect(r.body.reason, route).toBe('PROGRAM_NOT_DEPLOYED');
    }
    expect((await c.get(`/v1/listing/venues/${f.venue}`)).body.reason).toBe('PROGRAM_NOT_DEPLOYED');
    expect((await c.get(`/v1/listing/listings/${f.venue}`)).body.reason).toBe('PROGRAM_NOT_DEPLOYED');
    expect((await c.get('/v1/listing/venues')).body).toMatchObject({ venues: [], release: { deployed: false } });
    expect((await c.get(`/v1/crosses/${f.venue}/listings`)).body).toMatchObject({ listings: [], release: { deployed: false } });
  }, 30_000);

  it('creates a venue: terms checked, the next free id, the slash account named and whether it exists', async () => {
    const f = await fixture();
    const ok = await f.post('/v1/tx/listing-create-venue', { creator: f.creator, bondMint: f.bondMint, minBond: '500', releaseDelaySecs: DAY, slashTo: f.slashTo });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toMatchObject({ venue: await venueAddress(f.creator, 1n), id: '1', slashAccount: await ata(f.slashTo, f.bondMint, SPL), slashAccountExists: false });
    const ix = programIxs(ok.body.transaction)[0]!;
    expect(startsWith(ix, CREATE_VENUE_DISCRIMINATOR)).toBe(true);
    expect(getCreateVenueInstructionDataDecoder().decode(ix.data!)).toMatchObject({ id: 1n, minBond: 500n, releaseDelaySecs: BigInt(DAY), slashTo: f.slashTo });
    expect(ok.body.note).toMatch(/does not exist yet/);
    await f.chain.token(f.slashTo, f.bondMint, 0n);
    expect((await f.post('/v1/tx/listing-create-venue', { creator: f.creator, bondMint: f.bondMint, minBond: '500', releaseDelaySecs: DAY, slashTo: f.slashTo })).body.slashAccountExists).toBe(true);
    const bad = async (patch: Record<string, unknown>) => f.post('/v1/tx/listing-create-venue', { creator: f.creator, bondMint: f.bondMint, minBond: '500', releaseDelaySecs: DAY, slashTo: f.slashTo, ...patch });
    expect((await bad({ minBond: '0' })).body.reason).toBe('BAD_TERMS');
    expect((await bad({ releaseDelaySecs: DAY - 1 })).body.reason).toBe('BAD_TERMS');
    expect((await bad({ id: 0 })).body.reason).toBe('ALREADY_EXISTS');
    expect((await bad({ bondMint: await key() })).body.reason).toBe('MINT_NOT_FOUND');
  });

  it('opens a bond once, deposits against the lister\'s balance, and withdraws only the part no listing has set aside', async () => {
    const f = await fixture();
    const stranger = f.stranger;
    await f.chain.token(stranger, f.bondMint, 10n);
    const open = await f.post('/v1/tx/listing-open-bond', { lister: stranger, venue: f.venue });
    expect(open.status).toBe(200);
    expect(startsWith(programIxs(open.body.transaction)[0]!, OPEN_BOND_DISCRIMINATOR)).toBe(true);
    expect((await f.post('/v1/tx/listing-open-bond', { lister: f.lister, venue: f.venue })).body.reason).toBe('ALREADY_EXISTS');
    expect((await f.post('/v1/tx/listing-deposit-bond', { lister: stranger, venue: f.venue, amount: '5' })).body.reason).toBe('NO_BOND');
    const dep = await f.post('/v1/tx/listing-deposit-bond', { lister: f.lister, venue: f.venue, amount: '1000' });
    expect(dep.status).toBe(200);
    expect(dep.body.bondTotalAfter).toBe('1250');
    expect(startsWith(programIxs(dep.body.transaction)[0]!, DEPOSIT_BOND_DISCRIMINATOR)).toBe(true);
    expect((await f.post('/v1/tx/listing-deposit-bond', { lister: f.lister, venue: f.venue, amount: '1001' })).body).toMatchObject({ reason: 'INSUFFICIENT_BALANCE', have: '1000' });
    f.putBond(250n, 100n);
    const w = await f.post('/v1/tx/listing-withdraw-bond', { lister: f.lister, venue: f.venue });
    expect(w.body).toMatchObject({ amount: '150', free: '150', setAside: '100' });
    const ix = programIxs(w.body.transaction)[0]!;
    expect(startsWith(ix, WITHDRAW_BOND_DISCRIMINATOR)).toBe(true);
    expect(getWithdrawBondInstructionDataDecoder().decode(ix.data!).amount).toBe(150n);
    expect((await f.post('/v1/tx/listing-withdraw-bond', { lister: f.lister, venue: f.venue, amount: '151' })).body.reason).toBe('BOND_ENCUMBERED');
    f.putBond(250n, 250n);
    expect((await f.post('/v1/tx/listing-withdraw-bond', { lister: f.lister, venue: f.venue })).body.reason).toBe('BOND_ENCUMBERED');
  });

  it('lists a cross the lister created that still takes orders, when the free bond covers the minimum', async () => {
    const f = await fixture();
    const cross = await f.chain.cross({ creator: f.lister, quoteMint: f.quote });
    const ok = await f.post('/v1/tx/listing-list-cross', { lister: f.lister, venue: f.venue, cross });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toMatchObject({ listing: await listingAddress(f.venue, cross), setAside: '100', releaseAfter: String(NOW + 3600 + 2 * DAY) });
    expect(startsWith(programIxs(ok.body.transaction)[0]!, LIST_CROSS_DISCRIMINATOR)).toBe(true);
    // somebody else's cross
    const theirs = await f.chain.cross({ creator: f.creator, id: 2n, quoteMint: f.quote });
    expect((await f.post('/v1/tx/listing-list-cross', { lister: f.lister, venue: f.venue, cross: theirs })).body.reason).toBe('NOT_THE_CREATOR');
    // a cross that no longer takes orders
    const done = await f.chain.cross({ creator: f.lister, id: 3n, quoteMint: f.quote, state: CrossState.Cleared });
    expect((await f.post('/v1/tx/listing-list-cross', { lister: f.lister, venue: f.venue, cross: done })).body.reason).toBe('CROSS_NOT_LIVE');
    // a free bond one atom short
    f.putBond(250n, 151n);
    expect((await f.post('/v1/tx/listing-list-cross', { lister: f.lister, venue: f.venue, cross })).body.reason).toBe('BOND_TOO_SMALL');
    f.putBond(250n, 150n);
    expect((await f.post('/v1/tx/listing-list-cross', { lister: f.lister, venue: f.venue, cross })).status).toBe(200);
    // listed twice
    await f.putListing(cross);
    expect((await f.post('/v1/tx/listing-list-cross', { lister: f.lister, venue: f.venue, cross })).body.reason).toBe('ALREADY_LISTED');
    expect((await f.post('/v1/tx/listing-list-cross', { lister: f.stranger, venue: f.venue, cross })).body.reason).toBe('NO_BOND');
  });

  it('releases after the delay for a cross that ended well, slashes for an unbound settlement, and says which when asked for the wrong one', async () => {
    const f = await fixture();
    const finalized = await f.chain.cross({ creator: f.lister, id: 10n, quoteMint: f.quote, baseMint: f.bondMint, state: CrossState.Finalized });
    const l1 = await f.putListing(finalized);
    const rel = await f.post('/v1/tx/listing-release', { payer: f.stranger, listing: l1 });
    expect(rel.status, JSON.stringify(rel.body)).toBe(200);
    expect(rel.body).toMatchObject({ amount: '100', to: f.lister });
    expect(startsWith(programIxs(rel.body.transaction)[0]!, RELEASE_LISTING_DISCRIMINATOR)).toBe(true);
    expect((await f.post('/v1/tx/listing-slash', { payer: f.stranger, listing: l1 })).body).toMatchObject({ reason: 'USE_RELEASE', verdict: 'release' });
    // before the delay
    const early = await f.putListing(finalized, { releaseAfter: NOW + 10 });
    expect((await f.post('/v1/tx/listing-release', { payer: f.stranger, listing: early })).body).toMatchObject({ reason: 'NOT_ENDED', verdict: 'wait' });
    // a no-print for a market reason releases
    const market = await f.chain.cross({ creator: f.lister, id: 11n, quoteMint: f.quote, state: CrossState.NoPrint, noPrintReason: NoPrintReason.NoCross });
    expect((await f.post('/v1/tx/listing-release', { payer: f.stranger, listing: await f.putListing(market) })).status).toBe(200);
    // an unbound settlement slashes, at once (no delay), and creates the venue's account when it is missing
    const fault = await f.chain.cross({ creator: f.lister, id: 12n, quoteMint: f.quote, state: CrossState.NoPrint, noPrintReason: NoPrintReason.SettlementExpired });
    const l2 = await f.putListing(fault, { releaseAfter: NOW + 10 * DAY });
    const slash = await f.post('/v1/tx/listing-slash', { payer: f.stranger, listing: l2 });
    expect(slash.status, JSON.stringify(slash.body)).toBe(200);
    expect(slash.body).toMatchObject({ amount: '100', to: f.slashTo, slashAccount: await ata(f.slashTo, f.bondMint, SPL), createsSlashAccount: true });
    const ixs = decode(slash.body.transaction);
    expect(ixs.map((i) => (i.programAddress === ATA_PROGRAM ? 'ata' : startsWith(i, SLASH_LISTING_DISCRIMINATOR) ? 'slash' : '?'))).toEqual(['ata', 'slash']);
    expect((await f.post('/v1/tx/listing-release', { payer: f.stranger, listing: l2 })).body).toMatchObject({ reason: 'USE_SLASH', verdict: 'slash' });
    await f.chain.token(f.slashTo, f.bondMint, 0n);
    expect(decode((await f.post('/v1/tx/listing-slash', { payer: f.stranger, listing: l2 })).body.transaction).some((i) => i.programAddress === ATA_PROGRAM)).toBe(false);
    // already settled
    const settled = await f.putListing(finalized, { settled: true });
    expect((await f.post('/v1/tx/listing-release', { payer: f.stranger, listing: settled })).body.reason).toBe('ALREADY_SETTLED');
  });

  it('reads a venue with a lister\'s bond, a listing with what can be done with it, and the index', async () => {
    const f = await fixture();
    const v = await f.get(`/v1/listing/venues/${f.venue}?lister=${f.lister}`);
    expect(v.body).toMatchObject({ venue: f.venue, minBond: '100', releaseDelaySecs: String(2 * DAY), bond: { total: '250', setAside: '0', free: '250', fitsAnother: true } });
    f.putBond(250n, 200n);
    expect((await f.get(`/v1/listing/venues/${f.venue}?lister=${f.lister}`)).body.bond).toMatchObject({ free: '50', fitsAnother: false });
    expect((await f.get(`/v1/listing/venues/${f.venue}?lister=${f.stranger}`)).body.bond).toEqual({ opened: false });
    const finalized = await f.chain.cross({ creator: f.lister, id: 20n, quoteMint: f.quote, state: CrossState.Finalized });
    const l = await f.putListing(finalized);
    expect((await f.get(`/v1/listing/listings/${l}`)).body).toMatchObject({ listing: l, crossState: 'Finalized', next: 'release', amount: '100' });
    const { db, pg } = await database();
    const app = server();
    registerListingTx(app, { account: f.chain.account, lifetime: f.chain.lifetime, clock: () => NOW, gate: ready, db: db as Db });
    const c = caller(app);
    await pg.query(`INSERT INTO listing_venues (venue, creator, bond_mint, min_bond, release_delay_secs, slash_to, created_slot) VALUES ($1,$2,$3,100,172800,$4,1)`, [f.venue, f.creator, f.bondMint, f.slashTo]);
    await pg.query(`INSERT INTO listing_listings (listing, venue, lister, cross_address, amount, status, created_slot) VALUES ($1,$2,$3,$4,100,'open',2), ($5,$2,$3,$6,100,'slashed',3)`, [l, f.venue, f.lister, finalized, f.slashTo, f.quote]);
    expect((await c.get('/v1/listing/venues')).body.venues[0]).toMatchObject({ venue: f.venue, listings: 2, openListings: 1 });
    expect((await c.get(`/v1/listing/venues/${f.venue}/listings`)).body.listings.map((x: { status: string }) => x.status)).toEqual(['slashed', 'open']);
    expect((await c.get(`/v1/crosses/${finalized}/listings`)).body.listings).toHaveLength(1);
  }, 30_000);
});
