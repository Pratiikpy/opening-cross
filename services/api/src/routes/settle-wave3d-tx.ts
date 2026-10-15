// The two `cross_settle` instructions of the batch 2 upgrade that open a market without a pool: a fixed-price tranche at the clearing price through Meteora's Presale Vault
// (B4; ADR-0663) and a MetaDAO futarchy DAO whose spot pool starts at the clearing price (X3; ADR-0657). Unsigned transactions; the API holds no key. Both exist only in the
// `cross_settle` build that is NOT deployed on devnet yet (docs/HUMAN_TASKS.md H27): a route answers 409 PROGRAM_NOT_DEPLOYED until it is.
//
//   POST /v1/tx/open-fixed-price-presale  { cross, creator, base, terms, disableWithdraw? }
//        `base` is a fresh keypair address that also signs (Meteora derives the presale's address from it). `terms` is { maxCap, minCap, start, end, supply, buyerMinDeposit,
//        buyerMaxDeposit, depositFeeBps?, immediatelyReleaseBps?, lockDuration?, vestDuration?, unsoldTokenAction? } (amounts decimal strings, times Unix seconds).
//   POST /v1/tx/seed-futarchy-dao         { cross, creator, baseAmount, quoteAmount?, nonce?, settings? }
//        Legacy SPL Token mints only. A cross with the governed-graduation rule needs a passed vote that chose MetaDAO.
import type { FastifyInstance, FastifyReply } from 'fastify';
import { type Address, createNoopSigner } from '@solana/kit';
import { OPEN_DBC_POOL_DISCRIMINATOR, OPEN_FIXED_PRICE_PRESALE_DISCRIMINATOR, SEED_FUTARCHY_DAO_DISCRIMINATOR, CROSS_SETTLE_PROGRAM_ADDRESS } from '@opening-cross/cross-settle-client';
import { CrossState, SPL_TOKEN_PROGRAM, ata } from '@opening-cross/sdk';
import { type Lifetime, RequestError, compile } from '../tx.js';
import { addr, bool, int, i64, json, obj, only, opt, u64 } from './_inputs.js';
import { HEAVY_UNITS, type ReleaseGate, computeUnits, fits, releaseGate, requireInstruction, requireProgram } from './program-gate.js';
import { type AccountReader, readCross, requireGraduationApproval, tokenBalance } from './programs-support.js';

export type SettleWave3dDeps = {
  account: AccountReader;
  lifetime: () => Promise<Lifetime>;
  clock?: () => number;
  /** Replaces the release check (tests); by default the program's own bytes are read (routes/program-gate.ts). */
  gate?: ReleaseGate;
};

const send = (reply: FastifyReply, v: unknown, status = 200) => reply.code(status).type('application/json').send(json(v));
const ZERO = '11111111111111111111111111111111' as Address;
const adapters = () => import('@opening-cross/adapters');
const MAX_NONCE_PROBES = 64;

export function registerSettleWave3dTx(app: FastifyInstance, d: SettleWave3dDeps): void {
  const gate = d.gate ?? releaseGate({ account: d.account, ...(d.clock && { clock: d.clock }) });
  const need = (name: string, discriminator: Uint8Array) => requireInstruction(gate, CROSS_SETTLE_PROGRAM_ADDRESS, { name, discriminator }, OPEN_DBC_POOL_DISCRIMINATOR as Uint8Array);

  const checkOpenable = (cross: Awaited<ReturnType<typeof readCross>>, creator: Address) => {
    if (creator !== cross.data.creator) throw new RequestError(422, `Only the cross's creator, ${cross.data.creator}, can open its market.`, { reason: 'NOT_THE_CREATOR' });
  };
  const checkCleared = (cross: Awaited<ReturnType<typeof readCross>>) => {
    if (cross.data.clearing.__option !== 'Some') throw new RequestError(409, cross.data.state === CrossState.Live ? 'The cross has not settled yet.' : 'The cross did not print a price, so there is nothing to open a market at.', { reason: cross.data.state === CrossState.Live ? 'LIVE' : 'NOT_CLEARED' });
    if (!cross.data.baseBound || cross.data.baseMint === ZERO) throw new RequestError(409, 'The cross has no base mint yet.', { reason: 'NO_BASE_MINT' });
  };

  app.post('/v1/tx/open-fixed-price-presale', async (req, reply) => {
    const b = obj(req.body);
    only(b, ['cross', 'creator', 'base', 'terms', 'disableWithdraw'], 'open-fixed-price-presale');
    const creator = addr(b.creator, 'creator');
    const base = addr(b.base, 'base');
    const t = obj(b.terms, 'terms');
    only(t, ['maxCap', 'minCap', 'start', 'end', 'supply', 'buyerMinDeposit', 'buyerMaxDeposit', 'depositFeeBps', 'immediatelyReleaseBps', 'lockDuration', 'vestDuration', 'unsoldTokenAction'], 'terms');
    const terms = {
      maxCap: u64(t.maxCap, 'terms.maxCap'),
      minCap: u64(t.minCap, 'terms.minCap'),
      start: i64(t.start, 'terms.start'),
      end: i64(t.end, 'terms.end'),
      supply: u64(t.supply, 'terms.supply'),
      buyerMinDeposit: u64(t.buyerMinDeposit, 'terms.buyerMinDeposit'),
      buyerMaxDeposit: u64(t.buyerMaxDeposit, 'terms.buyerMaxDeposit'),
      ...(t.depositFeeBps !== undefined && { depositFeeBps: int(t.depositFeeBps, 'terms.depositFeeBps', 10_000) }),
      ...(t.immediatelyReleaseBps !== undefined && { immediatelyReleaseBps: int(t.immediatelyReleaseBps, 'terms.immediatelyReleaseBps', 0xffff) }),
      ...(t.lockDuration !== undefined && { lockDuration: u64(t.lockDuration, 'terms.lockDuration') }),
      ...(t.vestDuration !== undefined && { vestDuration: u64(t.vestDuration, 'terms.vestDuration') }),
      ...(t.unsoldTokenAction !== undefined && { unsoldTokenAction: int(t.unsoldTokenAction, 'terms.unsoldTokenAction', 255) }),
    };
    const disableWithdraw = opt(b.disableWithdraw, (v) => bool(v, 'disableWithdraw')) ?? false;
    const cross = await readCross(d.account, addr(b.cross, 'cross'));
    checkOpenable(cross, creator);
    const release = await need('open_fixed_price_presale', OPEN_FIXED_PRICE_PRESALE_DISCRIMINATOR as Uint8Array);
    checkCleared(cross);
    const a = await adapters();
    const issues = a.checkFixedPriceTerms(terms);
    if (issues.length > 0) throw new RequestError(422, `The tranche cannot be opened: ${issues.map((i) => `${i.field}: ${i.message}`).join(' ')}`, { reason: issues[0]!.code.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase(), issues });
    await requireProgram(d.account, a.PRESALE_PROGRAM_ADDRESS, 'Meteora Presale Vault');
    const c = cross.data;
    const addresses = await a.presaleAddresses(base, c.baseMint, c.quoteMint);
    if (await d.account(addresses.presale)) throw new RequestError(409, `A presale already exists at ${addresses.presale}; use another \`base\` keypair.`, { reason: 'PRESALE_EXISTS', presale: addresses.presale });
    const held = await tokenBalance(d.account, await ata(creator, c.baseMint, c.baseTokenProgram));
    if (held === null) throw new RequestError(409, `${creator} has no base token account; the tranche's supply is moved from it.`, { reason: 'NO_BASE_ACCOUNT' });
    if (held < terms.supply) throw new RequestError(422, `${creator} holds ${held} of the base token; the tranche needs ${terms.supply}.`, { reason: 'INSUFFICIENT_BASE', have: held, need: terms.supply });
    const built = await a.buildOpenFixedPricePresale({ cross, creator: createNoopSigner(creator), base: createNoopSigner(base), terms, disableWithdraw });
    const ixs = [computeUnits(HEAVY_UNITS), built.instruction];
    const bytes = fits(creator, ixs, 'fixed-price presale');
    return send(reply, {
      ...compile(creator, ixs, await d.lifetime()),
      bytes,
      cross: cross.address,
      presale: addresses.presale,
      clearingPrice: built.clearingPrice,
      qPrice: built.qPrice,
      supply: terms.supply,
      note: 'The price is the cross\'s clearing price to the last bit Meteora stores (floor of P* x 2^64 / price scale); the adapter refuses any other. The buyer\'s deposit, claim and the unsold refund are Meteora\'s program. The presale is not a graduation venue and the vote does not gate it.',
      release,
    });
  });

  app.post('/v1/tx/seed-futarchy-dao', async (req, reply) => {
    const b = obj(req.body);
    only(b, ['cross', 'creator', 'baseAmount', 'quoteAmount', 'nonce', 'settings'], 'seed-futarchy-dao');
    const creator = addr(b.creator, 'creator');
    const baseAmount = u64(b.baseAmount, 'baseAmount');
    if (baseAmount === 0n) throw new RequestError(400, 'baseAmount must be above zero');
    const quoteGiven = opt(b.quoteAmount, (v) => u64(v, 'quoteAmount'));
    const nonceGiven = opt(b.nonce, (v) => u64(v, 'nonce'));
    const s = b.settings === undefined || b.settings === null ? null : obj(b.settings, 'settings');
    if (s) only(s, ['twapMaxObservationChangePerUpdate', 'twapStartDelaySeconds', 'minQuoteFutarchicLiquidity', 'minBaseFutarchicLiquidity', 'baseToStake', 'passThresholdBps', 'secondsPerProposal', 'teamSponsoredPassThresholdBps'], 'settings');
    const settings = s
      ? {
          ...(s.twapMaxObservationChangePerUpdate !== undefined && { twapMaxObservationChangePerUpdate: u64(s.twapMaxObservationChangePerUpdate, 'settings.twapMaxObservationChangePerUpdate') }),
          ...(s.twapStartDelaySeconds !== undefined && { twapStartDelaySeconds: int(s.twapStartDelaySeconds, 'settings.twapStartDelaySeconds', 0xffff_ffff) }),
          ...(s.minQuoteFutarchicLiquidity !== undefined && { minQuoteFutarchicLiquidity: u64(s.minQuoteFutarchicLiquidity, 'settings.minQuoteFutarchicLiquidity') }),
          ...(s.minBaseFutarchicLiquidity !== undefined && { minBaseFutarchicLiquidity: u64(s.minBaseFutarchicLiquidity, 'settings.minBaseFutarchicLiquidity') }),
          ...(s.baseToStake !== undefined && { baseToStake: u64(s.baseToStake, 'settings.baseToStake') }),
          ...(s.passThresholdBps !== undefined && { passThresholdBps: int(s.passThresholdBps, 'settings.passThresholdBps', 0xffff) }),
          ...(s.secondsPerProposal !== undefined && { secondsPerProposal: int(s.secondsPerProposal, 'settings.secondsPerProposal', 0xffff_ffff) }),
          ...(s.teamSponsoredPassThresholdBps !== undefined && { teamSponsoredPassThresholdBps: int(s.teamSponsoredPassThresholdBps, 'settings.teamSponsoredPassThresholdBps', 0x7fff, -0x8000) }),
        }
      : undefined;
    const cross = await readCross(d.account, addr(b.cross, 'cross'));
    checkOpenable(cross, creator);
    const release = await need('seed_futarchy_dao', SEED_FUTARCHY_DAO_DISCRIMINATOR as Uint8Array);
    checkCleared(cross);
    const a = await adapters();
    const c = cross.data;
    if (c.baseTokenProgram !== SPL_TOKEN_PROGRAM || c.quoteTokenProgram !== SPL_TOKEN_PROGRAM) {
      throw new RequestError(422, 'MetaDAO accepts legacy SPL Token mints only, and this cross has a Token-2022 token.', { reason: 'FUTARCHY_NEEDS_LEGACY_TOKENS' });
    }
    if (c.quoteDecimals !== 6) throw new RequestError(422, `MetaDAO requires a quote token with 6 decimals; this one has ${c.quoteDecimals}.`, { reason: 'FUTARCHY_QUOTE_DECIMALS', decimals: c.quoteDecimals });
    const price = c.clearing.__option === 'Some' ? c.clearing.value.price : 0n;
    const quoteAmount = quoteGiven ?? a.quoteForFutarchyBase(baseAmount, price, c.priceScale);
    if (a.depositMatchesPrice(baseAmount, quoteAmount, price, c.priceScale) !== true) {
      throw new RequestError(422, `The deposits must price the base at the clearing price to within one quote atom: ${baseAmount} base is ${a.quoteForFutarchyBase(baseAmount, price, c.priceScale)} quote (rounded up), not ${quoteAmount}.`, { reason: 'START_PRICE_NOT_CLEARING_PRICE', quoteAmount: a.quoteForFutarchyBase(baseAmount, price, c.priceScale) });
    }
    await requireProgram(d.account, a.FUTARCHY_PROGRAM_ADDRESS, 'MetaDAO futarchy');
    await requireProgram(d.account, a.SQUADS_PROGRAM_ADDRESS, 'Squads v4');
    const config = await d.account(a.squadsProgramConfigAddress());
    if (!config) throw new RequestError(409, 'Squads\' program config account is not on this cluster, so MetaDAO cannot create a DAO.', { reason: 'EXTERNAL_PROGRAM_MISSING', name: 'Squads v4 program config' });
    const treasury = a.squadsTreasuryOf(config.data);
    const graduation = await requireGraduationApproval(d.account, cross, 3);
    let nonce = nonceGiven;
    if (nonce === null) {
      for (let i = 0n; i < BigInt(MAX_NONCE_PROBES) && nonce === null; i++) if (!(await d.account((await a.futarchyAddresses(creator, i, c.baseMint, c.quoteMint)).dao))) nonce = i;
      if (nonce === null) throw new RequestError(409, `The creator already has ${MAX_NONCE_PROBES} DAOs from nonce 0; name a nonce.`, { reason: 'NONCE_RANGE_FULL' });
    } else if (await d.account((await a.futarchyAddresses(creator, nonce, c.baseMint, c.quoteMint)).dao)) {
      throw new RequestError(409, `A DAO with nonce ${nonce} already exists for this creator.`, { reason: 'DAO_EXISTS', nonce });
    }
    for (const [role, mint, program, need] of [['base', c.baseMint, c.baseTokenProgram, baseAmount], ['quote', c.quoteMint, c.quoteTokenProgram, quoteAmount]] as const) {
      const have = await tokenBalance(d.account, await ata(creator, mint, program));
      if (have === null) throw new RequestError(409, `${creator} has no ${role} token account; create it and fund it first.`, { reason: `NO_${role.toUpperCase()}_ACCOUNT` });
      if (have < need) throw new RequestError(422, `${creator} holds ${have} of the ${role} token; the DAO's opening liquidity needs ${need}.`, { reason: `INSUFFICIENT_${role.toUpperCase()}`, have, need });
    }
    const built = await a.buildSeedFutarchyDao({ cross, creator: createNoopSigner(creator), nonce, baseAmount, quoteAmount, squadsTreasury: treasury, ...(settings && { settings }) });
    const ixs = [computeUnits(HEAVY_UNITS), built.instruction];
    const bytes = fits(creator, ixs, 'MetaDAO DAO seeding');
    return send(reply, {
      ...compile(creator, ixs, await d.lifetime()),
      bytes,
      cross: cross.address,
      dao: built.addresses.dao,
      nonce,
      baseAmount,
      quoteAmount,
      twapInitialObservation: built.twap,
      ...(graduation.governed && { graduation }),
      note: 'The DAO\'s spot pool starts at the clearing price. Everything after the DAO exists (proposals, conditional markets, the TWAP) is MetaDAO\'s program.',
      release,
    });
  });
}
