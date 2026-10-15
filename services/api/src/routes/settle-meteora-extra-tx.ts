// The Meteora routes that go beyond the vaults of `meteora-tx.ts` (ADR-0911 to 0916; rows X13, D1, D3, D5, W10, B4): DAMM v2 reward slots and joining the pool as a
// liquidity provider, the conviction ladder as DLMM limit orders and its rebalance, the buyer's side of the fixed-price tranche, and the demand-calibrated curve.
// Unsigned transactions; the API holds no key. Every route reads the chain first and refuses with a reason in words; nothing here is a `cross_settle` instruction, so the
// release check is whether the external program exists on the cluster (409 EXTERNAL_PROGRAM_MISSING otherwise).
//
// DAMM v2 reward slots (the pool creator opens slot 0; its funder streams a reward to every position in proportion to liquidity)
//   GET  /v1/crosses/:address/damm-rewards
//   POST /v1/tx/damm-reward-init               { cross, signer, rewardMint, durationSecs, funder?, payer?, index? }
//   POST /v1/tx/damm-reward-fund               { cross, funder, amount, carryForward?, index? }
//   POST /v1/tx/damm-reward-claim              { cross, owner, position?, index? }       position: an outside holder's position (default: the issuer's)
//   POST /v1/tx/damm-reward-update-funder      { cross, signer, newFunder, index? }
//   POST /v1/tx/damm-reward-update-duration    { cross, signer, durationSecs, index? }
//   POST /v1/tx/damm-reward-withdraw-ineligible{ cross, funder, index? }
//   POST /v1/tx/damm-lp-join                   { cross, owner, positionNftMint, shareBps, slippageBps? }
// The conviction ladder on the DLMM pair
//   GET  /v1/crosses/:address/ladder?position=
//   POST /v1/tx/ladder-limit-place             { cross, owner, limitOrder, baseAmount, count?, shape?, spacing?, firstOffset? }
//   POST /v1/tx/ladder-limit-cancel            { cross, owner, limitOrder, binIds }
//   POST /v1/tx/ladder-limit-close             { cross, owner, limitOrder, rentReceiver? }
//   POST /v1/tx/ladder-rebalance-withdraw      { cross, owner, position }
//   POST /v1/tx/ladder-rebalance-relay         { cross, owner, newPosition, baseAmount, bins?, shape?, lockUntil? }
//   POST /v1/tx/ladder-position-place          the same route under the name of the first placement; `lockUntil` (unix seconds) makes the ladder impossible to withdraw before then,
//                                              and is allowed only while the pair is still closed (Meteora refuses it once the pair has opened)
// The fixed-price tranche (opened by open-fixed-price-presale)
//   POST /v1/tx/presale-deposit                { cross, base, buyer, amount }
//   POST /v1/tx/presale-claim                  { cross, base, buyer }
//   POST /v1/tx/presale-creator-withdraw       { cross, base, creator }
// The curve
//   POST /v1/curve/calibrate                   { cross? | clearingPrice?, bids: [{ price, quantity }], segments?, headroomBps?, floorBps? }
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { type Address, type Instruction, createNoopSigner, getAddressDecoder } from '@solana/kit';
import { getCreateAssociatedTokenIdempotentInstruction } from '@solana-program/token';
import { type CrossView, ata } from '@opening-cross/sdk';
import { RequestError } from '../tx.js';
import { addr, bool, int, list, obj, only, opt, u64 } from './_inputs.js';
import { requireProgram } from './program-gate.js';

type ChainAccount = { data: Uint8Array; owner: Address };
type Adapters = typeof import('@opening-cross/adapters');
export type MeteoraExtraContext = {
  account: (a: Address) => Promise<ChainAccount | null>;
  now: () => bigint;
  send: (reply: FastifyReply, v: unknown, status?: number) => FastifyReply;
  adapters: () => Promise<Adapters>;
  readCross: (a: Address) => Promise<CrossView>;
  marketOf: (c: CrossView) => void;
  mintProgram: (mint: Address, role?: string) => Promise<{ tokenProgram: Address; data: Uint8Array }>;
  tokenBalance: (owner: Address, mint: Address, tokenProgram: Address, role: string, need: bigint) => Promise<void>;
  owns: (tokenAccount: Address) => Promise<Address | null>;
  gateHook: (baseMint: Address, sourceOwner: Address, destinationOwner: Address) => Promise<{ address: Address }[] | null>;
  sized: (payer: Address, ixs: Instruction[], what: string) => { ixs: Instruction[]; bytes: number };
  transaction: (payer: Address, ixs: Instruction[], extra: Record<string, unknown>) => Promise<unknown>;
};

export function registerMeteoraExtras(app: FastifyInstance, c: MeteoraExtraContext): void {
  const { send, adapters, readCross, marketOf, sized, transaction } = c;
  const uint = (v: unknown, field: string, max: number, min = 0) => int(v, field, max, min);

  // ---------------------------------------------------------------------------------------------------------------------------- DAMM v2 reward slots
  async function dammOf(cross: CrossView) {
    const a = await adapters();
    marketOf(cross);
    await requireProgram(c.account, a.DAMM_V2_PROGRAM_ADDRESS, 'Meteora DAMM v2');
    const damm = await a.dammAddresses(cross.address, cross.data.baseMint, cross.data.quoteMint);
    const acct = await c.account(damm.pool);
    const pool = acct && acct.owner === a.DAMM_V2_PROGRAM_ADDRESS ? a.decodeDammPoolRewards(acct.data) : null;
    if (!pool) throw new RequestError(409, `The cross has no DAMM v2 pool at ${damm.pool}: seed one first.`, { reason: 'NO_POOL', pool: damm.pool });
    return { a, damm, pool };
  }
  const slotIndex = (v: unknown) => (v === undefined ? 0 : uint(v, 'index', 1));

  app.get('/v1/crosses/:address/damm-rewards', async (req, reply) => {
    const cross = await readCross(addr((req.params as { address: string }).address, 'address'));
    const { a, damm, pool } = await dammOf(cross);
    const now = c.now();
    return send(reply, {
      cross: cross.address,
      pool: damm.pool,
      creator: pool.creator,
      liquidity: pool.liquidity,
      minDurationSecs: a.DAMM_REWARD_MIN_DURATION,
      maxDurationSecs: a.DAMM_REWARD_MAX_DURATION,
      slots: pool.slots.map((s) => ({
        ...s,
        streaming: s.initialized && s.endsAt > now,
        // Reward atoms per second as a whole number, from the program's Q64.64 rate.
        perSecond: s.rate >> 64n,
        secondsLeft: s.endsAt > now ? s.endsAt - now : 0n,
      })),
      note: 'The pool creator may open slot 0; slot 1 needs a Meteora operator. A slot streams one token to every position in proportion to its liquidity, including the issuer\'s own.',
    });
  });

  app.post('/v1/tx/damm-reward-init', async (req, reply) => {
    const b = obj(req.body);
    only(b, ['cross', 'signer', 'payer', 'rewardMint', 'durationSecs', 'funder', 'index'], 'damm-reward-init');
    const cross = await readCross(addr(b.cross, 'cross'));
    const signer = addr(b.signer, 'signer');
    const payer = opt(b.payer, (v) => addr(v, 'payer')) ?? signer;
    const rewardMint = addr(b.rewardMint, 'rewardMint');
    const durationSecs = u64(b.durationSecs, 'durationSecs');
    const index = slotIndex(b.index);
    const { a, damm, pool } = await dammOf(cross);
    const funder = opt(b.funder, (v) => addr(v, 'funder')) ?? signer;
    if (index === 1) throw new RequestError(422, 'Slot 1 can only be opened by a Meteora operator; the pool creator opens slot 0.', { reason: 'SLOT_1_NEEDS_OPERATOR' });
    if (signer !== pool.creator) throw new RequestError(422, `Only the pool's creator, ${pool.creator}, can open slot 0.`, { reason: 'NOT_THE_POOL_CREATOR', creator: pool.creator });
    if (pool.slots[index]!.initialized) throw new RequestError(409, `Slot ${index} is open already (it streams ${pool.slots[index]!.mint}); fund it, or change its duration or funder.`, { reason: 'SLOT_IN_USE', slot: pool.slots[index] });
    if (durationSecs < BigInt(a.DAMM_REWARD_MIN_DURATION) || durationSecs > BigInt(a.DAMM_REWARD_MAX_DURATION)) {
      throw new RequestError(422, `A reward streams over ${a.DAMM_REWARD_MIN_DURATION} to ${a.DAMM_REWARD_MAX_DURATION} seconds (one day to one year); ${durationSecs} was given.`, { reason: 'DURATION_OUT_OF_RANGE', min: a.DAMM_REWARD_MIN_DURATION, max: a.DAMM_REWARD_MAX_DURATION });
    }
    const { tokenProgram } = await c.mintProgram(rewardMint, 'reward mint');
    const ix = a.buildInitializeDammReward({ pool: damm.pool, signer: createNoopSigner(signer), payer: createNoopSigner(payer), rewardMint, tokenProgram, index, durationSecs, funder });
    const { ixs, bytes } = sized(payer, [ix], 'reward slot opening');
    return send(reply, await transaction(payer, ixs, { bytes, pool: damm.pool, index, rewardVault: a.dammRewardVaultAddress(damm.pool, index), funder, durationSecs, note: `Slot ${index} will stream ${rewardMint} over ${durationSecs} seconds from each funding. Only ${funder} can fund it.` }));
  });

  app.post('/v1/tx/damm-reward-fund', async (req, reply) => {
    const b = obj(req.body);
    only(b, ['cross', 'funder', 'amount', 'carryForward', 'index'], 'damm-reward-fund');
    const cross = await readCross(addr(b.cross, 'cross'));
    const funder = addr(b.funder, 'funder');
    const amount = u64(b.amount, 'amount');
    if (amount === 0n) throw new RequestError(400, 'amount must be above zero');
    const index = slotIndex(b.index);
    const carryForward = opt(b.carryForward, (v) => bool(v, 'carryForward')) ?? false;
    const { a, damm, pool } = await dammOf(cross);
    const slot = pool.slots[index]!;
    if (!slot.initialized) throw new RequestError(409, `Slot ${index} is not open: open it with damm-reward-init first.`, { reason: 'SLOT_NOT_OPEN' });
    if (funder !== slot.funder) throw new RequestError(422, `Only the slot's funder, ${slot.funder}, can fund it.`, { reason: 'NOT_THE_FUNDER', funder: slot.funder });
    const { tokenProgram } = await c.mintProgram(slot.mint, 'reward mint');
    await c.tokenBalance(funder, slot.mint, tokenProgram, 'reward', amount);
    const ix = await a.buildFundDammReward({ pool: damm.pool, funder: createNoopSigner(funder), rewardMint: slot.mint, tokenProgram, index, amount, carryForward });
    const { ixs, bytes } = sized(funder, [ix], 'reward funding');
    const running = slot.endsAt > c.now();
    return send(reply, await transaction(funder, ixs, { bytes, pool: damm.pool, index, rewardMint: slot.mint, durationSecs: slot.durationSecs, perSecond: amount / slot.durationSecs, running, note: running ? (carryForward ? 'A stream is running: what has not streamed yet is added to this amount and the stream restarts over the slot\'s duration.' : 'A stream is running: the program adds this amount to it.') : `The stream starts now and runs ${slot.durationSecs} seconds.` }));
  });

  app.post('/v1/tx/damm-reward-claim', async (req, reply) => {
    const b = obj(req.body);
    only(b, ['cross', 'owner', 'position', 'index'], 'damm-reward-claim');
    const cross = await readCross(addr(b.cross, 'cross'));
    const owner = addr(b.owner, 'owner');
    const index = slotIndex(b.index);
    const { a, damm, pool } = await dammOf(cross);
    const slot = pool.slots[index]!;
    if (!slot.initialized) throw new RequestError(409, `Slot ${index} is not open, so there is nothing to claim.`, { reason: 'SLOT_NOT_OPEN' });
    let position = damm.position;
    let positionNftAccount = damm.positionNftAccount;
    if (b.position !== undefined) {
      position = addr(b.position, 'position');
      const acct = await c.account(position);
      if (!acct || acct.owner !== a.DAMM_V2_PROGRAM_ADDRESS || acct.data.length < 72) throw new RequestError(404, `${position} is not a DAMM v2 position.`, { reason: 'NOT_A_POSITION' });
      const poolOfPosition = getAddressDecoder().decode(acct.data.subarray(8, 40));
      if (poolOfPosition !== damm.pool) throw new RequestError(422, `The position belongs to pool ${poolOfPosition}, not this cross's pool ${damm.pool}.`, { reason: 'WRONG_POOL' });
      const nftMint = getAddressDecoder().decode(acct.data.subarray(40, 72));
      positionNftAccount = a.dammPositionAddresses(nftMint).positionNftAccount;
    }
    const holder = await c.owns(positionNftAccount);
    if (holder !== owner) throw new RequestError(422, holder === null ? 'The position NFT account does not exist.' : `The position is held by ${holder}, not by ${owner}; only the holder (or its delegate) can claim.`, { reason: 'NOT_THE_HOLDER', holder });
    const { tokenProgram } = await c.mintProgram(slot.mint, 'reward mint');
    const ixs = await a.buildClaimDammReward({ pool: damm.pool, position, positionNftAccount, owner: createNoopSigner(owner), rewardMint: slot.mint, tokenProgram, index });
    const sizedTx = sized(owner, ixs, 'reward claim');
    return send(reply, await transaction(owner, sizedTx.ixs, { bytes: sizedTx.bytes, pool: damm.pool, position, index, rewardMint: slot.mint, note: 'The program pays what the slot has streamed to this position so far; the amount is not computed here.' }));
  });

  const creatorAction = async (req: { body: unknown }, route: string, extra: string[]) => {
    const b = obj(req.body);
    only(b, ['cross', 'signer', 'index', ...extra], route);
    const cross = await readCross(addr(b.cross, 'cross'));
    const signer = addr(b.signer, 'signer');
    const index = slotIndex(b.index);
    const ctx = await dammOf(cross);
    if (index === 1) throw new RequestError(422, 'Slot 1 can only be changed by a Meteora operator.', { reason: 'SLOT_1_NEEDS_OPERATOR' });
    if (signer !== ctx.pool.creator) throw new RequestError(422, `Only the pool's creator, ${ctx.pool.creator}, can change slot 0.`, { reason: 'NOT_THE_POOL_CREATOR', creator: ctx.pool.creator });
    if (!ctx.pool.slots[index]!.initialized) throw new RequestError(409, `Slot ${index} is not open.`, { reason: 'SLOT_NOT_OPEN' });
    return { b, signer, index, ...ctx };
  };

  app.post('/v1/tx/damm-reward-update-funder', async (req, reply) => {
    const x = await creatorAction(req, 'damm-reward-update-funder', ['newFunder']);
    const newFunder = addr(x.b.newFunder, 'newFunder');
    const ix = x.a.buildUpdateDammRewardFunder({ pool: x.damm.pool, signer: createNoopSigner(x.signer), index: x.index, newFunder });
    const { ixs, bytes } = sized(x.signer, [ix], 'reward funder change');
    return send(reply, await transaction(x.signer, ixs, { bytes, pool: x.damm.pool, index: x.index, newFunder }));
  });

  app.post('/v1/tx/damm-reward-update-duration', async (req, reply) => {
    const x = await creatorAction(req, 'damm-reward-update-duration', ['durationSecs']);
    const durationSecs = u64(x.b.durationSecs, 'durationSecs');
    const slot = x.pool.slots[x.index]!;
    if (slot.endsAt > c.now()) throw new RequestError(409, `A stream is running until ${slot.endsAt}; the duration can change once it has ended.`, { reason: 'STREAM_RUNNING', endsAt: slot.endsAt });
    if (durationSecs < BigInt(x.a.DAMM_REWARD_MIN_DURATION) || durationSecs > BigInt(x.a.DAMM_REWARD_MAX_DURATION)) throw new RequestError(422, `A reward streams over ${x.a.DAMM_REWARD_MIN_DURATION} to ${x.a.DAMM_REWARD_MAX_DURATION} seconds; ${durationSecs} was given.`, { reason: 'DURATION_OUT_OF_RANGE' });
    const ix = x.a.buildUpdateDammRewardDuration({ pool: x.damm.pool, signer: createNoopSigner(x.signer), index: x.index, newDurationSecs: durationSecs });
    const { ixs, bytes } = sized(x.signer, [ix], 'reward duration change');
    return send(reply, await transaction(x.signer, ixs, { bytes, pool: x.damm.pool, index: x.index, durationSecs }));
  });

  app.post('/v1/tx/damm-reward-withdraw-ineligible', async (req, reply) => {
    const b = obj(req.body);
    only(b, ['cross', 'funder', 'index'], 'damm-reward-withdraw-ineligible');
    const cross = await readCross(addr(b.cross, 'cross'));
    const funder = addr(b.funder, 'funder');
    const index = slotIndex(b.index);
    const { a, damm, pool } = await dammOf(cross);
    const slot = pool.slots[index]!;
    if (!slot.initialized) throw new RequestError(409, `Slot ${index} is not open.`, { reason: 'SLOT_NOT_OPEN' });
    if (funder !== slot.funder) throw new RequestError(422, `Only the slot's funder, ${slot.funder}, can take back reward that streamed while the pool had no liquidity.`, { reason: 'NOT_THE_FUNDER', funder: slot.funder });
    if (slot.endsAt > c.now()) throw new RequestError(409, `The stream runs until ${slot.endsAt}; ineligible reward can be withdrawn once it has ended.`, { reason: 'STREAM_RUNNING', endsAt: slot.endsAt });
    const { tokenProgram } = await c.mintProgram(slot.mint, 'reward mint');
    const ix = await a.buildWithdrawIneligibleDammReward({ pool: damm.pool, funder: createNoopSigner(funder), rewardMint: slot.mint, tokenProgram, index });
    const { ixs, bytes } = sized(funder, [ix], 'ineligible reward withdrawal');
    return send(reply, await transaction(funder, ixs, { bytes, pool: damm.pool, index }));
  });

  app.post('/v1/tx/damm-lp-join', async (req, reply) => {
    const b = obj(req.body);
    only(b, ['cross', 'owner', 'positionNftMint', 'shareBps', 'slippageBps'], 'damm-lp-join');
    const cross = await readCross(addr(b.cross, 'cross'));
    const owner = addr(b.owner, 'owner');
    const positionNftMint = addr(b.positionNftMint, 'positionNftMint');
    const shareBps = uint(b.shareBps, 'shareBps', 10_000, 1);
    const slippageBps = b.slippageBps === undefined ? 100 : uint(b.slippageBps, 'slippageBps', 5_000);
    const { a, damm, pool } = await dammOf(cross);
    if (positionNftMint === owner) throw new RequestError(400, 'positionNftMint must be a fresh keypair, not the owner: it signs once to create the position.');
    if (await c.account(a.dammPositionAddresses(positionNftMint).position)) throw new RequestError(409, 'A position exists for that mint already: use a fresh keypair.', { reason: 'POSITION_EXISTS' });
    const x = cross.data;
    // Meteora takes both tokens in the pool's current ratio for the liquidity asked; the pool's two vaults say how much that is.
    const vaultBalance = async (v: Address) => {
      const acct = await c.account(v);
      return acct && acct.data.length >= 72 ? new DataView(acct.data.buffer, acct.data.byteOffset).getBigUint64(64, true) : 0n;
    };
    const [reserveA, reserveB] = [await vaultBalance(damm.tokenAVault), await vaultBalance(damm.tokenBVault)];
    const liquidityDelta = (pool.liquidity * BigInt(shareBps)) / 10_000n;
    if (liquidityDelta === 0n) throw new RequestError(422, 'The pool has no liquidity to take a share of.', { reason: 'EMPTY_POOL' });
    const cap = (reserve: bigint) => (((reserve * BigInt(shareBps)) / 10_000n + 1n) * BigInt(10_000 + slippageBps) + 9_999n) / 10_000n;
    const maxBase = cap(reserveA);
    const maxQuote = cap(reserveB);
    await c.tokenBalance(owner, x.baseMint, x.baseTokenProgram, 'base', maxBase);
    await c.tokenBalance(owner, x.quoteMint, x.quoteTokenProgram, 'quote', maxQuote);
    const nft = createNoopSigner(positionNftMint);
    const created = a.buildCreateDammPosition({ pool: damm.pool, owner, payer: createNoopSigner(owner), positionNftMint: nft });
    const add = await a.buildAddDammLiquidity({ pool: damm.pool, position: created.position, positionNftAccount: created.positionNftAccount, owner: createNoopSigner(owner), tokenAMint: x.baseMint, tokenBMint: x.quoteMint, tokenAVault: damm.tokenAVault, tokenBVault: damm.tokenBVault, tokenAProgram: x.baseTokenProgram, tokenBProgram: x.quoteTokenProgram, liquidityDelta, maxTokenA: maxBase, maxTokenB: maxQuote });
    const { ixs, bytes } = sized(owner, [created.instruction, add], 'liquidity provision');
    return send(reply, await transaction(owner, ixs, { bytes, pool: damm.pool, position: created.position, positionNftAccount: created.positionNftAccount, liquidityDelta, maxBase, maxQuote, shareOfPoolBps: shareBps, note: 'Creates a position owned by this wallet and adds liquidity in the pool\'s current ratio. The position earns its share of trading fees and of any reward slot. The fresh keypair signs once.' }));
  });

  // ---------------------------------------------------------------------------------------------------------------------------- conviction ladder
  async function pairOf(cross: CrossView) {
    const a = await adapters();
    marketOf(cross);
    await requireProgram(c.account, a.DLMM_PROGRAM_ADDRESS, 'Meteora DLMM');
    const pair = a.dlmmAddresses(cross.data.baseMint, cross.data.quoteMint);
    const acct = await c.account(pair.lbPair);
    if (!acct || acct.owner !== a.DLMM_PROGRAM_ADDRESS || acct.data.length < 80) throw new RequestError(409, `The cross has no DLMM pair at ${pair.lbPair}: open one first.`, { reason: 'NO_PAIR', pair: pair.lbPair });
    const view = new DataView(acct.data.buffer, acct.data.byteOffset);
    const activeId = view.getInt32(76, true);
    // `activation_type` 1 counts seconds; `activation_point` is when the pair opens. The pair is closed while the clock is before it.
    const activation = acct.data.length >= 824 ? { type: acct.data[86]!, point: view.getBigUint64(816, true) } : { type: 255, point: 0n };
    const closed = activation.type === 1 && c.now() < activation.point;
    const existingArrays = async (ids: number[]) => {
      const out: number[] = [];
      for (const i of ids) if (await c.account(a.binArrayAddress(pair.lbPair, i))) out.push(i);
      return out;
    };
    return { a, pair, activeId, existingArrays, activation, closed };
  }
  const baseBalanceOf = async (cross: CrossView, owner: Address) => {
    const acct = await c.account(await ata(owner, cross.data.baseMint, cross.data.baseTokenProgram));
    return acct && acct.data.length >= 72 ? new DataView(acct.data.buffer, acct.data.byteOffset).getBigUint64(64, true) : 0n;
  };
  const LADDER_NOTE = 'A ladder is the issuer\'s to withdraw: DLMM lets the owner cancel an unfilled rung or withdraw a position one second after placing it. It shows depth and sells above the clearing price; it is not a lock.';

  async function readLadder(cross: CrossView, positionAddress: Address) {
    const { a, pair, activeId } = await pairOf(cross);
    const acct = await c.account(positionAddress);
    const position = acct && acct.owner === a.DLMM_PROGRAM_ADDRESS ? a.decodeDlmmPosition(acct.data) : null;
    if (!position) throw new RequestError(404, `${positionAddress} is not a DLMM position.`, { reason: 'NOT_A_POSITION' });
    if (position.lbPair !== pair.lbPair) throw new RequestError(422, `The position belongs to pair ${position.lbPair}, not this cross's pair ${pair.lbPair}.`, { reason: 'WRONG_PAIR' });
    const arrays = [];
    for (const at of a.dlmmPositionArrayAddresses(pair.lbPair, position)) {
      const x = await c.account(at);
      const decoded = x ? a.decodeDlmmBinArray(x.data) : null;
      if (decoded) arrays.push(decoded);
    }
    const amounts = a.dlmmPositionAmounts(position, arrays);
    return { a, pair, activeId, position, amounts, status: a.ladderStatus(position, amounts, activeId), locked: position.lockReleasePoint > c.now() };
  }

  app.get('/v1/crosses/:address/ladder', async (req, reply) => {
    const cross = await readCross(addr((req.params as { address: string }).address, 'address'));
    const positionQ = (req.query as { position?: string }).position;
    if (positionQ === undefined) {
      const { pair, activeId } = await pairOf(cross);
      return send(reply, { cross: cross.address, pair: pair.lbPair, activeId, note: 'Name a position to read a ladder: ?position=<address>.' });
    }
    const x = await readLadder(cross, addr(positionQ, 'position'));
    return send(reply, { cross: cross.address, pair: x.pair.lbPair, activeId: x.activeId, position: positionQ, owner: x.position.owner, lowerBinId: x.position.lowerBinId, upperBinId: x.position.upperBinId, baseLeft: x.amounts.x, quoteEarned: x.amounts.y, status: x.status, lockedUntil: x.position.lockReleasePoint, locked: x.locked, note: x.locked ? `Locked: DLMM refuses to withdraw this position before ${x.position.lockReleasePoint}.` : LADDER_NOTE });
  });

  app.post('/v1/tx/ladder-limit-place', async (req, reply) => {
    const b = obj(req.body);
    only(b, ['cross', 'owner', 'limitOrder', 'baseAmount', 'count', 'shape', 'spacing', 'firstOffset'], 'ladder-limit-place');
    const cross = await readCross(addr(b.cross, 'cross'));
    const owner = addr(b.owner, 'owner');
    const limitOrder = addr(b.limitOrder, 'limitOrder');
    const baseAmount = u64(b.baseAmount, 'baseAmount');
    if (limitOrder === owner) throw new RequestError(400, 'limitOrder must be a fresh keypair, not the owner: it is the new order account and signs once.');
    const shape = b.shape === undefined ? 'flat' : b.shape;
    if (shape !== 'flat' && shape !== 'taper' && shape !== 'wall') throw new RequestError(400, 'shape must be "flat", "taper" or "wall"');
    const { a, activeId, existingArrays } = await pairOf(cross);
    if (await c.account(limitOrder)) throw new RequestError(409, 'An account exists at that address already: use a fresh keypair.', { reason: 'ORDER_EXISTS' });
    let rungs;
    try {
      rungs = a.planLimitLadder({ activeId, count: b.count === undefined ? 6 : uint(b.count, 'count', a.MAX_LIMIT_ORDER_BINS, 1), baseAmount, shape, ...(b.spacing !== undefined && { spacing: uint(b.spacing, 'spacing', 70, 1) }), ...(b.firstOffset !== undefined && { firstOffset: uint(b.firstOffset, 'firstOffset', 1000, 1) }) });
    } catch (e) {
      if (e instanceof RequestError) throw e;
      throw new RequestError(422, (e as Error).message, { reason: 'LADDER_INVALID' });
    }
    const have = await baseBalanceOf(cross, owner);
    if (have < baseAmount) throw new RequestError(422, `${owner} holds ${have} of the base token; the ladder sells ${baseAmount}.`, { reason: 'INSUFFICIENT_BASE', have, need: baseAmount });
    const hook = await c.gateHook(cross.data.baseMint, owner, a.dlmmAddresses(cross.data.baseMint, cross.data.quoteMint).lbPair);
    const existing = await existingArrays(a.limitLadderArrayIndexes(activeId, rungs));
    const built = await a.buildPlaceLimitLadder({ cross, owner: createNoopSigner(owner), limitOrder: createNoopSigner(limitOrder), activeId, rungs, existingBinArrays: existing, hook: hook !== null });
    const sizedTx = sized(owner, built.instructions, 'limit-order ladder');
    return send(reply, await transaction(owner, sizedTx.ixs, { bytes: sizedTx.bytes, limitOrder, activeId, rungs: rungs.map((r) => ({ binId: r.binId, amount: r.amount })), binArrays: built.binArrays, note: LADDER_NOTE }));
  });

  app.post('/v1/tx/ladder-limit-cancel', async (req, reply) => {
    const b = obj(req.body);
    only(b, ['cross', 'owner', 'limitOrder', 'binIds'], 'ladder-limit-cancel');
    const cross = await readCross(addr(b.cross, 'cross'));
    const owner = addr(b.owner, 'owner');
    const limitOrder = addr(b.limitOrder, 'limitOrder');
    const binIds = list(b.binIds, 'binIds', 70, (x, i) => {
      if (typeof x !== 'number' || !Number.isInteger(x) || Math.abs(x) > 1_000_000) throw new RequestError(400, `binIds[${i}] must be a whole bin id`);
      return x;
    });
    if (binIds.length === 0) throw new RequestError(400, 'name at least one bin to cancel');
    const { a, pair } = await pairOf(cross);
    const acct = await c.account(limitOrder);
    if (!acct || acct.owner !== a.DLMM_PROGRAM_ADDRESS || acct.data.length < 74) throw new RequestError(404, `${limitOrder} is not a DLMM limit order.`, { reason: 'NOT_A_LIMIT_ORDER' });
    if (getAddressDecoder().decode(acct.data.subarray(8, 40)) !== pair.lbPair) throw new RequestError(422, 'That limit order belongs to another pair.', { reason: 'WRONG_PAIR' });
    const orderOwner = getAddressDecoder().decode(acct.data.subarray(40, 72));
    if (orderOwner !== owner) throw new RequestError(422, `The order belongs to ${orderOwner}, not ${owner}; only its owner can cancel.`, { reason: 'NOT_THE_OWNER', owner: orderOwner });
    const hook = await c.gateHook(cross.data.baseMint, pair.lbPair, owner);
    const ix = await a.buildCancelLimitLadder({ cross, owner: createNoopSigner(owner), limitOrder, binIds, hook: hook !== null });
    const sizedTx = sized(owner, [ix], 'limit-order cancel');
    return send(reply, await transaction(owner, sizedTx.ixs, { bytes: sizedTx.bytes, limitOrder, binIds, note: 'DLMM refuses to cancel a rung in the same second it was placed unless a buyer has filled it completely, and a partly filled rung only after that second. Cancelling returns the unfilled base and pays the quote the fills earned.' }));
  });

  app.post('/v1/tx/ladder-limit-close', async (req, reply) => {
    const b = obj(req.body);
    only(b, ['cross', 'owner', 'limitOrder', 'rentReceiver'], 'ladder-limit-close');
    const cross = await readCross(addr(b.cross, 'cross'));
    const owner = addr(b.owner, 'owner');
    const limitOrder = addr(b.limitOrder, 'limitOrder');
    const rentReceiver = opt(b.rentReceiver, (v) => addr(v, 'rentReceiver')) ?? owner;
    const { a } = await pairOf(cross);
    const acct = await c.account(limitOrder);
    if (!acct || acct.owner !== a.DLMM_PROGRAM_ADDRESS) throw new RequestError(404, `${limitOrder} is not a DLMM limit order (it may be closed already).`, { reason: 'NOT_A_LIMIT_ORDER' });
    const ix = a.buildCloseLimitLadder({ cross, owner: createNoopSigner(owner), limitOrder, rentReceiver });
    const sizedTx = sized(owner, [ix], 'limit-order close');
    return send(reply, await transaction(owner, sizedTx.ixs, { bytes: sizedTx.bytes, limitOrder, rentReceiver, note: 'DLMM closes the order only when every rung is empty; while one holds base or quote this does nothing and the account stays.' }));
  });

  app.post('/v1/tx/ladder-rebalance-withdraw', async (req, reply) => {
    const b = obj(req.body);
    only(b, ['cross', 'owner', 'position'], 'ladder-rebalance-withdraw');
    const cross = await readCross(addr(b.cross, 'cross'));
    const owner = addr(b.owner, 'owner');
    const x = await readLadder(cross, addr(b.position, 'position'));
    if (x.position.owner !== owner) throw new RequestError(422, `The position belongs to ${x.position.owner}, not ${owner}; only its owner can withdraw it.`, { reason: 'NOT_THE_OWNER', owner: x.position.owner });
    if (x.locked) throw new RequestError(409, `This ladder is locked until ${x.position.lockReleasePoint}: DLMM refuses to withdraw it before then, so it cannot be rebalanced yet.`, { reason: 'LOCKED', lockedUntil: x.position.lockReleasePoint });
    if (x.status.untouched) throw new RequestError(409, 'No buyer has reached this ladder: it still stands entirely above the market, so there is nothing to rebalance.', { reason: 'NOTHING_TO_REBALANCE', activeId: x.activeId });
    if (x.status.baseLeft === 0n) throw new RequestError(409, 'The ladder has sold all its base: it holds only quote, which a withdrawal returns. There is no base to lay again.', { reason: 'NO_BASE_LEFT', quoteEarned: x.status.quoteEarned });
    const hook = await c.gateHook(cross.data.baseMint, x.pair.lbPair, owner);
    const plan = await x.a.buildRebalanceLadder({ cross, owner: createNoopSigner(owner), position: addr(b.position, 'position'), lowerBinId: x.position.lowerBinId, upperBinId: x.position.upperBinId, newPosition: createNoopSigner(owner), activeId: x.activeId, bins: 1, baseAmount: x.status.baseLeft, hook: hook !== null });
    const sizedTx = sized(owner, plan.withdraw, 'ladder withdrawal');
    return send(reply, await transaction(owner, sizedTx.ixs, { bytes: sizedTx.bytes, position: b.position, activeId: x.activeId, baseLeft: x.status.baseLeft, quoteEarned: x.status.quoteEarned, baseFrom: x.status.baseFrom, baseTo: x.status.baseTo, next: { route: '/v1/tx/ladder-rebalance-relay', baseAmount: x.status.baseLeft }, note: 'Step 1 of 2: withdraws the whole position (its quote is your proceeds, its base returns to your wallet), claims its fees and closes it. Step 2 lays the base again above the new price. DLMM refuses a withdrawal in the second the liquidity was added.' }));
  });

  // The first placement of a position ladder and the second step of a rebalance are the same transaction; the name says which one the caller means.
  const placeLadder = (route: string) => async (req: FastifyRequest, reply: FastifyReply) => {
    const b = obj(req.body);
    only(b, ['cross', 'owner', 'newPosition', 'baseAmount', 'bins', 'shape', 'lockUntil'], route.slice('/v1/tx/'.length));
    const cross = await readCross(addr(b.cross, 'cross'));
    const owner = addr(b.owner, 'owner');
    const newPosition = addr(b.newPosition, 'newPosition');
    const baseAmount = u64(b.baseAmount, 'baseAmount');
    if (baseAmount === 0n) throw new RequestError(400, 'baseAmount must be above zero');
    const shape = b.shape === undefined ? 'flat' : b.shape;
    if (shape !== 'flat' && shape !== 'taper' && shape !== 'wall') throw new RequestError(400, 'shape must be "flat", "taper" or "wall"');
    const bins = b.bins === undefined ? 30 : uint(b.bins, 'bins', 70, 1);
    if (newPosition === owner) throw new RequestError(400, 'newPosition must be a fresh keypair, not the owner: it is the new position account and signs once.');
    const { a, activeId, existingArrays, closed, activation } = await pairOf(cross);
    const lockUntil = opt(b.lockUntil, (v) => u64(v, 'lockUntil'));
    if (lockUntil !== null) {
      if (lockUntil <= c.now()) throw new RequestError(422, 'lockUntil is in the past: a lock releases at that unix time, so it must be ahead.', { reason: 'LOCK_IN_PAST' });
      if (!closed) throw new RequestError(409, activation.type === 1 ? `The pair opened at ${activation.point}; Meteora lets a locked position be made only while the pair is closed (it is for seeding a launch before it opens), so a lock is no longer possible. Lay the ladder unlocked, or open the next market in a batch window.` : 'The pair counts slots, not seconds; a lock is built for timestamp pairs only.', { reason: 'PAIR_OPEN', activationPoint: activation.point });
    }
    if (await c.account(newPosition)) throw new RequestError(409, 'An account exists at that address already: use a fresh keypair.', { reason: 'POSITION_EXISTS' });
    const have = await baseBalanceOf(cross, owner);
    if (have < baseAmount) throw new RequestError(422, `${owner} holds ${have} of the base token; the ladder lays ${baseAmount}.${route.endsWith('relay') ? ' Send the withdrawal first.' : ''}`, { reason: 'INSUFFICIENT_BASE', have, need: baseAmount });
    const first = a.binArrayIndex(activeId);
    const existing = await existingArrays(Array.from({ length: Math.ceil(bins / 70) + 2 }, (_, i) => first + i));
    const ladder = await a.buildDlmmConvictionLadder({ cross, creator: createNoopSigner(owner), position: createNoopSigner(newPosition), activeId, bins, baseAmount, shape, existingBinArrays: existing, maxActiveBinSlippage: 2, ...(lockUntil !== null && { lockUntil }) });
    const sizedTx = sized(owner, ladder.instructions, 'ladder placement');
    return send(reply, await transaction(owner, sizedTx.ixs, { bytes: sizedTx.bytes, newPosition, position: ladder.position, activeId, lowerBinId: ladder.lowerBinId, upperBinId: ladder.upperBinId, baseAmount, lockedUntil: lockUntil, note: lockUntil !== null ? `Locked until ${lockUntil}: DLMM refuses to withdraw this position before then, yours included. Read it at the position address shown, not at the key that signed.` : LADDER_NOTE }));
  };
  app.post('/v1/tx/ladder-rebalance-relay', placeLadder('/v1/tx/ladder-rebalance-relay'));
  app.post('/v1/tx/ladder-position-place', placeLadder('/v1/tx/ladder-position-place'));

  // ---------------------------------------------------------------------------------------------------------------------------- fixed-price tranche, buyer side
  async function trancheOf(b: Record<string, unknown>) {
    const cross = await readCross(addr(b.cross, 'cross'));
    marketOf(cross);
    const base = addr(b.base, 'base');
    const a = await adapters();
    await requireProgram(c.account, a.PRESALE_PROGRAM_ADDRESS, 'Meteora Presale Vault');
    const addresses = await a.presaleAddresses(base, cross.data.baseMint, cross.data.quoteMint);
    const acct = await c.account(addresses.presale);
    const state = acct && acct.owner === a.PRESALE_PROGRAM_ADDRESS ? a.decodePresale(acct.data) : null;
    if (!state) throw new RequestError(404, `There is no tranche at ${addresses.presale}: open it with open-fixed-price-presale, and pass the same \`base\` keypair address.`, { reason: 'NO_TRANCHE', presale: addresses.presale });
    return { cross, a, addresses, state, outcome: a.presaleOutcome(state, c.now()) };
  }

  app.post('/v1/tx/presale-deposit', async (req, reply) => {
    const b = obj(req.body);
    only(b, ['cross', 'base', 'buyer', 'amount'], 'presale-deposit');
    const buyer = addr(b.buyer, 'buyer');
    const amount = u64(b.amount, 'amount');
    if (amount === 0n) throw new RequestError(400, 'amount must be above zero');
    const { cross, a, addresses, state, outcome } = await trancheOf(b);
    const x = cross.data;
    if (outcome !== 'ongoing') throw new RequestError(409, outcome === 'not-started' ? `The sale opens at ${state.start}.` : 'The sale is over: it ended or sold out, so it takes no more deposits.', { reason: 'NOT_ONGOING', outcome, start: state.start, end: state.end, totalDeposit: state.totalDeposit, maxCap: state.maxCap });
    await c.tokenBalance(buyer, x.quoteMint, x.quoteTokenProgram, 'quote', amount);
    const escrow = await a.presaleEscrowAddress(addresses.presale, buyer);
    const hasEscrow = !!(await c.account(escrow));
    const ixs = await a.buildPresaleDeposit({ presale: addresses.presale, quoteTokenVault: addresses.quoteTokenVault, quoteMint: x.quoteMint, quoteTokenProgram: x.quoteTokenProgram, buyer: createNoopSigner(buyer), maxAmount: amount, createEscrow: !hasEscrow });
    const sizedTx = sized(buyer, ixs, 'tranche deposit');
    const price = x.clearing.__option === 'Some' ? x.clearing.value.price : 0n;
    return send(reply, await transaction(buyer, sizedTx.ixs, { bytes: sizedTx.bytes, presale: addresses.presale, escrow, opensEscrow: !hasEscrow, clearingPrice: price, expectedBase: price > 0n ? (amount * x.priceScale) / price : 0n, note: 'The price is the clearing price. The vault takes less than asked when the sale\'s cap or your own cap leaves less room, and says so in the transaction\'s result; claims open when the sale has ended or filled.' }));
  });

  app.post('/v1/tx/presale-claim', async (req, reply) => {
    const b = obj(req.body);
    only(b, ['cross', 'base', 'buyer'], 'presale-claim');
    const buyer = addr(b.buyer, 'buyer');
    const { cross, a, addresses, state, outcome } = await trancheOf(b);
    const x = cross.data;
    const escrow = await a.presaleEscrowAddress(addresses.presale, buyer);
    if (!(await c.account(escrow))) throw new RequestError(404, `${buyer} has no escrow in this tranche: it never deposited.`, { reason: 'NO_ESCROW' });
    if (outcome === 'failed') throw new RequestError(409, 'The sale ended without raising its minimum, so there is nothing to claim: depositors take their quote back (Meteora\'s withdraw_remaining_quote, which this API does not build yet).', { reason: 'SALE_FAILED', minCap: state.minCap, totalDeposit: state.totalDeposit });
    if (outcome !== 'completed') throw new RequestError(409, `The sale is not over: claims open when it ends with its minimum raised, or sells out (it ends at ${state.end}).`, { reason: 'NOT_COMPLETED', outcome, end: state.end });
    const { PRESALE_AUTHORITY } = a;
    const hook = await c.gateHook(x.baseMint, PRESALE_AUTHORITY, buyer);
    const ixs = await a.buildPresaleClaim({ presale: addresses.presale, baseTokenVault: addresses.presaleVault, baseMint: x.baseMint, baseTokenProgram: x.baseTokenProgram, buyer: createNoopSigner(buyer), hook: hook !== null });
    const sizedTx = sized(buyer, ixs, 'tranche claim');
    return send(reply, await transaction(buyer, sizedTx.ixs, { bytes: sizedTx.bytes, presale: addresses.presale, escrow, transferHook: hook !== null }));
  });

  app.post('/v1/tx/presale-creator-withdraw', async (req, reply) => {
    const b = obj(req.body);
    only(b, ['cross', 'base', 'creator'], 'presale-creator-withdraw');
    const creator = addr(b.creator, 'creator');
    const { cross, a, addresses, state, outcome } = await trancheOf(b);
    const x = cross.data;
    if (creator !== x.creator) throw new RequestError(422, `Only the cross's creator, ${x.creator}, opened the tranche and can withdraw from it.`, { reason: 'NOT_THE_CREATOR' });
    if (state.hasCreatorWithdrawn) throw new RequestError(409, 'The creator has withdrawn from this tranche already; it can be done once.', { reason: 'ALREADY_WITHDRAWN' });
    if (outcome === 'not-started' || outcome === 'ongoing') throw new RequestError(409, `The sale is not over (it ends at ${state.end}); the creator withdraws once it has completed or failed.`, { reason: 'STILL_OPEN', outcome, end: state.end, totalDeposit: state.totalDeposit, minCap: state.minCap });
    const failed = outcome === 'failed';
    const hook = failed ? await c.gateHook(x.baseMint, a.PRESALE_AUTHORITY, creator) : null;
    const mint = failed ? x.baseMint : x.quoteMint;
    const tokenProgram = failed ? x.baseTokenProgram : x.quoteTokenProgram;
    const ensure = getCreateAssociatedTokenIdempotentInstruction({ payer: createNoopSigner(creator), ata: await ata(creator, mint, tokenProgram), owner: creator, mint, tokenProgram }) as Instruction;
    const ix = await a.buildPresaleCreatorWithdraw({ presale: addresses.presale, cross, creator: createNoopSigner(creator), outcome, quoteTokenVault: addresses.quoteTokenVault, baseTokenVault: addresses.presaleVault, hook: hook !== null });
    const sizedTx = sized(creator, [ensure, ix], 'tranche withdrawal');
    return send(reply, await transaction(creator, sizedTx.ixs, { bytes: sizedTx.bytes, presale: addresses.presale, outcome, pays: failed ? 'the base supply, returned' : 'the quote the tranche raised', note: failed ? 'The sale ended without its minimum, so the base token returns to you; depositors take their quote back.' : 'The sale completed. This can be done once.' }));
  });

  // ---------------------------------------------------------------------------------------------------------------------------- calibrated curve
  app.post('/v1/curve/calibrate', async (req, reply) => {
    const b = obj(req.body);
    only(b, ['cross', 'clearingPrice', 'bids', 'segments', 'headroomBps', 'floorBps'], 'curve-calibrate');
    if (b.cross !== undefined && b.clearingPrice !== undefined) throw new RequestError(400, 'name the cross or the clearing price, not both');
    let clearingPrice: bigint;
    if (b.cross !== undefined) {
      const cross = await readCross(addr(b.cross, 'cross'));
      if (cross.data.clearing.__option !== 'Some') throw new RequestError(409, 'The cross has not printed a price, so there is no clearing price to calibrate against.', { reason: 'NOT_CLEARED' });
      clearingPrice = cross.data.clearing.value.price;
    } else {
      clearingPrice = u64(b.clearingPrice, 'clearingPrice');
    }
    const bids = list(b.bids, 'bids', 5_000, (x, i) => {
      const r = obj(x, `bids[${i}]`);
      only(r, ['price', 'quantity'], `bids[${i}]`);
      return { price: u64(r.price, `bids[${i}].price`), quantity: u64(r.quantity, `bids[${i}].quantity`) };
    });
    const a = await adapters();
    try {
      const curve = a.calibrateCurveFromDemand({ clearingPrice, bids, ...(b.segments !== undefined && { segments: uint(b.segments, 'segments', a.CURVE_MAX_SEGMENTS, 1) }), ...(b.headroomBps !== undefined && { headroomBps: uint(b.headroomBps, 'headroomBps', 100_000) }), ...(b.floorBps !== undefined && { floorBps: uint(b.floorBps, 'floorBps', 10_000) }) });
      return send(reply, { clearingPrice, ...curve, usage: 'Set `sqrtPriceMultiples` and `liquidityWeights` of the continuation design to these. The weights are relative: only their ratios matter.' });
    } catch (e) {
      if (e instanceof RequestError) throw e;
      throw new RequestError(422, (e as Error).message, { reason: 'CALIBRATION_INVALID' });
    }
  });
}
