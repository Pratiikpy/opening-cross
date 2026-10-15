// cross_listing over HTTP (L1; ADR-0653): a venue with fixed terms, a lister's bond, listing of a cross the lister created, release after the delay and a slash to the
// venue's account when the cross ended because its settlement never happened. Unsigned transactions and reads. The program is NOT deployed to devnet until
// the operations key is funded (docs/HUMAN_TASKS.md H27, H43).
//
//   POST /v1/tx/listing-create-venue    { creator, bondMint, minBond, releaseDelaySecs, slashTo, id? }
//   POST /v1/tx/listing-open-bond       { lister, venue }                         the lister's empty bond account on a venue
//   POST /v1/tx/listing-deposit-bond    { lister, venue, amount }
//   POST /v1/tx/listing-withdraw-bond   { lister, venue, amount? }                only the part no open listing has set aside; default all of it
//   POST /v1/tx/listing-list-cross      { lister, venue, cross }                  a cross the lister created that still takes orders; sets aside the venue's minBond
//   POST /v1/tx/listing-release         { payer, listing }                        anyone, once the cross ended well and the delay passed
//   POST /v1/tx/listing-slash           { payer, listing }                        anyone, when the cross ended because its settlement never happened
//   GET  /v1/listing/venues             the index of venues
//   GET  /v1/listing/venues/:venue      the venue's terms from chain, and the bond of ?lister=
//   GET  /v1/listing/listings/:address  one listing with its cross and what can be done with it now (release, slash or wait)
//   GET  /v1/crosses/:address/listings  the venues that listed a cross (the index)
//   GET  /v1/listing/venues/:venue/listings  the venue's listings (the index)
import type { FastifyInstance, FastifyReply } from 'fastify';
import { type Address, createNoopSigner } from '@solana/kit';
import {
  BOND_DISCRIMINATOR,
  CREATE_VENUE_DISCRIMINATOR,
  DEPOSIT_BOND_DISCRIMINATOR,
  LIST_CROSS_DISCRIMINATOR,
  LISTING_DISCRIMINATOR,
  OPEN_BOND_DISCRIMINATOR,
  RELEASE_LISTING_DISCRIMINATOR,
  SLASH_LISTING_DISCRIMINATOR,
  VENUE_DISCRIMINATOR,
  WITHDRAW_BOND_DISCRIMINATOR,
  getBondDecoder,
  getListingDecoder,
  getVenueDecoder,
} from '@opening-cross/cross-listing-client';
import {
  CROSS_LISTING_PROGRAM_ADDRESS,
  CrossState,
  LISTING_MIN_RELEASE_DELAY_SECS,
  TOKEN_2022_PROGRAM,
  ata,
  bondAddresses,
  buildCreateVenue,
  buildDepositBond,
  buildListCross,
  buildOpenBond,
  buildReleaseListing,
  buildSlashListing,
  buildWithdrawBond,
  checkListing,
  checkVenueTerms,
  listingAddress,
  listingVerdict,
  venueAddress,
} from '@opening-cross/sdk';
import { type Lifetime, RequestError } from '../tx.js';
import { addr, i64, json, obj, only, opt, u64 } from './_inputs.js';
import { hasActiveTransferHook } from './meteora-tx.js';
import { type AccountReader, type Db, type ProgramRelease, building, failIf, mintOf, oneTx, programRelease, readAccount, readCross, releaseNote, requireNew, tokenBalance } from './programs-support.js';

export type ListingTxDeps = {
  account: AccountReader;
  lifetime: () => Promise<Lifetime>;
  db?: Db;
  clock?: () => number;
  gate?: ProgramRelease;
};

const send = (reply: FastifyReply, v: unknown, status = 200) => reply.code(status).type('application/json').send(json(v));
const MAX_ID_PROBES = 64;

export function registerListingTx(app: FastifyInstance, d: ListingTxDeps): void {
  const now = () => BigInt(d.clock?.() ?? Math.floor(Date.now() / 1000));
  const gate = d.gate ?? programRelease({ account: d.account, ...(d.clock && { clock: d.clock }) });
  const need = (name: string, discriminator: Uint8Array) => requireNew(gate, 'crossListing', { name, discriminator });
  const tx = async (payer: Address, ixs: Parameters<typeof oneTx>[1], what: string) => oneTx(payer, ixs, await d.lifetime(), what);

  async function readVenue(address: Address) {
    const { value } = await readAccount(d.account, address, { owner: CROSS_LISTING_PROGRAM_ADDRESS, disc: VENUE_DISCRIMINATOR as Uint8Array, decode: (b) => getVenueDecoder().decode(b), what: 'listing venue', reason: 'NO_SUCH_VENUE' });
    if ((await venueAddress(value.creator, value.id)) !== address) throw new RequestError(404, `${address} is not a venue at its own address`, { reason: 'NO_SUCH_VENUE' });
    return value;
  }
  async function readBond(venue: Address, lister: Address, venueData: Awaited<ReturnType<typeof readVenue>>) {
    const a = await bondAddresses(venue, lister, venueData.bondMint, venueData.bondTokenProgram);
    const { value } = await readAccount(d.account, a.bond, { owner: CROSS_LISTING_PROGRAM_ADDRESS, disc: BOND_DISCRIMINATOR as Uint8Array, decode: (b) => getBondDecoder().decode(b), what: 'listing bond', reason: 'NO_BOND' });
    return { account: value, address: a.bond, vault: a.vault };
  }
  async function readListing(address: Address) {
    const { value } = await readAccount(d.account, address, { owner: CROSS_LISTING_PROGRAM_ADDRESS, disc: LISTING_DISCRIMINATOR as Uint8Array, decode: (b) => getListingDecoder().decode(b), what: 'listing', reason: 'NO_SUCH_LISTING' });
    return value;
  }
  const lister = (who: Address, bondLister: Address) => {
    if (who !== bondLister) throw new RequestError(422, `${who} is not the lister of this bond (${bondLister}).`, { reason: 'NOT_THE_LISTER' });
  };

  app.post('/v1/tx/listing-create-venue', async (req, reply) => {
    const b = obj(req.body);
    only(b, ['creator', 'bondMint', 'minBond', 'releaseDelaySecs', 'slashTo', 'id'], 'listing-create-venue');
    const creator = addr(b.creator, 'creator');
    const bondMint = addr(b.bondMint, 'bondMint');
    const minBond = u64(b.minBond, 'minBond');
    const releaseDelaySecs = i64(b.releaseDelaySecs, 'releaseDelaySecs');
    const slashTo = addr(b.slashTo, 'slashTo');
    const release = await need('create_venue', CREATE_VENUE_DISCRIMINATOR as Uint8Array);
    failIf(checkVenueTerms(minBond, releaseDelaySecs), 'The venue terms are not valid');
    const m = await mintOf(d.account, bondMint, 'bondMint');
    if (m.tokenProgram === TOKEN_2022_PROGRAM && hasActiveTransferHook(m.data)) throw new RequestError(422, `The bond mint ${bondMint} runs a transfer hook on every transfer. The bond is built here without hook accounts. Refused.`, { reason: 'MINT_HAS_TRANSFER_HOOK', mint: bondMint });
    let id = opt(b.id, (v) => u64(v, 'id'));
    if (id === null) {
      for (let i = 0n; i < BigInt(MAX_ID_PROBES) && id === null; i++) if (!(await d.account(await venueAddress(creator, i)))) id = i;
      if (id === null) throw new RequestError(409, `The creator already has ${MAX_ID_PROBES} venues from id 0; name an id.`, { reason: 'ID_RANGE_FULL' });
    } else if (await d.account(await venueAddress(creator, id))) {
      throw new RequestError(409, `The creator already has a venue with id ${id}.`, { reason: 'ALREADY_EXISTS', id });
    }
    const built = await building(() => buildCreateVenue({ creator: createNoopSigner(creator), id: id!, bondMint, bondTokenProgram: m.tokenProgram, minBond, releaseDelaySecs, slashTo }));
    const slashAccount = await ata(slashTo, bondMint, m.tokenProgram);
    const slashReady = (await d.account(slashAccount)) !== null;
    return send(reply, {
      ...(await tx(creator, [built.instruction], 'venue creation')),
      venue: built.venue,
      id,
      slashAccount,
      slashAccountExists: slashReady,
      note: `The terms never change. A slashed bond goes to ${slashAccount}${slashReady ? '' : ', which does not exist yet; whoever sends the slash creates it first'}. The release delay is at least ${LISTING_MIN_RELEASE_DELAY_SECS} seconds after a cross closes.`,
      release,
    });
  });

  app.post('/v1/tx/listing-open-bond', async (req, reply) => {
    const b = obj(req.body);
    only(b, ['lister', 'venue'], 'listing-open-bond');
    const who = addr(b.lister, 'lister');
    const release = await need('open_bond', OPEN_BOND_DISCRIMINATOR as Uint8Array);
    const venueAddr = addr(b.venue, 'venue');
    const v = await readVenue(venueAddr);
    const a = await bondAddresses(venueAddr, who, v.bondMint, v.bondTokenProgram);
    if (await d.account(a.bond)) throw new RequestError(409, 'This wallet already has a bond on this venue.', { reason: 'ALREADY_EXISTS', bond: a.bond });
    const built = await building(() => buildOpenBond({ lister: createNoopSigner(who), venue: venueAddr, bondMint: v.bondMint, bondTokenProgram: v.bondTokenProgram }));
    return send(reply, { ...(await tx(who, [built.instruction], 'bond opening')), bond: built.bond, vault: built.vault, release });
  });

  app.post('/v1/tx/listing-deposit-bond', async (req, reply) => {
    const b = obj(req.body);
    only(b, ['lister', 'venue', 'amount'], 'listing-deposit-bond');
    const who = addr(b.lister, 'lister');
    const amount = u64(b.amount, 'amount');
    const release = await need('deposit_bond', DEPOSIT_BOND_DISCRIMINATOR as Uint8Array);
    const venueAddr = addr(b.venue, 'venue');
    const v = await readVenue(venueAddr);
    const { account: bond } = await readBond(venueAddr, who, v).catch((e) => {
      if (e instanceof RequestError && e.detail?.reason === 'NO_BOND') throw new RequestError(409, 'Open a bond on this venue first (listing-open-bond).', { reason: 'NO_BOND' });
      throw e;
    });
    const have = await tokenBalance(d.account, await ata(who, v.bondMint, v.bondTokenProgram));
    if (have === null || have < amount) throw new RequestError(422, `${who} holds ${have ?? 0n} of the bond token; ${amount} was asked for.`, { reason: 'INSUFFICIENT_BALANCE', have: have ?? 0n, need: amount });
    const ix = await building(() => buildDepositBond({ lister: createNoopSigner(who), venue: venueAddr, bondMint: v.bondMint, bondTokenProgram: v.bondTokenProgram, amount }));
    return send(reply, { ...(await tx(who, [ix], 'bond deposit')), bondTotalAfter: bond.amount + amount, release });
  });

  app.post('/v1/tx/listing-withdraw-bond', async (req, reply) => {
    const b = obj(req.body);
    only(b, ['lister', 'venue', 'amount'], 'listing-withdraw-bond');
    const who = addr(b.lister, 'lister');
    const release = await need('withdraw_bond', WITHDRAW_BOND_DISCRIMINATOR as Uint8Array);
    const venueAddr = addr(b.venue, 'venue');
    const v = await readVenue(venueAddr);
    const { account: bond } = await readBond(venueAddr, who, v);
    const free = bond.amount - bond.encumbered;
    const amount = opt(b.amount, (x) => u64(x, 'amount')) ?? free;
    if (amount === 0n) throw new RequestError(409, 'No part of the bond is free: open listings have set it all aside.', { reason: 'BOND_ENCUMBERED', free });
    const ix = await building(() => buildWithdrawBond({ lister: createNoopSigner(who), venue: venueAddr, bondMint: v.bondMint, bondTokenProgram: v.bondTokenProgram, amount, bond }));
    return send(reply, { ...(await tx(who, [ix], 'bond withdrawal')), amount, free, setAside: bond.encumbered, release });
  });

  app.post('/v1/tx/listing-list-cross', async (req, reply) => {
    const b = obj(req.body);
    only(b, ['lister', 'venue', 'cross'], 'listing-list-cross');
    const who = addr(b.lister, 'lister');
    const release = await need('list_cross', LIST_CROSS_DISCRIMINATOR as Uint8Array);
    const venueAddr = addr(b.venue, 'venue');
    const v = await readVenue(venueAddr);
    const { account: bond } = await readBond(venueAddr, who, v).catch((e) => {
      if (e instanceof RequestError && e.detail?.reason === 'NO_BOND') throw new RequestError(409, 'Open a bond and deposit at least the venue\'s minimum first.', { reason: 'NO_BOND', minBond: v.minBond });
      throw e;
    });
    const cross = await readCross(d.account, addr(b.cross, 'cross'));
    const existing = await listingAddress(venueAddr, cross.address);
    if (await d.account(existing)) throw new RequestError(409, 'This cross is already listed on this venue.', { reason: 'ALREADY_LISTED', listing: existing });
    failIf(checkListing({ lister: who, cross, venue: v, bond }), 'The listing would be refused');
    const built = await building(() => buildListCross({ lister: createNoopSigner(who), venue: venueAddr, cross: cross.address }));
    return send(reply, {
      ...(await tx(who, [built.instruction], 'listing')),
      listing: built.listing,
      setAside: v.minBond,
      releaseAfter: cross.data.closeTs + v.releaseDelaySecs,
      note: 'The bond is released after the delay if the cross ends well, and slashed to the venue if it ends because its settlement never happened.',
      release,
    });
  });

  async function settle(reply: FastifyReply, body: unknown, action: 'release' | 'slash') {
    const b = obj(body);
    only(b, ['payer', 'listing'], `listing-${action}`);
    const payer = addr(b.payer, 'payer');
    const rel = action === 'release' ? await need('release_listing', RELEASE_LISTING_DISCRIMINATOR as Uint8Array) : await need('slash_listing', SLASH_LISTING_DISCRIMINATOR as Uint8Array);
    const address = addr(b.listing, 'listing');
    const l = await readListing(address);
    const v = await readVenue(l.venue);
    const cross = await readCross(d.account, l.cross);
    const verdict = listingVerdict({ listing: l, cross: cross.data, now: now() });
    if (verdict !== action) {
      const why: Record<string, string> = {
        settled: 'This listing was already released or slashed.',
        wait: action === 'release' ? `The cross has not ended in a way that releases the bond, or the delay has not passed (it releases from ${l.releaseAfter}).` : 'The cross did not end because its settlement never happened, so there is nothing to slash.',
        release: 'The cross ended well: its bond is released, not slashed.',
        slash: 'The cross ended because its settlement never happened: its bond is slashed, not released.',
      };
      throw new RequestError(409, why[verdict]!, { reason: verdict === 'settled' ? 'ALREADY_SETTLED' : verdict === 'wait' ? (action === 'release' ? 'NOT_ENDED' : 'NO_FAULT') : verdict === 'release' ? 'USE_RELEASE' : 'USE_SLASH', verdict, releaseAfter: l.releaseAfter });
    }
    const a = await bondAddresses(l.venue, l.lister, v.bondMint, v.bondTokenProgram);
    if (action === 'release') {
      return send(reply, { ...(await tx(payer, [buildReleaseListing({ listing: address, lister: l.lister, venue: l.venue, bond: a.bond, cross: l.cross })], 'release')), listing: address, amount: l.amount, to: l.lister, release: rel });
    }
    const slashAccount = await ata(v.slashTo, v.bondMint, v.bondTokenProgram);
    const exists = (await d.account(slashAccount)) !== null;
    const ixs = await building(() => buildSlashListing({ payer: createNoopSigner(payer), listing: address, lister: l.lister, venue: l.venue, slashTo: v.slashTo, cross: l.cross, bondMint: v.bondMint, bondTokenProgram: v.bondTokenProgram, createSlashAccount: !exists }));
    return send(reply, { ...(await tx(payer, ixs, 'slash')), listing: address, amount: l.amount, to: v.slashTo, slashAccount, createsSlashAccount: !exists, release: rel });
  }
  app.post('/v1/tx/listing-release', async (req, reply) => settle(reply, req.body, 'release'));
  app.post('/v1/tx/listing-slash', async (req, reply) => settle(reply, req.body, 'slash'));

  // ---------------------------------------------------------------- reads
  app.get('/v1/listing/venues/:venue', async (req, reply) => {
    const address = addr((req.params as { venue: string }).venue, 'venue');
    const release = await releaseNote(gate, 'crossListing');
    if (release.deployed === false) throw new RequestError(404, `venue ${address} not found: ${release.note}`, { reason: 'PROGRAM_NOT_DEPLOYED', release });
    const v = await readVenue(address);
    const who = (req.query as { lister?: string }).lister;
    let bond = null;
    if (who !== undefined) {
      const l = addr(who, 'lister');
      const read = await readBond(address, l, v).catch((e) => (e instanceof RequestError && e.detail?.reason === 'NO_BOND' ? null : Promise.reject(e)));
      bond = read
        ? { address: read.address, vault: read.vault, total: read.account.amount, setAside: read.account.encumbered, free: read.account.amount - read.account.encumbered, fitsAnother: read.account.amount - read.account.encumbered >= v.minBond }
        : { opened: false };
    }
    return send(reply, {
      venue: address,
      creator: v.creator,
      id: v.id,
      bondMint: v.bondMint,
      bondTokenProgram: v.bondTokenProgram,
      minBond: v.minBond,
      releaseDelaySecs: v.releaseDelaySecs,
      slashTo: v.slashTo,
      slashAccount: await ata(v.slashTo, v.bondMint, v.bondTokenProgram),
      ...(bond && { bond }),
      release,
    });
  });

  app.get('/v1/listing/venues', async (req, reply) => {
    const q = req.query as { creator?: string; limit?: string };
    const creator = q.creator === undefined ? null : addr(q.creator, 'creator');
    const limit = q.limit === undefined ? 50 : Math.min(200, Math.max(1, Number.parseInt(q.limit, 10) || 50));
    const release = await releaseNote(gate, 'crossListing');
    const rows = d.db ? (await d.db.query(`SELECT v.*, (SELECT count(*)::int FROM listing_listings l WHERE l.venue = v.venue) AS listings, (SELECT count(*)::int FROM listing_listings l WHERE l.venue = v.venue AND l.status = 'open') AS open_listings FROM listing_venues v WHERE ($1::text IS NULL OR v.creator = $1) ORDER BY v.created_slot DESC LIMIT $2`, [creator, limit])).rows : [];
    return send(reply, {
      venues: rows.map((r) => ({ venue: r.venue, creator: r.creator, bondMint: r.bond_mint, minBond: String(r.min_bond), releaseDelaySecs: Number(r.release_delay_secs), slashTo: r.slash_to, listings: r.listings, openListings: r.open_listings })),
      release,
      ...(release.deployed === false && { note: release.note }),
    });
  });

  app.get('/v1/listing/venues/:venue/listings', async (req, reply) => {
    const venue = addr((req.params as { venue: string }).venue, 'venue');
    const release = await releaseNote(gate, 'crossListing');
    const rows = d.db ? (await d.db.query(`SELECT * FROM listing_listings WHERE venue = $1 ORDER BY created_slot DESC LIMIT 200`, [venue])).rows : [];
    return send(reply, { venue, listings: rows.map(listingRow), release });
  });

  app.get('/v1/crosses/:address/listings', async (req, reply) => {
    const cross = addr((req.params as { address: string }).address, 'address');
    const release = await releaseNote(gate, 'crossListing');
    const rows = d.db ? (await d.db.query(`SELECT * FROM listing_listings WHERE cross_address = $1 ORDER BY created_slot DESC LIMIT 100`, [cross])).rows : [];
    return send(reply, { cross, listings: rows.map(listingRow), release });
  });

  app.get('/v1/listing/listings/:address', async (req, reply) => {
    const address = addr((req.params as { address: string }).address, 'address');
    const release = await releaseNote(gate, 'crossListing');
    if (release.deployed === false) throw new RequestError(404, `listing ${address} not found: ${release.note}`, { reason: 'PROGRAM_NOT_DEPLOYED', release });
    const l = await readListing(address);
    const cross = await readCross(d.account, l.cross).catch(() => null);
    const verdict = cross ? listingVerdict({ listing: l, cross: cross.data, now: now() }) : null;
    return send(reply, {
      listing: address,
      venue: l.venue,
      lister: l.lister,
      cross: l.cross,
      crossState: cross ? CrossState[cross.data.state] : null,
      amount: l.amount,
      releaseAfter: l.releaseAfter,
      settled: l.settled,
      next: verdict,
      release,
    });
  });
}

function listingRow(r: Record<string, unknown>) {
  return { listing: r.listing, venue: r.venue, lister: r.lister, cross: r.cross_address, amount: String(r.amount), status: r.status, slashedTo: r.slashed_to ?? null, createdSlot: String(r.created_slot) };
}
