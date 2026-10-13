// The verifier over crosses that carry rules: the ending, the draw and the shards, checked against the account as the program writes it. The accounts are
// encoded here (the program is not run: LiteSVM needs Linux), so what this proves is the verifier's own logic and that it leaves a cross without rules, and
// a cross with rules but no ending, exactly as it was. `tests/core/test/rules-verifier.test.ts` runs the same verifier against accounts the real program wrote.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { type Address, getAddressDecoder } from '@solana/kit';
import {
  CROSS_BODY_LEN,
  CROSS_EXT_LEN,
  CrossKind,
  CrossState,
  Disclosure,
  SupplyMode,
  completeRules,
  getCrossEncoder,
  getCrossExtEncoder,
  getLevelsEncoder,
} from '@opening-cross/cross-core-client';
import { PROOF_SCHEMA, PROOF_SCHEMA_V2, bookAddressOf, drawEndBucket, verifyCross } from '../src/index.js';

const addr = (n: number) => getAddressDecoder().decode(new Uint8Array(32).fill(n)) as Address;
const CROSS = addr(1);
const ZERO = addr(0);
const seedOf = (label: string) => Uint8Array.from(createHash('sha256').update(label).digest());

type Opts = {
  state?: CrossState;
  ext?: boolean;
  ending?: { endingSecs: number; buckets: number; randomEnd: boolean };
  endBucket?: number;
  epoch?: number;
  seed?: Uint8Array;
  auxMerged?: bigint;
  mergedMask?: number;
  shards?: number;
};

/** A cleared cross with one sell of 10 at 1.20 and one buy of 4 at 1.30: P* 1.20, matched 4. */
async function proofFor(o: Opts = {}, draws?: Parameters<typeof verifyCross>[2]) {
  const shards = o.shards ?? 2;
  const body = getCrossEncoder().encode({
    creator: ZERO, crossId: 1n, kind: CrossKind.Launch, supplyMode: SupplyMode.Mint, disclosure: Disclosure.Open, state: o.state ?? CrossState.Cleared,
    baseMint: ZERO, quoteMint: ZERO, baseTokenProgram: ZERO, quoteTokenProgram: ZERO, baseDecimals: 6, quoteDecimals: 6, proceedsTo: ZERO,
    minPrice: 1_000_000n, tick: 50_000n, ticks: 40, priceScale: 1_000_000n, openTs: 0n, closeTs: 1_000n, revealEndTs: 1_100n, referencePrice: null, minMatched: 0n,
    maxImbalanceBps: null, protocolFeeBps: 0, integratorFeeBps: 0, integrator: ZERO, feeRecipient: ZERO, gateMint: null, shards, maxOrders: 1000, dustBond: 0n,
    ordersTotal: 2, ordersOpen: 0, mergedMask: o.mergedMask ?? (1 << shards) - 1,
    clearing: (o.state ?? CrossState.Cleared) === CrossState.Live ? null : { price: 1_200_000n, matched: 4n, demand: 4n, supply: 10n, rationed: 2, marginalQuantity: 0n, marginalRemaining: 0n, marginalOrders: 0 },
    noPrintReason: null, buyerPaid: 0n, baseBought: 0n, baseSold: 0n, sellerPaid: 0n, feesAccrued: 0n, oracle: null, calendar: null, settler: null, settleDeadlineTs: 0n,
    baseBound: true, bump: 255, quoteVaultBump: 255, baseVaultBump: 255, bookBump: 255,
  } as never);
  const data = new Uint8Array(CROSS_BODY_LEN + (o.ext ? CROSS_EXT_LEN : 0));
  data.set(body);
  if (o.ext) {
    const r = completeRules({ ending: o.ending ?? {} });
    data.set(
      getCrossExtEncoder().encode({
        version: 1, rulesSet: true, createdSlot: 1n, flags: 0, guards: { ...r.guards, haltSource: null }, ending: r.ending,
        draw: { epoch: o.epoch ?? 0, pendingSlot: 0n, pendingPurpose: 0, seed: o.seed ?? new Uint8Array(32), seedEpoch: o.epoch ?? 0, seedReady: o.seed !== undefined, endBucket: o.endBucket ?? 255, extPending: false, extensionUsed: (o.epoch ?? 0) > 0, auxMerged: o.auxMerged ?? 0n },
        identity: r.identity, alloc: { ...r.alloc, priorityGate: null },
        neutrality: { insiders: Array.from({ length: 8 }, () => ZERO), insiderCount: 0, insiderCliffSecs: 0, insiderVestSecs: 0, bondQuote: 0n, challengeSecs: 0 },
        neutralState: { bondHeld: 0n, slashed: 0n, openChallenges: 0, challenges: 0 },
        clearing: { classQty: [0n, 0n, 0n], tickets: 0, rho: 0, clearedTs: 0n, insiderUb: 0n }, referral: r.referral,
        oracleSet: { extraFeeds: [new Uint8Array(32), new Uint8Array(32)] as never, extraCount: 0, quorum: 0, maxSpreadBps: 0, offHoursWidenBps: 0 },
      } as never),
      CROSS_BODY_LEN,
    );
  }
  const buy = new Array<bigint>(256).fill(0n);
  const sell = new Array<bigint>(256).fill(0n);
  const buyOrders = new Array<number>(256).fill(0);
  const sellOrders = new Array<number>(256).fill(0);
  sell[4] = 10n;
  sellOrders[4] = 1;
  buy[6] = 4n;
  buyOrders[6] = 1;
  const book = getLevelsEncoder().encode({ cross: ZERO, buy, sell, buyOrders, sellOrders, index: 0, pad: new Uint8Array(7) });
  const bookAddress = await bookAddressOf(CROSS);
  return verifyCross(async (a) => (a === CROSS ? data : a === bookAddress ? new Uint8Array(book) : null), CROSS, draws);
}

const ENDING = { endingSecs: 300, buckets: 4, randomEnd: true };

describe('a cross without rules, and a cross with rules but no ending', () => {
  it('a cross the deployed program wrote is verified as before: schema v1, no rules block', async () => {
    const p = await proofFor();
    expect(p.schema).toBe(PROOF_SCHEMA);
    expect(p.verified).toBe(true);
    expect('rules' in p).toBe(false);
  });

  it('a cross with rules and no ending is schema v2 with no ending block and no failed check', async () => {
    const p = await proofFor({ ext: true });
    expect(p.schema).toBe(PROOF_SCHEMA_V2);
    expect(p.verified).toBe(true);
    expect(p.rules?.ending).toBeNull();
    expect(p.rules?.checks.map((c) => [c.name, c.ok])).toEqual([['main-shards-merged', true], ['aux-shards-merged', true]]);
    expect(p.rules?.limits.length).toBeGreaterThan(0);
  });

  it('a cross that has not cleared has no checks to run and is never verified', async () => {
    const p = await proofFor({ ext: true, ending: ENDING, state: CrossState.Live });
    expect(p.verified).toBe(false);
    expect(p.rules?.checks).toEqual([]);
  });
});

describe('a drawn ending', () => {
  const seed = seedOf('verifier/ruled/0');
  const end = drawEndBucket(seed, 4);

  it('is verified when the recorded bucket is the one the seed decides and exactly the buckets up to it were merged', async () => {
    const merged = BigInt((1 << (end + 1)) - 1);
    const p = await proofFor({ ext: true, ending: ENDING, seed, endBucket: end, auxMerged: merged });
    expect(p.verified).toBe(true);
    expect(p.rules?.ending).toMatchObject({ endingSecs: 300, buckets: 4, randomEnd: true, startsAt: '700', lastCountedBucket: end });
    expect(p.rules?.checks.map((c) => [c.name, c.ok])).toEqual([['main-shards-merged', true], ['aux-shards-merged', true], ['ending-drawn', true]]);
  });

  it('is not verified when a bucket after the drawn end was merged, or one before it was left out', async () => {
    const tooMany = await proofFor({ ext: true, ending: ENDING, seed, endBucket: end, auxMerged: 0b1111n });
    if (end < 3) {
      expect(tooMany.verified).toBe(false);
      expect(tooMany.notes.join(' ')).toMatch(/aux-shards-merged/);
    }
    const tooFew = await proofFor({ ext: true, ending: ENDING, seed, endBucket: end, auxMerged: BigInt((1 << end) - 1) });
    if (end > 0) expect(tooFew.verified).toBe(false);
    expect((await proofFor({ ext: true, ending: ENDING, seed, endBucket: end, auxMerged: 0n, mergedMask: 0b01 })).verified).toBe(false);
  });

  it('is not verified when the recorded bucket is not the one the seed decides', async () => {
    const wrong = (end + 1) % 4;
    const p = await proofFor({ ext: true, ending: ENDING, seed, endBucket: wrong, auxMerged: BigInt((1 << (wrong + 1)) - 1) });
    expect(p.verified).toBe(false);
    expect(p.rules?.checks.find((c) => c.name === 'ending-drawn')?.ok).toBe(false);
  });

  it('a drawn ending with no recorded bucket is not verified', async () => {
    const p = await proofFor({ ext: true, ending: ENDING, auxMerged: 0b1111n });
    expect(p.rules?.checks.find((c) => c.name === 'ending-drawn')?.ok).toBe(false);
    expect(p.verified).toBe(false);
  });

  it('after an extension the stored seed is the later one: the check says it cannot be made, until the event of the first draw is supplied', async () => {
    const first = seedOf('verifier/ruled/first');
    const later = seedOf('verifier/ruled/later');
    const bucket = drawEndBucket(first, 4);
    const merged = BigInt((1 << (bucket + 1)) - 1) | (0b11n << 8n);
    const without = await proofFor({ ext: true, ending: ENDING, seed: later, endBucket: bucket, epoch: 1, auxMerged: merged });
    expect(without.rules?.checks.find((c) => c.name === 'ending-drawn')).toMatchObject({ ok: null });
    expect(without.verified).toBe(true);
    const withEvent = await proofFor({ ext: true, ending: ENDING, seed: later, endBucket: bucket, epoch: 1, auxMerged: merged }, { draws: [{ purpose: 1, epoch: 0, seed: Buffer.from(first).toString('hex'), endBucket: bucket }] });
    expect(withEvent.rules?.checks.find((c) => c.name === 'ending-drawn')).toMatchObject({ ok: true });
    const lying = await proofFor({ ext: true, ending: ENDING, seed: later, endBucket: bucket, epoch: 1, auxMerged: merged }, { draws: [{ purpose: 1, epoch: 0, seed: Buffer.from(later).toString('hex'), endBucket: bucket }] });
    if (drawEndBucket(later, 4) !== bucket) expect(lying.verified).toBe(false);
    // the extension shards (bits 8..) are part of what must be merged once the epoch is above zero
    expect((await proofFor({ ext: true, ending: ENDING, seed: later, endBucket: bucket, epoch: 1, auxMerged: BigInt((1 << (bucket + 1)) - 1) })).verified).toBe(false);
  });
});

describe('the published schema of version 2', () => {
  it('names the proof of a cross with rules and refuses the one of a cross without', async () => {
    const { default: Ajv2020 } = await import('ajv/dist/2020.js');
    const { default: addFormats } = await import('ajv-formats');
    const { readFileSync } = await import('node:fs');
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    addFormats(ajv);
    const validate = ajv.compile(JSON.parse(readFileSync(new URL('../schema/fairness-proof.v2.schema.json', import.meta.url), 'utf8')));
    const seed = seedOf('verifier/ruled/0');
    const end = drawEndBucket(seed, 4);
    for (const proof of [await proofFor({ ext: true }), await proofFor({ ext: true, ending: ENDING, seed, endBucket: end, auxMerged: BigInt((1 << (end + 1)) - 1) }), await proofFor({ ext: true, ending: ENDING, state: CrossState.Live })]) {
      expect(validate(JSON.parse(JSON.stringify(proof))), JSON.stringify(validate.errors)).toBe(true);
    }
    expect(validate(JSON.parse(JSON.stringify(await proofFor())))).toBe(false);
  });
});
