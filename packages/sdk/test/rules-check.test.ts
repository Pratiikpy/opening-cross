// The checks `set_rules` makes, run before a transaction exists, and the size of the pair a rules cross is created with.
import { describe, expect, it } from 'vitest';
import { type Address, createNoopSigner, getAddressDecoder } from '@solana/kit';
import { TOKEN_2022_PROGRAM_ADDRESS } from '@solana-program/token-2022';
import {
  CrossKind,
  Disclosure,
  FLAG_FEEDS_LENDERS,
  FLAG_RESUMES_HALT,
  FLAG_STANDARD_GRID,
  SupplyMode,
  TRANSACTION_LIMIT_BYTES,
  assertFits,
  buildCreateRuledCross,
  checkRules,
  wireSize,
  type RuleContext,
  type RulesConfig,
} from '../src/index.js';

const addr = (n: number) => getAddressDecoder().decode(new Uint8Array(32).fill(n + 1)) as Address;
const [CREATOR, BASE, QUOTE, GATE, REFERRER, HALT] = [0, 1, 2, 3, 4, 5].map(addr);
const ctx = (over: Partial<RuleContext> = {}): RuleContext => ({
  supplyMode: SupplyMode.Mint, minPrice: 1_000_000n, tick: 100_000n, ticks: 20, openTs: 1_000n, closeTs: 2_000n, referencePrice: null, gateMint: null, oracleFeedId: null, calendar: null, ...over,
});
const codes = (rules: RulesConfig, c: Partial<RuleContext> = {}) => checkRules(ctx(c), rules).map((i) => i.code);

describe('checkRules', () => {
  it('accepts no rules, and a coherent rule set', () => {
    expect(codes({})).toEqual([]);
    expect(
      codes(
        {
          guards: { minRaiseQuote: 1_000_000n, maxMatched: 100n, totalSupply: 1_000n, minFloatBps: 500, maxFdvX100: 200, moveBps: 2_000, anchorPrice: 1_200_000n },
          ending: { endingSecs: 300, buckets: 3, randomEnd: true, cancelCutoffSecs: 30, extensionMinSecs: 60, extensionMaxSecs: 600 },
          identity: { capQuote: 5_000_000n, maxOrders: 1 },
          alloc: { reserveBps: [3_000, 2_000, 1_000], smallCapQuote: 5_000_000n, lotteryUnit: 5_000_000n, minLockSecs: 60, earlyUntilTs: 1_500n, class1CliffSecs: 10, class1VestSecs: 20 },
          neutrality: { insiders: [REFERRER], insiderCliffSecs: 10, bondQuote: 1n, challengeSecs: 3_600 },
          referral: { referrer: REFERRER, shareBps: 2_500 },
        },
        { gateMint: GATE },
      ),
    ).toEqual([]);
  });

  it('refuses each rule the program refuses, by a code that names it', () => {
    expect(codes({ guards: { maxMatched: 5n } }, { supplyMode: SupplyMode.Escrow })).toEqual(['CAP_NEEDS_MINT']);
    expect(codes({ flags: FLAG_FEEDS_LENDERS }, { supplyMode: SupplyMode.DeferredMint })).toEqual(['NOT_FOR_DEFERRED']);
    expect(codes({ flags: FLAG_RESUMES_HALT })).toEqual(['RESUME_NEEDS_HALT']);
    expect(codes({ flags: FLAG_RESUMES_HALT, guards: { haltSource: HALT } })).toEqual([]);
    expect(codes({ guards: { minFloatBps: 10_001 } })).toContain('FLOAT_RANGE');
    expect(codes({ guards: { maxFdvX100: 50 } })).toContain('FDV_RANGE');
    expect(codes({ guards: { minFloatBps: 100 } }, { supplyMode: SupplyMode.DeferredMint })).toContain('SUPPLY_DECLARATION');
    expect(codes({ flags: FLAG_STANDARD_GRID })).toEqual(['GRID_ESTIMATE']);
    expect(codes({ flags: FLAG_STANDARD_GRID, guards: { gridEstimate: 5_000_000n } })).toEqual(['GRID_POLICY']);
    expect(codes({ flags: FLAG_STANDARD_GRID, guards: { gridEstimate: 1_500_000n } }, { tick: 10_000n, ticks: 100 })).toEqual([]);
    expect(codes({ guards: { moveBps: 50_001 } })).toContain('MOVE_RANGE');
    expect(codes({ guards: { moveBps: 100 } })).toEqual(['MOVE_ANCHOR']);
    expect(codes({ guards: { moveBps: 100 } }, { referencePrice: 1_200_000n })).toEqual([]);
  });

  it('refuses a bad ending and a bad extension', () => {
    expect(codes({ ending: { endingSecs: 5_000, buckets: 4 } })).toEqual(['ENDING']);
    expect(codes({ ending: { endingSecs: 300, buckets: 9 } })).toEqual(['ENDING']);
    expect(codes({ ending: { endingSecs: 3, buckets: 4 } })).toEqual(['ENDING']);
    expect(codes({ ending: { endingSecs: 300, buckets: 1, randomEnd: true } })).toEqual(['ENDING_DRAW']);
    expect(codes({ ending: { buckets: 2 } })).toEqual(['ENDING_OFF']);
    expect(codes({ ending: { extensionMaxSecs: 100, extensionMinSecs: 0 } })).toEqual(['EXTENSION']);
    expect(codes({ ending: { extensionMaxSecs: 8 * 86_400, extensionMinSecs: 60 } })).toEqual(['EXTENSION']);
    expect(codes({ ending: { extensionMinSecs: 60 } })).toEqual(['EXTENSION_OFF']);
  });

  it('refuses identity limits without a gate, and allocation classes that lack what they stand on', () => {
    expect(codes({ identity: { capQuote: 1n } })).toEqual(['IDENTITY_NEEDS_GATE']);
    expect(codes({ alloc: { reserveBps: [6_000, 6_000, 0], smallCapQuote: 1n, minLockSecs: 60 } }, { gateMint: GATE })).toEqual(['RESERVE_SUM']);
    expect(codes({ alloc: { reserveBps: [1_000, 0, 0], smallCapQuote: 1n } }, { supplyMode: SupplyMode.Escrow, gateMint: GATE })).toEqual(['CLASSES_NEED_MINT']);
    expect(codes({ alloc: { reserveBps: [1_000, 0, 0] } })).toContain('CLASS1_CAP');
    expect(codes({ alloc: { smallCapQuote: 1n } })).toContain('CLASS1_GATE');
    expect(codes({ alloc: { reserveBps: [0, 1_000, 0] } })).toEqual(['CLASS2_LOCK']);
    expect(codes({ alloc: { reserveBps: [0, 0, 1_000] } })).toEqual(['CLASS3_PRIORITY']);
    expect(codes({ alloc: { lotteryUnit: 5n } })).toContain('LOTTERY');
    expect(codes({ alloc: { earlyUntilTs: 500n } })).toEqual(['EARLY_WINDOW']);
    expect(codes({ alloc: { minLockSecs: 5 * 365 * 86_400 } })).toEqual(['LOCK_RANGE']);
    expect(codes({ alloc: { class1VestSecs: 10 } })).toEqual(['CLASS1_VESTING']);
    expect(codes({ alloc: { minLockSecs: 60 } }, { supplyMode: SupplyMode.DeferredMint })).toEqual(['LOCKS_NOT_FOR_DEFERRED']);
  });

  it('refuses a bad insider list, a bond without a window, a window without a bond', () => {
    expect(codes({ neutrality: { insiders: [REFERRER, REFERRER] } })).toEqual(['INSIDER_DUPLICATE']);
    expect(codes({ neutrality: { insiders: ['11111111111111111111111111111111' as Address] } })).toEqual(['INSIDER_ZERO']);
    expect(codes({ neutrality: { insiders: Array.from({ length: 9 }, (_, i) => addr(20 + i)) } })).toEqual(['MALFORMED']);
    expect(codes({ neutrality: { bondQuote: 1n, challengeSecs: 60 } })).toEqual(['CHALLENGE_WINDOW']);
    expect(codes({ neutrality: { challengeSecs: 3_600 } })).toEqual(['CHALLENGE_WITHOUT_BOND']);
  });

  it('refuses a bad oracle set and a bad referral', () => {
    const feed = new Uint8Array(32).fill(1);
    expect(codes({ oracleSet: { extraFeeds: [feed] } })).toEqual(['ORACLE_SET_NEEDS_GUARD']);
    const primary = new Uint8Array(32).fill(9);
    expect(codes({ oracleSet: { extraFeeds: [feed] } }, { oracleFeedId: primary })).toEqual([]);
    expect(codes({ oracleSet: { extraFeeds: [primary] } }, { oracleFeedId: primary })).toEqual(['FEED']);
    expect(codes({ oracleSet: { extraFeeds: [feed], quorum: 3 } }, { oracleFeedId: primary })).toEqual(['QUORUM']);
    expect(codes({ oracleSet: { offHoursWidenBps: 100 } }, { oracleFeedId: primary })).toEqual(['WIDEN_NEEDS_CALENDAR']);
    expect(codes({ oracleSet: { offHoursWidenBps: 100 } }, { oracleFeedId: primary, calendar: addr(30) })).toEqual([]);
    expect(codes({ oracleSet: { extraFeeds: [feed, feed] } }, { oracleFeedId: primary })).toEqual(['FEED']);
    expect(codes({ referral: { referrer: REFERRER, shareBps: 6_000 } })).toEqual(['REFERRAL']);
    expect(codes({ referral: { referrer: REFERRER } })).toEqual(['REFERRAL_ZERO']);
  });
});

describe('the size of a transaction', () => {
  const build = (rules: RulesConfig) =>
    buildCreateRuledCross({
      creator: createNoopSigner(CREATOR), baseMint: BASE, quoteMint: QUOTE, baseTokenProgram: TOKEN_2022_PROGRAM_ADDRESS, quoteTokenProgram: TOKEN_2022_PROGRAM_ADDRESS, crossId: 1n, kind: CrossKind.Launch, supplyMode: SupplyMode.Mint,
      disclosure: Disclosure.Open, minPrice: 1_000_000n, tick: 100_000n, ticks: 20, priceScale: 1_000_000n, openTs: 1n, closeTs: 100n, revealEndTs: 100n, referencePrice: null, minMatched: 0n, maxImbalanceBps: null, integratorFeeBps: 0, integrator: CREATOR,
      gateMint: null, shards: 2, maxOrders: 32, proceedsTo: CREATOR, schedule: [{ price: 1n, quantity: 1n }, { price: 2n, quantity: 1n }, { price: 3n, quantity: 1n }], settler: null, settleDeadlineTs: 0n, oracle: null, calendar: null, rules,
    });

  it('the common rule sets fit one transaction with the creation, and the answer is the size the network measures', async () => {
    for (const rules of [{}, { ending: { endingSecs: 3_600, buckets: 4, randomEnd: true, cancelCutoffSecs: 600 }, referral: { referrer: REFERRER, shareBps: 2_500 }, guards: { minRaiseQuote: 1_000_000n, minFloatBps: 1_000, totalSupply: 10n ** 12n }, neutrality: { insiders: [REFERRER] } }]) {
      const built = await build(rules);
      const size = wireSize(CREATOR, built.atomic);
      expect(size).toBeLessThanOrEqual(TRANSACTION_LIMIT_BYTES);
      expect(assertFits(CREATOR, built.atomic)).toBe(size);
    }
  });

  it('a transaction over the limit is named as too large before it is sent', async () => {
    const built = await build({ neutrality: { insiders: Array.from({ length: 8 }, (_, i) => addr(40 + i)) }, oracleSet: { extraFeeds: [new Uint8Array(32).fill(1)] } });
    // set_rules sends the lists unpadded, so the size grows by exactly the insiders named (32 bytes each)
    const none = wireSize(CREATOR, (await build({})).atomic);
    expect(wireSize(CREATOR, [(await build({ neutrality: { insiders: [REFERRER] } })).atomic[0]!, (await build({ neutrality: { insiders: [REFERRER] } })).atomic[1]!]) - none).toBe(32);
    expect(built.atomic.length).toBe(2);
    const many = [...built.atomic, ...built.atomic, ...built.atomic];
    expect(() => assertFits(CREATOR, many, 'creation')).toThrow(/TransactionTooLarge/);
  });
});
