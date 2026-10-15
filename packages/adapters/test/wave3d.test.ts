// The Wave 3D additions to the adapters: the fixed-price tranche (B4), the MetaDAO DAO (X3) and the Outcome account a governed cross's seeding instruction must name last (D10).
// The instructions run against the real Meteora Presale Vault, MetaDAO and Squads binaries in tests/core (presale-tranche, futarchy, graduate); here the byte layouts are compared
// with the programs' own interface definitions and the account lists with what cross_settle's gate reads.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as multisig from '@sqds/multisig';
import { type Address, createNoopSigner, generateKeyPairSigner, getAddressDecoder, getAddressEncoder, getProgramDerivedAddress, none, some } from '@solana/kit';
import {
  CROSS_BODY_LEN,
  CROSS_EXT_LEN,
  CROSS_GRADUATE_PROGRAM_ADDRESS,
  CrossKind,
  CrossState,
  Disclosure,
  FLAG_GOVERNED_GRADUATION,
  SupplyMode,
  completeRules,
  crossAddress,
  getCrossDecoder,
  getCrossEncoder,
  getCrossExtEncoder,
  readRuledCross,
  outcomeAddress,
} from '@opening-cross/sdk';
import {
  FUTARCHY_PRICE_SCALE,
  PRESALE_AUTHORITY,
  PRESALE_PROGRAM_ADDRESS,
  SQUADS_PROGRAM_ADDRESS,
  buildOpenDlmmPair,
  buildOpenFixedPricePresale,
  buildSeedDammV2,
  buildSeedFutarchyDao,
  buildSeedRaydiumCpmm,
  checkFixedPriceTerms,
  checkFutarchyCross,
  depositMatchesPrice,
  dlmmTokenBadgeAddress,
  encodeDaoParams,
  encodePresaleArgs,
  fixedPriceQ64,
  presaleAddresses,
  quoteForFutarchyBase,
  squadsProgramConfigAddress,
  squadsTreasuryOf,
  twapInitialObservation,
} from '../src/index.js';

const SPL = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' as Address;
const T22 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb' as Address;
const ZERO = '11111111111111111111111111111111' as Address;
const key = async () => (await generateKeyPairSigner()).address;

/** A tiny Borsh writer driven by an Anchor IDL: enough for structs, vectors, fixed arrays and unsigned integers. */
function borsh(idl: { types: { name: string; type: { kind: string; fields?: { name: string; type: unknown }[] } }[] }, type: unknown, value: unknown, out: number[] = []): number[] {
  const int = (bytes: number, v: bigint) => {
    for (let i = 0; i < bytes; i++) out.push(Number((v >> BigInt(8 * i)) & 0xffn));
  };
  if (typeof type === 'string') {
    const bytes = { u8: 1, u16: 2, u32: 4, u64: 8, u128: 16 }[type];
    if (!bytes) throw new Error(`type ${type}`);
    int(bytes, BigInt(value as bigint | number));
    return out;
  }
  const t = type as { array?: [unknown, number]; vec?: unknown; defined?: { name: string } };
  if (t.array) {
    const [inner, n] = t.array;
    const items = value as unknown[];
    if (items.length !== n) throw new Error('array length');
    for (const item of items) borsh(idl, inner, item, out);
    return out;
  }
  if (t.vec) {
    const items = value as unknown[];
    int(4, BigInt(items.length));
    for (const item of items) borsh(idl, t.vec, item, out);
    return out;
  }
  if (t.defined) {
    const def = idl.types.find((x) => x.name === t.defined!.name)!;
    for (const f of def.type.fields!) borsh(idl, f.type, (value as Record<string, unknown>)[f.name], out);
    return out;
  }
  throw new Error('unsupported type');
}

const presaleIdl = JSON.parse(readFileSync(fileURLToPath(new URL('../../../idls/presale.json', import.meta.url)), 'utf8'));

describe('the fixed-price tranche (B4)', () => {
  const terms = { maxCap: 650_000_000n, minCap: 1_000_000n, start: 1_800_000_600n, end: 1_800_004_200n, supply: 500_000_000n, buyerMinDeposit: 1_000n, buyerMaxDeposit: 650_000_000n };

  it('encodes InitializePresaleArgs exactly as the presale program\'s IDL lays it out, field by field', () => {
    const expected = borsh(presaleIdl, { defined: { name: 'InitializePresaleArgs' } }, {
      presale_params: { presale_maximum_cap: terms.maxCap, presale_minimum_cap: terms.minCap, presale_start_time: terms.start, presale_end_time: terms.end, whitelist_mode: 0, presale_mode: 0, unsold_token_action: 0, disable_earlier_presale_end_once_cap_reached: 0, padding: new Array(30).fill(0) },
      locked_vesting_params: { immediately_release_bps: 10_000, lock_duration: 0, vest_duration: 0, immediate_release_timestamp: terms.end, padding: new Array(24).fill(0) },
      padding: new Array(32).fill(0),
      presale_registries: [{ buyer_minimum_deposit_cap: terms.buyerMinDeposit, buyer_maximum_deposit_cap: terms.buyerMaxDeposit, presale_supply: terms.supply, deposit_fee_bps: 0, padding: new Array(32).fill(0) }],
    });
    expect(expected).toHaveLength(210);
    expect(Array.from(encodePresaleArgs(terms))).toEqual(expected);
    // the knobs land where the IDL puts them
    const vesting = encodePresaleArgs({ ...terms, immediatelyReleaseBps: 2_500, lockDuration: 86_400n, vestDuration: 172_800n, depositFeeBps: 75, unsoldTokenAction: 1 });
    const other = borsh(presaleIdl, { defined: { name: 'InitializePresaleArgs' } }, {
      presale_params: { presale_maximum_cap: terms.maxCap, presale_minimum_cap: terms.minCap, presale_start_time: terms.start, presale_end_time: terms.end, whitelist_mode: 0, presale_mode: 0, unsold_token_action: 1, disable_earlier_presale_end_once_cap_reached: 0, padding: new Array(30).fill(0) },
      locked_vesting_params: { immediately_release_bps: 2_500, lock_duration: 86_400, vest_duration: 172_800, immediate_release_timestamp: terms.end, padding: new Array(24).fill(0) },
      padding: new Array(32).fill(0),
      presale_registries: [{ buyer_minimum_deposit_cap: terms.buyerMinDeposit, buyer_maximum_deposit_cap: terms.buyerMaxDeposit, presale_supply: terms.supply, deposit_fee_bps: 75, padding: new Array(32).fill(0) }],
    });
    expect(Array.from(vesting)).toEqual(other);
  });

  it('prices the vault at floor(P* x 2^64 / scale) and refuses a zero scale', () => {
    expect(fixedPriceQ64(1_300_000n, 1_000_000n)).toBe((13n << 64n) / 10n);
    expect(fixedPriceQ64(1n, 3n)).toBe((1n << 64n) / 3n);
    expect(() => fixedPriceQ64(1n, 0n)).toThrow();
    // floor, never ceiling: one more unit would be a different price
    expect(fixedPriceQ64(1n, 3n) * 3n).toBeLessThan(1n << 64n);
  });

  it('refuses incoherent terms by field', () => {
    expect(checkFixedPriceTerms(terms)).toEqual([]);
    expect(checkFixedPriceTerms({ ...terms, supply: 0n }).map((i) => i.field)).toEqual(['supply']);
    expect(checkFixedPriceTerms({ ...terms, end: terms.start }).map((i) => i.field)).toEqual(['end']);
    expect(checkFixedPriceTerms({ ...terms, minCap: terms.maxCap + 1n }).map((i) => i.field)).toEqual(['maxCap']);
    expect(checkFixedPriceTerms({ ...terms, buyerMinDeposit: terms.buyerMaxDeposit + 1n }).map((i) => i.field)).toEqual(['buyerMaxDeposit']);
    expect(checkFixedPriceTerms({ ...terms, immediatelyReleaseBps: 10_001 }).map((i) => i.field)).toEqual(['immediatelyReleaseBps']);
  });

  it('builds open_fixed_price_presale with the presale\'s own PDAs and q_price = P*, and no outcome account even for a governed cross', async () => {
    const creator = await key();
    const base = await generateKeyPairSigner();
    const governed = await cleared({ creator, governed: true });
    const built = await buildOpenFixedPricePresale({ cross: governed, creator: createNoopSigner(creator), base, terms });
    const a = await presaleAddresses(base.address, governed.data.baseMint, governed.data.quoteMint);
    expect(built.qPrice).toBe(fixedPriceQ64(1_300_000n, 1_000_000n));
    expect(built.addresses).toEqual(a);
    const accounts = built.instruction.accounts!.map((x) => x.address);
    expect(accounts).toEqual(expect.arrayContaining([creator, governed.address, base.address, a.presale, a.fixedPricePresaleParams, PRESALE_AUTHORITY, a.presaleVault, a.quoteTokenVault, a.eventAuthority, PRESALE_PROGRAM_ADDRESS]));
    expect(accounts).not.toContain(await outcomeAddress(governed.address));
    const data = built.instruction.data!;
    expect(Array.from(data.slice(8 + 4, 8 + 4 + 210))).toEqual(Array.from(encodePresaleArgs(terms))); // args: Vec<u8>
    // an uncleared cross has no price to pin
    await expect(buildOpenFixedPricePresale({ cross: await cleared({ creator, state: CrossState.Live }), creator: createNoopSigner(creator), base, terms })).rejects.toThrow(/not cleared/);
    await expect(buildOpenFixedPricePresale({ cross: governed, creator: createNoopSigner(creator), base, terms: { ...terms, supply: 0n } })).rejects.toThrow(/supply/);
  });
});

describe('the MetaDAO DAO (X3)', () => {
  it('pins the TWAP\'s first observation to floor(P* x 10^12 / scale) and prices the deposit at P* rounding up', () => {
    expect(twapInitialObservation(1_300_000n, 1_000_000n)).toBe(1_300_000_000_000n);
    expect(twapInitialObservation(1n, 3n)).toBe(333_333_333_333n); // floor
    expect(() => twapInitialObservation(1n, 0n)).toThrow();
    expect(quoteForFutarchyBase(1_000_000_000n, 1_300_000n, 1_000_000n)).toBe(1_300_000_000n);
    expect(quoteForFutarchyBase(7n, 1n, 3n)).toBe(3n); // ceil(7/3)
    expect(FUTARCHY_PRICE_SCALE).toBe(10n ** 12n);
    // the program accepts the exact quote rounded down or up and nothing else
    expect(depositMatchesPrice(10n, 4n, 4n, 3n)).toBe(false);
    expect(depositMatchesPrice(10n, 13n, 4n, 3n)).toBe(true); // floor(40/3)
    expect(depositMatchesPrice(10n, 14n, 4n, 3n)).toBe(true); // ceil(40/3)
    expect(depositMatchesPrice(10n, 15n, 4n, 3n)).toBe(false);
    expect(depositMatchesPrice(10n, 12n, 4n, 3n)).toBe(false);
    expect(depositMatchesPrice(10n, 20n, 2n, 1n)).toBe(true); // exact: floor == ceil
    expect(depositMatchesPrice(10n, 21n, 2n, 1n)).toBe(false);
    expect(depositMatchesPrice(0n, 0n, 2n, 1n)).toBeNull();
  });

  it('encodes MetaDAO\'s InitializeDaoParams in its declared field order (109 bytes) with the first field pinned', () => {
    const team = '11111111111111111111111111111115' as Address;
    const p = encodeDaoParams(1_300_000_000_000n, 7n, team, { passThresholdBps: 450, secondsPerProposal: 86_400, teamSponsoredPassThresholdBps: -200, baseToStake: 9n });
    expect(p).toHaveLength(109);
    const dv = new DataView(p.buffer);
    const u128 = (at: number) => dv.getBigUint64(at, true) + (dv.getBigUint64(at + 8, true) << 64n);
    expect(u128(0)).toBe(1_300_000_000_000n); // twap_initial_observation
    expect(u128(16)).toBe(FUTARCHY_PRICE_SCALE); // twap_max_observation_change_per_update
    expect(dv.getUint32(32, true)).toBe(0); // twap_start_delay_seconds
    expect(dv.getBigUint64(36, true)).toBe(1n); // min_quote_futarchic_liquidity
    expect(dv.getBigUint64(44, true)).toBe(1n); // min_base_futarchic_liquidity
    expect(dv.getBigUint64(52, true)).toBe(9n); // base_to_stake
    expect(dv.getUint16(60, true)).toBe(450); // pass_threshold_bps
    expect(dv.getUint32(62, true)).toBe(86_400); // seconds_per_proposal
    expect(dv.getBigUint64(66, true)).toBe(7n); // nonce
    expect(p[74]).toBe(0); // initial_spending_limit: None
    expect(dv.getInt16(75, true)).toBe(-200); // team_sponsored_pass_threshold_bps
    expect(getAddressDecoder().decode(p.slice(77, 109))).toBe(team);
    // the default is the setting the adapter's LiteSVM tests run with
    expect(new DataView(encodeDaoParams(1n, 1n, team).buffer).getUint16(60, true)).toBe(300);
  });

  it('knows Squads\' program id and reads the treasury where Squads checks it', () => {
    expect(SQUADS_PROGRAM_ADDRESS).toBe(multisig.PROGRAM_ID.toBase58());
    const config = new Uint8Array(8 + 32 + 8 + 32 + 40);
    const treasury = '11111111111111111111111111111117' as Address;
    config.set(getAddressEncoder().encode(treasury) as Uint8Array, 8 + 32 + 8);
    expect(squadsTreasuryOf(config)).toBe(treasury);
    expect(() => squadsTreasuryOf(new Uint8Array(10))).toThrow(/too short/);
    expect(squadsProgramConfigAddress()).toBe(multisig.getProgramConfigPda({})[0].toBase58());
  });

  it('refuses a cross with a Token-2022 token before any call, and builds for legacy tokens with the pool at P*', async () => {
    const creator = await key();
    const t22 = await cleared({ creator, baseProgram: T22 });
    expect(checkFutarchyCross(t22).map((i) => i.code)).toEqual(['FutarchyNeedsLegacyTokens']);
    await expect(buildSeedFutarchyDao({ cross: t22, creator: createNoopSigner(creator), nonce: 1n, baseAmount: 10n, squadsTreasury: ZERO })).rejects.toThrow(/FutarchyNeedsLegacyTokens/);
    const cross = await cleared({ creator });
    const treasury = '11111111111111111111111111111117' as Address;
    const built = await buildSeedFutarchyDao({ cross, creator: createNoopSigner(creator), nonce: 1n, baseAmount: 1_000_000_000n, squadsTreasury: treasury });
    expect(built.quoteAmount).toBe(1_300_000_000n);
    expect(built.twap).toBe(1_300_000_000_000n);
    const accounts = built.instruction.accounts!.map((x) => x.address);
    expect(accounts).toEqual(expect.arrayContaining([creator, cross.address, built.addresses.dao, built.addresses.squadsMultisig, built.addresses.squadsMultisigVault, SQUADS_PROGRAM_ADDRESS, built.addresses.squadsProgramConfig, treasury, built.addresses.spendingLimit, built.addresses.ammPosition]));
    expect(accounts).not.toContain(await outcomeAddress(cross.address)); // not governed: no extra account
    const governed = await cleared({ creator, governed: true });
    const g = await buildSeedFutarchyDao({ cross: governed, creator: createNoopSigner(creator), nonce: 1n, baseAmount: 1_000_000_000n, squadsTreasury: treasury });
    expect(g.instruction.accounts!.at(-1)!.address).toBe(await outcomeAddress(governed.address));
    await expect(buildSeedFutarchyDao({ cross, creator: createNoopSigner(creator), nonce: 1n, baseAmount: 0n, squadsTreasury: treasury })).rejects.toThrow(/baseAmount/);
    await expect(buildSeedFutarchyDao({ cross, creator: createNoopSigner(creator), nonce: 1n, baseAmount: 1_000_000_000n, quoteAmount: 1_300_000_002n, squadsTreasury: treasury })).rejects.toThrow(/StartPriceNotClearingPrice/);
  });
});

describe('the Outcome account of a governed cross (D10)', () => {
  it('is the last remaining account of every seeding instruction of a governed cross, after the DLMM badges, and absent from an ungoverned cross', async () => {
    const creator = await key();
    const signer = createNoopSigner(creator);
    for (const governed of [false, true]) {
      const cross = await cleared({ creator, governed });
      const outcome = await outcomeAddress(cross.address);
      const damm = await buildSeedDammV2({ cross, creator: signer, baseAmount: 1_000_000_000n, quoteAmount: 1_300_000_000n, feeBps: 100 });
      const dlmm = await buildOpenDlmmPair({ cross, creator: signer, binStep: 10, baseFactor: 10_000 });
      const badged = await buildOpenDlmmPair({ cross, creator: signer, binStep: 10, baseFactor: 10_000, badges: { base: true, quote: false } });
      const batched = await buildSeedDammV2({ cross, creator: signer, baseAmount: 1_000_000_000n, quoteAmount: 1_300_000_000n, feeBps: 200, batch: { windowSecs: 3_600, activationPoint: 1_800_010_000n, endingFeeBps: 50, periods: 4, periodSecs: 600 } });
      const raydium = await buildSeedRaydiumCpmm({ cross, creator: signer, baseAmount: 1_000_000_000n });
      for (const [name, ix] of [['damm', damm.instruction], ['dlmm', dlmm.instruction], ['dlmm badged', badged.instruction], ['damm batched', batched.instruction], ['raydium', raydium.instruction]] as const) {
        const accounts = ix.accounts!;
        if (governed) {
          expect(accounts.at(-1)!.address, name).toBe(outcome);
          expect(accounts.at(-1)!.role, name).toBe(0); // read-only
        } else {
          expect(accounts.map((x) => x.address), name).not.toContain(outcome);
        }
      }
      if (governed) {
        // the badge accounts keep their place: base badge, quote (none: the DLMM program), then the outcome
        const tail = badged.instruction.accounts!.slice(-3).map((x) => x.address);
        expect(tail).toEqual([dlmmTokenBadgeAddress(cross.data.baseMint), 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo', outcome]);
        // the outcome is the PDA ["outcome", cross] of cross_graduate, derived here independently of the SDK helper
        const [expected] = await getProgramDerivedAddress({ programAddress: CROSS_GRADUATE_PROGRAM_ADDRESS, seeds: [new TextEncoder().encode('outcome'), getAddressEncoder().encode(cross.address)] });
        expect(outcome).toBe(expected);
      }
    }
  });
});

/** A cleared cross (P* = 1.3), with or without the governed-graduation flag in its rules tail. */
async function cleared(o: { creator: Address; governed?: boolean; state?: CrossState; baseProgram?: Address }) {
  const [baseMint, quoteMint] = await Promise.all([key(), key()]);
  const id = 1n;
  const address = await crossAddress(o.creator, id);
  const state = o.state ?? CrossState.Finalized;
  const body = getCrossEncoder().encode({
    creator: o.creator, crossId: id, kind: CrossKind.Launch, supplyMode: SupplyMode.Escrow, disclosure: Disclosure.Open, state, baseMint, quoteMint, baseTokenProgram: o.baseProgram ?? SPL, quoteTokenProgram: SPL, baseDecimals: 6, quoteDecimals: 6, proceedsTo: o.creator,
    minPrice: 1_000_000n, tick: 100_000n, ticks: 20, priceScale: 1_000_000n, openTs: 1n, closeTs: 2n, revealEndTs: 3n, referencePrice: none(), minMatched: 0n, maxImbalanceBps: none(), protocolFeeBps: 30, integratorFeeBps: 0, integrator: o.creator, feeRecipient: o.creator,
    gateMint: none(), shards: 2, maxOrders: 64, dustBond: 0n, ordersTotal: 2, ordersOpen: 0, mergedMask: 3,
    clearing: state === CrossState.Live ? none() : some({ price: 1_300_000n, matched: 1_000n, demand: 1_000n, supply: 1_000n, rationed: 0, marginalQuantity: 0n, marginalRemaining: 0n, marginalOrders: 0 }),
    noPrintReason: none(), buyerPaid: 0n, baseBought: 0n, baseSold: 0n, sellerPaid: 0n, feesAccrued: 0n, oracle: none(), calendar: none(), settler: none(), settleDeadlineTs: 0n, baseBound: true, bump: 1, quoteVaultBump: 1, baseVaultBump: 1, bookBump: 1,
  } as never);
  const data = new Uint8Array(CROSS_BODY_LEN + (o.governed ? CROSS_EXT_LEN : 0));
  data.set(body);
  if (o.governed) {
    const r = completeRules({});
    data.set(
      getCrossExtEncoder().encode({
        version: 1, rulesSet: true, createdSlot: 1n, flags: FLAG_GOVERNED_GRADUATION, guards: { ...r.guards, haltSource: null }, ending: r.ending,
        draw: { epoch: 0, pendingSlot: 0n, pendingPurpose: 0, seed: new Uint8Array(32), seedEpoch: 0, seedReady: false, endBucket: 255, extPending: false, extensionUsed: false, auxMerged: 0n },
        identity: r.identity, alloc: { ...r.alloc, priorityGate: null }, neutrality: { insiders: Array.from({ length: 8 }, () => ZERO), insiderCount: 0, insiderCliffSecs: 0, insiderVestSecs: 0, bondQuote: 0n, challengeSecs: 0 },
        neutralState: { bondHeld: 0n, slashed: 0n, openChallenges: 0, challenges: 0 }, clearing: { classQty: [0n, 0n, 0n], tickets: 0, rho: 0, clearedTs: 0n, insiderUb: 0n }, referral: r.referral,
        oracleSet: { extraFeeds: [new Uint8Array(32), new Uint8Array(32)] as never, extraCount: 0, quorum: 0, maxSpreadBps: 0, offHoursWidenBps: 0 },
      } as never),
      CROSS_BODY_LEN,
    );
  }
  void getCrossDecoder;
  return readRuledCross(address, data);
}
