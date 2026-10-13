// cross_settle over HTTP: unsigned transactions for the partner payouts of a DBC continuation (ADR-0480, ADR-0481) and the greenshoe (ADR-0487).
//
// The API never holds a key. Every transaction comes back unsigned with the named wallet as fee payer; every check the program would make that can be
// made from chain state is made first. These instructions exist only in the cross_settle build that is NOT deployed on devnet yet (docs/HUMAN_TASKS.md H27).
// The instructions that open a venue (`open_dbc_pool_locked`, `seed_damm_v2_batched`, `open_dlmm_pair_batched`, `open_dlmm_pair_badged`, ...) take a pool design
// as their input and are built with `@opening-cross/adapters` by the issuer's tooling, not through this API.
//
//   POST /v1/tx/claim-partner-fee                  { cross, payer, maxBase?, maxQuote? }            the partner's trading fees to the fee recipient
//   POST /v1/tx/withdraw-partner-surplus           { cross, payer }                                 after migration: the partner's share of the surplus quote to the issuer's proceeds
//   POST /v1/tx/withdraw-partner-migration-fee     { cross, payer }                                 after migration: the partner's slice of the migration fee to the fee recipient
//   POST /v1/tx/claim-partner-pool-creation-fee    { cross, payer }                                 the pool-creation fee, in lamports, to the fee recipient
//   POST /v1/tx/claim-pol-fees                     { cross, payer, pool, position, positionNftAccount, tokenAMint, tokenBMint, tokenAVault, tokenBVault }   fees of the protocol-owned liquidity position to the issuer's proceeds
//   POST /v1/tx/create-greenshoe                   { cross, creator, budget, startTs, periodSecs, periodCap }   commit a budget to standing bids under the clearing price
//   POST /v1/tx/deploy-greenshoe-bid               { cross, payer, limitOrder, level, amount, binId? }   place one level; `limitOrder` is a fresh keypair that also signs; the bin is the one nearest the level's price
//   POST /v1/tx/settle-greenshoe-level             { cross, payer, level, hook? }                   after the week: cancel a level, run the transfer hook, close the order
//   POST /v1/tx/finish-greenshoe                   { cross, payer }                                 burn what the bids bought, return the unspent budget to the issuer
import type { FastifyInstance, FastifyReply } from 'fastify';
import { type Address, createNoopSigner, getAddressEncoder, getProgramDerivedAddress } from '@solana/kit';
import { CROSS_DISCRIMINATOR, CROSS_CORE_PROGRAM_ADDRESS, CrossState, readRuledCross, type CrossView } from '@opening-cross/sdk';
import { CROSS_SETTLE_PROGRAM_ADDRESS, GREENSHOE_DISCRIMINATOR, getGreenshoeDecoder } from '@opening-cross/cross-settle-client';
import { type Lifetime, RequestError, compile } from '../tx.js';
import { addr, int, json, obj, opt, u64, i64 } from './_inputs.js';

type ChainAccount = { data: Uint8Array; owner: Address };
export type SettleTxDeps = {
  account: (a: Address) => Promise<ChainAccount | null>;
  lifetime: () => Promise<Lifetime>;
  /** Unix seconds; defaults to the wall clock. Tests inject one. */
  clock?: () => number;
};

const send = (reply: FastifyReply, v: unknown, status = 200) => reply.code(status).type('application/json').send(json(v));
const starts = (data: Uint8Array, prefix: ArrayLike<number>) => data.length >= prefix.length && Array.from(prefix).every((b, i) => data[i] === b);
const DLMM = 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo' as Address;
const ZERO = '11111111111111111111111111111111' as Address;
/** Loaded on first use: the adapters package pulls in Meteora's SDK, which the rest of the API does not need. */
const adapters = () => import('@opening-cross/adapters');

export function registerSettleTx(app: FastifyInstance, d: SettleTxDeps): void {
  const now = () => BigInt(d.clock?.() ?? Math.floor(Date.now() / 1000));

  async function readCross(a: Address): Promise<CrossView> {
    const acct = await d.account(a);
    if (!acct) throw new RequestError(404, `cross ${a} not found on chain`);
    if (acct.owner !== CROSS_CORE_PROGRAM_ADDRESS || !starts(acct.data, CROSS_DISCRIMINATOR)) throw new RequestError(404, `${a} is not an Opening Cross account`);
    return readRuledCross(a, acct.data);
  }
  const greenshoeOf = async (cross: Address) => (await getProgramDerivedAddress({ programAddress: CROSS_SETTLE_PROGRAM_ADDRESS, seeds: [new TextEncoder().encode('greenshoe'), getAddressEncoder().encode(cross)] }))[0];
  async function readGreenshoe(cross: Address) {
    const acct = await d.account(await greenshoeOf(cross));
    if (!acct || acct.owner !== CROSS_SETTLE_PROGRAM_ADDRESS || !starts(acct.data, GREENSHOE_DISCRIMINATOR)) throw new RequestError(404, `cross ${cross} has no greenshoe`, { reason: 'NO_GREENSHOE' });
    return getGreenshoeDecoder().decode(acct.data);
  }
  /** A DLMM pair's bin step and active bin, from the account (offsets 80 and 76 after the discriminator and the two parameter blocks). */
  async function readPair(lbPair: Address) {
    const acct = await d.account(lbPair);
    if (!acct || acct.owner !== DLMM || acct.data.length < 82) throw new RequestError(409, 'The cross has no DLMM pair: open it with open_dlmm_pair first.', { reason: 'NO_DLMM_PAIR' });
    const v = new DataView(acct.data.buffer, acct.data.byteOffset);
    return { activeId: v.getInt32(76, true), binStep: v.getUint16(80, true) };
  }
  const settled = (c: CrossView) => {
    if (c.data.state === CrossState.Live) throw new RequestError(409, 'The cross has not settled yet.', { reason: 'LIVE' });
  };
  const bound = (c: CrossView) => {
    if (!c.data.baseBound || c.data.baseMint === ZERO) throw new RequestError(409, 'The cross has no base mint yet: open and bind the DBC pool first.', { reason: 'NO_BASE_MINT' });
  };
  const body = async (req: { body: unknown }) => {
    const b = obj(req.body);
    return { b, cross: await readCross(addr(b.cross, 'cross')), payer: addr(b.payer, 'payer') };
  };

  app.post('/v1/tx/claim-partner-fee', async (req, reply) => {
    const { b, cross, payer } = await body(req);
    settled(cross);
    bound(cross);
    const { buildClaimPartnerFee } = await adapters();
    const maxBase = opt(b.maxBase, (v) => u64(v, 'maxBase'));
    const maxQuote = opt(b.maxQuote, (v) => u64(v, 'maxQuote'));
    const ix = await buildClaimPartnerFee({ cross, ...(maxBase !== null && { maxBase }), ...(maxQuote !== null && { maxQuote }) }).catch((e: Error) => {
      throw new RequestError(409, e.message);
    });
    return send(reply, { ...compile(payer, [ix], await d.lifetime()), recipient: cross.data.feeRecipient });
  });

  app.post('/v1/tx/withdraw-partner-surplus', async (req, reply) => {
    const { cross, payer } = await body(req);
    settled(cross);
    const { buildWithdrawPartnerSurplus } = await adapters();
    return send(reply, { ...compile(payer, [await buildWithdrawPartnerSurplus(cross)], await d.lifetime()), recipient: cross.data.proceedsTo });
  });

  app.post('/v1/tx/withdraw-partner-migration-fee', async (req, reply) => {
    const { cross, payer } = await body(req);
    settled(cross);
    const { buildWithdrawPartnerMigrationFee } = await adapters();
    return send(reply, { ...compile(payer, [await buildWithdrawPartnerMigrationFee(cross)], await d.lifetime()), recipient: cross.data.feeRecipient });
  });

  app.post('/v1/tx/claim-partner-pool-creation-fee', async (req, reply) => {
    const { cross, payer } = await body(req);
    settled(cross);
    const { buildClaimPartnerPoolCreationFee } = await adapters();
    return send(reply, { ...compile(payer, [await buildClaimPartnerPoolCreationFee(cross)], await d.lifetime()), recipient: cross.data.feeRecipient });
  });

  app.post('/v1/tx/claim-pol-fees', async (req, reply) => {
    const { b, cross, payer } = await body(req);
    settled(cross);
    bound(cross);
    const { buildClaimPolFees } = await adapters();
    const ix = await buildClaimPolFees({
      cross,
      pool: addr(b.pool, 'pool'),
      position: addr(b.position, 'position'),
      positionNftAccount: addr(b.positionNftAccount, 'positionNftAccount'),
      tokenAMint: addr(b.tokenAMint, 'tokenAMint'),
      tokenBMint: addr(b.tokenBMint, 'tokenBMint'),
      tokenAVault: addr(b.tokenAVault, 'tokenAVault'),
      tokenBVault: addr(b.tokenBVault, 'tokenBVault'),
    });
    return send(reply, { ...compile(payer, [ix], await d.lifetime()), recipient: cross.data.proceedsTo });
  });

  // ---------------------------------------------------------------- greenshoe
  app.post('/v1/tx/create-greenshoe', async (req, reply) => {
    const b = obj(req.body);
    const cross = await readCross(addr(b.cross, 'cross'));
    const creator = addr(b.creator, 'creator');
    if (cross.data.state !== CrossState.Finalized) throw new RequestError(409, 'A greenshoe follows a finalized cross.', { reason: 'NOT_FINALIZED' });
    if (creator !== cross.data.creator) throw new RequestError(422, `Only the cross's creator, ${cross.data.creator}, can commit a greenshoe.`, { reason: 'NOT_THE_CREATOR' });
    const { buildCreateGreenshoe, greenshoeMinBudget, dlmmAddresses } = await adapters();
    const budget = u64(b.budget, 'budget');
    const minBudget = greenshoeMinBudget(cross.data.buyerPaid);
    if (budget < minBudget) throw new RequestError(422, `The budget is at least 10% of what buyers paid: ${minBudget} of ${cross.data.buyerPaid}.`, { reason: 'BUDGET_TOO_SMALL', minBudget });
    const startTs = i64(b.startTs, 'startTs');
    if (startTs < now()) throw new RequestError(422, 'The greenshoe window starts now or later.', { reason: 'START_IN_PAST' });
    if (await d.account(await greenshoeOf(cross.address))) throw new RequestError(409, 'This cross has a greenshoe already.', { reason: 'GREENSHOE_EXISTS' });
    await readPair(dlmmAddresses(cross.data.baseMint, cross.data.quoteMint).lbPair);
    const ix = await buildCreateGreenshoe({ cross, creator: createNoopSigner(creator), budget, startTs, periodSecs: i64(b.periodSecs, 'periodSecs'), periodCap: u64(b.periodCap, 'periodCap') });
    return send(reply, { ...compile(creator, [ix], await d.lifetime()), minBudget });
  });

  app.post('/v1/tx/deploy-greenshoe-bid', async (req, reply) => {
    const { b, cross, payer } = await body(req);
    const g = await readGreenshoe(cross.address);
    const limitOrder = addr(b.limitOrder, 'limitOrder');
    const level = int(b.level, 'level', 2);
    const amount = u64(b.amount, 'amount');
    const { buildDeployGreenshoeBid, greenshoeBinFor, greenshoeLevelCap, dlmmAddresses } = await adapters();
    if (g.finished) throw new RequestError(409, 'This greenshoe is finished.', { reason: 'FINISHED' });
    if (now() < g.startTs) throw new RequestError(409, `The window opens at ${g.startTs}.`, { reason: 'NOT_STARTED', startTs: g.startTs });
    if (now() >= g.expiresTs) throw new RequestError(409, 'The window has ended.', { reason: 'EXPIRED' });
    if (g.orders[level] !== ZERO) throw new RequestError(409, `Level ${level} is placed already.`, { reason: 'LEVEL_PLACED' });
    if (amount === 0n || amount > greenshoeLevelCap(g.budget)) throw new RequestError(422, `A level holds at most ${greenshoeLevelCap(g.budget)} (a third of the budget, rounded up).`, { reason: 'OVER_LEVEL_CAP', cap: greenshoeLevelCap(g.budget) });
    if (amount > g.budget - g.deployed) throw new RequestError(422, `Only ${g.budget - g.deployed} of the budget is left.`, { reason: 'OVER_BUDGET', left: g.budget - g.deployed });
    const pair = await readPair(dlmmAddresses(cross.data.baseMint, cross.data.quoteMint).lbPair);
    const binId = b.binId === undefined ? greenshoeBinFor(g.referencePrice, g.priceScale, pair.binStep, level) : int(b.binId, 'binId', 2 ** 31 - 1, -(2 ** 31));
    if (binId >= pair.activeId) throw new RequestError(422, `A bid sits below the active bin (${pair.activeId}).`, { reason: 'BIN_NOT_BELOW_ACTIVE', activeId: pair.activeId });
    const ix = await buildDeployGreenshoeBid({ cross, payer: createNoopSigner(payer), limitOrder: createNoopSigner(limitOrder), level, binId, amount });
    return send(reply, { ...compile(payer, [ix], await d.lifetime()), binId, level });
  });

  app.post('/v1/tx/settle-greenshoe-level', async (req, reply) => {
    const { b, cross, payer } = await body(req);
    const g = await readGreenshoe(cross.address);
    const level = int(b.level, 'level', 2);
    if (now() < g.expiresTs) throw new RequestError(409, `The bids stand until ${g.expiresTs}.`, { reason: 'NOT_EXPIRED', expiresTs: g.expiresTs });
    if (g.orders[level] === ZERO) throw new RequestError(409, `Level ${level} was never placed.`, { reason: 'LEVEL_NOT_PLACED' });
    if (g.levelSettled[level]) throw new RequestError(409, `Level ${level} is settled already.`, { reason: 'ALREADY_SETTLED' });
    const { buildSettleGreenshoeLevel } = await adapters();
    const ix = await buildSettleGreenshoeLevel({ cross, rentReceiver: payer, level, limitOrder: g.orders[level]!, binId: g.bins[level]!, ...(b.hook === undefined ? {} : { hook: b.hook === true }) });
    return send(reply, compile(payer, [ix], await d.lifetime()));
  });

  app.post('/v1/tx/finish-greenshoe', async (req, reply) => {
    const { cross, payer } = await body(req);
    const g = await readGreenshoe(cross.address);
    if (g.finished) throw new RequestError(409, 'This greenshoe is finished.', { reason: 'FINISHED' });
    if (now() < g.expiresTs) throw new RequestError(409, `The bids stand until ${g.expiresTs}.`, { reason: 'NOT_EXPIRED', expiresTs: g.expiresTs });
    const open = g.orders.map((o, i) => (o !== ZERO && !g.levelSettled[i] ? i : -1)).filter((i) => i >= 0);
    if (open.length > 0) throw new RequestError(409, `Levels ${open.join(', ')} are still to be settled before the greenshoe can finish.`, { reason: 'LEVELS_OPEN', levels: open });
    const { buildFinishGreenshoe } = await adapters();
    return send(reply, { ...compile(payer, [await buildFinishGreenshoe(cross)], await d.lifetime()), toIssuer: cross.data.proceedsTo });
  });
}
