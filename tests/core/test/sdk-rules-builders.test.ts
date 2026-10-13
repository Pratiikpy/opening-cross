// The builders of @opening-cross/sdk for crosses with rules, against the construction the LiteSVM suites run.
//
// `tests/core/src/rules-world.ts` builds every instruction a cross with rules needs (place, reveal, cancel, merge and clear, claim, finalize, release a lock,
// push refunds, set rules) by hand from the generated client and the extras helpers, and 112 tests run those instructions against the real program binary.
// That construction is transcribed below, unchanged in what it passes, as `reference`; the SDK builders must produce byte-for-byte the same instructions
// (program, accounts with roles, data) for every configuration. The program itself is NOT run here: LiteSVM needs Linux.
import { describe, expect, it } from 'vitest';
import { type Address, type Instruction, createNoopSigner, getAddressDecoder, none, some } from '@solana/kit';
import { TOKEN_2022_PROGRAM_ADDRESS, getCreateAssociatedTokenIdempotentInstruction } from '@solana-program/token-2022';
import { CROSS_GATE_PROGRAM_ADDRESS } from '@opening-cross/cross-gate-client';
import {
  AUX_END_BASE,
  AUX_EXT_BASE,
  CROSS_BODY_LEN,
  CROSS_CORE_PROGRAM_ADDRESS,
  CROSS_EXT_LEN,
  CrossKind,
  CrossState,
  Disclosure,
  FLAG_FEEDS_LENDERS,
  FLAG_GUARD_SCALED_UI,
  FLAG_RESUMES_HALT,
  type OrderExt,
  OrderSide,
  SLOT_HASHES,
  SupplyMode,
  type CrossView,
  type RulesConfig,
  applicantAddress,
  ata,
  auxBit,
  auxShardIndexes,
  auxShardIndexesFor,
  baseVaultAddress,
  bookAddress,
  buildCancel,
  buildChallengeInsider,
  buildClaim,
  buildCreateRuledCross,
  buildDrawBegin,
  buildDrawFinish,
  buildFinalize,
  buildMissingRuledAccounts,
  buildPlaceOrder,
  buildPushRefunds,
  buildReleaseLocked,
  buildReveal,
  buildSettleBook,
  buildSetRules,
  cancelExtras,
  claimExtras,
  classBookAddress,
  clearExtras,
  commitExtras,
  completeRules,
  costCeil,
  crossAddress,
  gatePassAddress,
  getCancelOrderInstruction,
  getClaimInstruction,
  getClearInstruction,
  getCommitOrderExtInstruction,
  getCommitOrderInstruction,
  getCrossEncoder,
  getCrossExtEncoder,
  getDrawBeginInstruction,
  getDrawFinishInstruction,
  getFinalizeInstruction,
  getInitClassBookInstruction,
  getInitLockVaultInstruction,
  getInitShardInstruction,
  getMergeShardInstruction,
  getPushRefundsInstruction,
  getReleaseLockedInstruction,
  getRevealOrderInstruction,
  getSetRulesInstruction,
  hasFlag,
  lastBucket,
  lockVaultAddress,
  lockupAddress,
  orderAddress,
  orderCommitment,
  orderPda,
  placementAt,
  printFeedAddress,
  protocolAddress,
  quoteVaultAddress,
  readCrossExt,
  readOrderExt,
  readRuledCross,
  readonly,
  revealExtras,
  shardAddress,
  shardIndexFor,
  withAccounts,
  writable,
} from '@opening-cross/sdk';

const addr = (n: number) => getAddressDecoder().decode(new Uint8Array(32).fill(n + 90)) as Address;
const [CREATOR, BASE, QUOTE, INTEGRATOR, FEES, OWNER, GATE, HALT, REFERRER, PRIORITY, PAYER, CAL] = Array.from({ length: 12 }, (_, i) => addr(i)) as [Address, Address, Address, Address, Address, Address, Address, Address, Address, Address, Address, Address];
const TP = TOKEN_2022_PROGRAM_ADDRESS;
const ZERO = '11111111111111111111111111111111' as Address;
const CLOSE = 1_000_000n;

/** Instructions as plain data: signers collapse to their address, so a noop signer and a keypair signer compare equal. */
const plain = (ix: Instruction) => ({
  program: ix.programAddress,
  accounts: (ix.accounts ?? []).map((a) => `${a.address}:${a.role}`),
  data: Buffer.from(ix.data ?? new Uint8Array()).toString('hex'),
});
const same = (a: Instruction | Instruction[], b: Instruction | Instruction[]) => expect([a].flat().map(plain)).toEqual([b].flat().map(plain));

type Fixture = { view: CrossView; ext: ReturnType<typeof readCrossExt>; bytes: Uint8Array };

/** A cross account as the program writes it (the body padded to its allocation, then the rules tail), decoded the way the API decodes it. */
function crossWith(rules: RulesConfig | null, o: { disclosure?: Disclosure; supply?: SupplyMode; gate?: boolean; state?: CrossState; shards?: number; calendar?: Address; epoch?: number; endBucket?: number; auxMerged?: bigint } = {}): Fixture & { address: Address } {
  const address = addr(50);
  const body = getCrossEncoder().encode({
    creator: CREATOR, crossId: 1n, kind: CrossKind.Launch, supplyMode: o.supply ?? SupplyMode.Mint, disclosure: o.disclosure ?? Disclosure.Open, state: o.state ?? CrossState.Live,
    baseMint: BASE, quoteMint: QUOTE, baseTokenProgram: TP, quoteTokenProgram: TP, baseDecimals: 6, quoteDecimals: 6, proceedsTo: CREATOR,
    minPrice: 1_000_000n, tick: 100_000n, ticks: 20, priceScale: 1_000_000n, openTs: CLOSE - 1_000n, closeTs: CLOSE, revealEndTs: CLOSE + 100n, referencePrice: none(), minMatched: 0n, maxImbalanceBps: none(),
    protocolFeeBps: 30, integratorFeeBps: 20, integrator: INTEGRATOR, feeRecipient: FEES, gateMint: o.gate ? some(GATE) : none(), shards: o.shards ?? 3, maxOrders: 64, dustBond: 0n,
    ordersTotal: 0, ordersOpen: 0, mergedMask: 0, clearing: none(), noPrintReason: none(), buyerPaid: 0n, baseBought: 0n, baseSold: 0n, sellerPaid: 0n, feesAccrued: 0n, oracle: none(),
    calendar: o.calendar ? some(o.calendar) : none(), settler: none(), settleDeadlineTs: 0n, baseBound: true, bump: 255, quoteVaultBump: 255, baseVaultBump: 255, bookBump: 255,
  } as never);
  const data = new Uint8Array(CROSS_BODY_LEN + CROSS_EXT_LEN);
  data.set(body);
  if (rules) {
    const r = completeRules(rules);
    const insiders = [...r.neutrality.insiders, ...Array.from({ length: 8 - r.neutrality.insiders.length }, () => ZERO)];
    const feeds = [...r.oracleSet.extraFeeds, ...Array.from({ length: 2 - r.oracleSet.extraFeeds.length }, () => new Uint8Array(32))];
    data.set(
      getCrossExtEncoder().encode({
        version: 1, rulesSet: true, createdSlot: 9n, flags: r.flags, guards: { ...r.guards, haltSource: r.guards.haltSource ?? null }, ending: r.ending,
        draw: { epoch: o.epoch ?? 0, pendingSlot: 0n, pendingPurpose: 0, seed: new Uint8Array(32), seedEpoch: 0, seedReady: true, endBucket: o.endBucket ?? 255, extPending: false, extensionUsed: false, auxMerged: o.auxMerged ?? 0n },
        identity: r.identity, alloc: { ...r.alloc, priorityGate: r.alloc.priorityGate ?? null },
        neutrality: { insiders, insiderCount: r.neutrality.insiders.length, insiderCliffSecs: r.neutrality.insiderCliffSecs, insiderVestSecs: r.neutrality.insiderVestSecs, bondQuote: r.neutrality.bondQuote, challengeSecs: r.neutrality.challengeSecs },
        neutralState: { bondHeld: r.neutrality.bondQuote, slashed: 0n, openChallenges: 0, challenges: 3 }, clearing: { classQty: [0n, 0n, 0n], tickets: 0, rho: 0, clearedTs: 0n, insiderUb: 0n }, referral: r.referral,
        oracleSet: { extraFeeds: feeds as never, extraCount: r.oracleSet.extraFeeds.length, quorum: r.oracleSet.quorum, maxSpreadBps: r.oracleSet.maxSpreadBps, offHoursWidenBps: r.oracleSet.offHoursWidenBps },
      } as never),
      CROSS_BODY_LEN,
    );
  }
  const view = readRuledCross(address, data);
  return { view, ext: view.ext, bytes: data, address };
}

// ---------------------------------------------------------------- the reference: rules-world.ts, as the LiteSVM suites run it

const reference = {
  async commit(view: CrossView, ext: ReturnType<typeof readCrossExt>, owner: Address, nonce: bigint, side: OrderSide, price: bigint, quantity: bigint, salt: Uint8Array, now: bigint, opts: { escrow?: bigint; class?: number; lockSecs?: number } = {}) {
    const c = view.data;
    const sealed = c.disclosure === Disclosure.Sealed;
    const escrow = opts.escrow ?? (side === OrderSide.Buy ? costCeil(quantity, price, c.priceScale) : quantity);
    const [order, orderBump] = await orderPda(view.address, owner, nonce);
    const commitment = sealed ? orderCommitment(view.address, owner, nonce, side, price, quantity, salt) : new Uint8Array(32);
    const gateMint = c.gateMint.__option === 'Some' ? c.gateMint.value : null;
    const placement = placementAt(ext, c.closeTs, now);
    const cls = opts.class ?? 0;
    const lockSecs = opts.lockSecs ?? 0;
    const shardIndex = placement.epoch > 0 ? AUX_EXT_BASE + shardIndexFor(owner, nonce, Math.min(Math.max(c.shards, 1), 8)) : placement.bucket !== 255 ? AUX_END_BASE + placement.bucket : shardIndexFor(owner, nonce, c.shards);
    const accounts = {
      owner: createNoopSigner(owner),
      protocol: await protocolAddress(),
      cross: view.address,
      order,
      ...(sealed ? {} : { shard: await shardAddress(view.address, shardIndex) }),
      ...(gateMint ? { pass: await gatePassAddress(gateMint, owner) } : {}),
      ...(side === OrderSide.Buy
        ? { escrowMint: c.quoteMint, escrowVault: await quoteVaultAddress(view.address), ownerEscrow: await ata(owner, c.quoteMint, c.quoteTokenProgram), escrowTokenProgram: c.quoteTokenProgram }
        : { escrowMint: c.baseMint, escrowVault: await baseVaultAddress(view.address), ownerEscrow: await ata(owner, c.baseMint, c.baseTokenProgram), escrowTokenProgram: c.baseTokenProgram }),
    };
    const args = { nonce, side, escrow, commitment, price: sealed ? 0n : price, quantity: sealed ? 0n : quantity, orderBump };
    const ix = cls === 0 && lockSecs === 0 ? getCommitOrderInstruction({ ...accounts, ...args }) : getCommitOrderExtInstruction({ ...accounts, ...args, class: cls, lockSecs });
    return withAccounts(ix, await commitExtras(ext, view.address, owner, { class: cls, now, gateProgram: CROSS_GATE_PROGRAM_ADDRESS }));
  },
  async reveal(view: CrossView, ext: ReturnType<typeof readCrossExt>, owner: Address, nonce: bigint, price: bigint, quantity: bigint, salt: Uint8Array, orderExt: OrderExt, isBuy: boolean) {
    const idx = orderExt.epoch > 0 ? AUX_EXT_BASE + shardIndexFor(owner, nonce, Math.min(Math.max(view.data.shards, 1), 8)) : orderExt.bucket !== 255 ? AUX_END_BASE + orderExt.bucket : shardIndexFor(owner, nonce, view.data.shards);
    const ix = getRevealOrderInstruction({ owner: createNoopSigner(owner), cross: view.address, order: await orderAddress(view.address, owner, nonce), shard: await shardAddress(view.address, idx), price, quantity, salt });
    return withAccounts(ix, await revealExtras(ext, view.address, isBuy));
  },
  async cancel(view: CrossView, ext: ReturnType<typeof readCrossExt>, owner: Address, nonce: bigint, side: OrderSide, orderExt: OrderExt) {
    const c = view.data;
    const revealed = c.disclosure === Disclosure.Open;
    const idx = orderExt.epoch > 0 ? AUX_EXT_BASE + shardIndexFor(owner, nonce, Math.min(Math.max(c.shards, 1), 8)) : orderExt.bucket !== 255 ? AUX_END_BASE + orderExt.bucket : shardIndexFor(owner, nonce, c.shards);
    const ix = getCancelOrderInstruction({
      owner: createNoopSigner(owner), cross: view.address, order: await orderAddress(view.address, owner, nonce), ...(revealed ? { shard: await shardAddress(view.address, idx) } : {}),
      baseMint: c.baseMint, quoteMint: c.quoteMint, quoteVault: await quoteVaultAddress(view.address), baseVault: await baseVaultAddress(view.address),
      ...(side === OrderSide.Buy ? { ownerQuote: await ata(owner, c.quoteMint, c.quoteTokenProgram) } : { ownerBase: await ata(owner, c.baseMint, c.baseTokenProgram) }),
      baseTokenProgram: c.baseTokenProgram, quoteTokenProgram: c.quoteTokenProgram,
    });
    return withAccounts(ix, await cancelExtras(ext, view.address, owner, { revealed, isBuy: side === OrderSide.Buy }));
  },
  async settle(view: CrossView, ext: ReturnType<typeof readCrossExt>, opts: { oracleAccounts?: readonly Address[] } = {}) {
    const book = await bookAddress(view.address);
    const x = ext;
    const ixs: Instruction[] = [];
    for (let i = 0; i < view.data.shards; i++) {
      if ((view.data.mergedMask >>> i) & 1) continue;
      ixs.push(getMergeShardInstruction({ cross: view.address, book, shard: await shardAddress(view.address, i) }));
    }
    if (x) {
      const merged = x.draw.auxMerged;
      if (x.ending.endingSecs > 0) {
        for (let b = 0; b <= lastBucket(x); b++) {
          const index = AUX_END_BASE + b;
          if ((merged & auxBit(index)) === 0n) ixs.push(getMergeShardInstruction({ cross: view.address, book, shard: await shardAddress(view.address, index) }));
        }
      }
      if (x.draw.epoch > 0) {
        for (const index of auxShardIndexes(x, Number(view.data.shards)).filter((i) => i >= AUX_EXT_BASE)) {
          if ((merged & auxBit(index)) === 0n) ixs.push(getMergeShardInstruction({ cross: view.address, book, shard: await shardAddress(view.address, index) }));
        }
      }
    }
    const clear = getClearInstruction({ cross: view.address, book });
    const calendar = view.data.calendar.__option === 'Some' ? view.data.calendar.value : null;
    ixs.push(withAccounts(clear, await clearExtras(x, view.address, view.data.baseMint, { ...(opts.oracleAccounts ? { oracleAccounts: opts.oracleAccounts } : {}), calendar })));
    return ixs;
  },
  async claim(view: CrossView, owner: Address, nonce: bigint, isBuy: boolean, orderExt: OrderExt) {
    const c = view.data;
    const ixs: Instruction[] = [];
    const base = c.baseBound ? { baseMint: c.baseMint, ownerBase: await ata(owner, c.baseMint, c.baseTokenProgram) } : {};
    if (c.baseBound) ixs.push(getCreateAssociatedTokenIdempotentInstruction({ payer: createNoopSigner(PAYER), ata: base.ownerBase!, owner, mint: c.baseMint, tokenProgram: c.baseTokenProgram }));
    const claim = getClaimInstruction({
      payer: createNoopSigner(PAYER), cross: view.address, owner, order: await orderAddress(view.address, owner, nonce), quoteVault: await quoteVaultAddress(view.address), ownerQuote: await ata(owner, c.quoteMint, c.quoteTokenProgram), ...base,
      ...(c.supplyMode === SupplyMode.Escrow ? { baseVault: await baseVaultAddress(view.address) } : {}), quoteMint: c.quoteMint, baseTokenProgram: c.baseTokenProgram, quoteTokenProgram: c.quoteTokenProgram,
    });
    ixs.push(withAccounts(claim, await claimExtras(view.address, owner, nonce, { isBuy, ext: orderExt })));
    return ixs;
  },
  async finalize(view: CrossView, ext: ReturnType<typeof readCrossExt>) {
    const c = view.data;
    const ix = getFinalizeInstruction({
      payer: createNoopSigner(PAYER), cross: view.address, ...(c.baseBound ? { baseMint: c.baseMint } : {}),
      ...(c.supplyMode === SupplyMode.Escrow ? { baseVault: await baseVaultAddress(view.address), proceedsBase: await ata(c.proceedsTo, c.baseMint, c.baseTokenProgram) } : {}),
      quoteMint: c.quoteMint, quoteVault: await quoteVaultAddress(view.address), feeRecipientQuote: await ata(c.feeRecipient, c.quoteMint, c.quoteTokenProgram), integratorQuote: await ata(c.integrator, c.quoteMint, c.quoteTokenProgram),
      proceedsQuote: await ata(c.proceedsTo, c.quoteMint, c.quoteTokenProgram), baseTokenProgram: c.baseTokenProgram, quoteTokenProgram: c.quoteTokenProgram,
    });
    return ext && ext.referral.shareBps > 0 ? withAccounts(ix, [writable(await ata(ext.referral.referrer, c.quoteMint, c.quoteTokenProgram))]) : ix;
  },
  async release(view: CrossView, owner: Address, nonce: bigint) {
    const c = view.data;
    const ownerBase = await ata(owner, c.baseMint, c.baseTokenProgram);
    return [
      getCreateAssociatedTokenIdempotentInstruction({ payer: createNoopSigner(PAYER), ata: ownerBase, owner, mint: c.baseMint, tokenProgram: c.baseTokenProgram }),
      getReleaseLockedInstruction({ cross: view.address, owner, lockup: await lockupAddress(view.address, owner, nonce), lockVault: await lockVaultAddress(view.address), baseMint: c.baseMint, ownerBase, baseTokenProgram: c.baseTokenProgram }),
    ];
  },
  async pushRefunds(view: CrossView, orders: { owner: Address; nonce: bigint; side: OrderSide }[]) {
    const c = view.data;
    const ix = getPushRefundsInstruction({ cross: view.address, quoteMint: c.quoteMint, quoteVault: await quoteVaultAddress(view.address), ...(c.baseBound ? { baseMint: c.baseMint, baseVault: await baseVaultAddress(view.address) } : {}), quoteTokenProgram: c.quoteTokenProgram, baseTokenProgram: c.baseTokenProgram });
    const extra = [];
    for (const o of orders) {
      const dest = await ata(o.owner, o.side === OrderSide.Buy ? c.quoteMint : c.baseMint, o.side === OrderSide.Buy ? c.quoteTokenProgram : c.baseTokenProgram);
      extra.push(writable(await orderAddress(view.address, o.owner, o.nonce)), writable(o.owner), writable(dest));
    }
    return withAccounts(ix, extra);
  },
  async setRules(cross: Address, rules: RulesConfig, o: { baseMint?: Address; calendar?: Address | null; feed?: Address } = {}) {
    const full = completeRules(rules);
    let ix = getSetRulesInstruction({ creator: createNoopSigner(CREATOR), cross, ...full });
    const extra = [];
    const haltSource = full.guards.haltSource;
    if ((full.flags & FLAG_RESUMES_HALT) !== 0 && haltSource) extra.push(readonly(typeof haltSource === 'string' ? haltSource : haltSource.__option === 'Some' ? haltSource.value : (() => { throw new Error('no halt source'); })()));
    if ((full.flags & FLAG_FEEDS_LENDERS) !== 0) extra.push(readonly(o.feed ?? (await printFeedAddress(o.baseMint!))));
    if (full.neutrality.bondQuote > 0n) extra.push(writable(await ata(CREATOR, QUOTE, TP)), writable(await quoteVaultAddress(cross)), readonly(QUOTE), readonly(TP));
    if ((full.flags & FLAG_GUARD_SCALED_UI) !== 0) extra.push(readonly(o.baseMint!));
    if (full.oracleSet.extraFeeds.length > 0 && o.calendar) extra.push(readonly(o.calendar));
    ix = withAccounts(ix, extra);
    return ix;
  },
};

// ---------------------------------------------------------------- configurations

const EVERYTHING: RulesConfig = {
  flags: FLAG_FEEDS_LENDERS | FLAG_GUARD_SCALED_UI,
  guards: { minRaiseQuote: 5_000_000n, maxMatched: 100_000_000n, totalSupply: 1_000_000_000n, minFloatBps: 500, maxFdvX100: 5_000, moveBps: 2_000, anchorPrice: 1_200_000n },
  ending: { endingSecs: 400, buckets: 4, cancelCutoffSecs: 60, randomEnd: true, extensionMinSecs: 60, extensionMaxSecs: 600 },
  identity: { capQuote: 50_000_000n, maxOrders: 1 },
  alloc: { reserveBps: [3_000, 2_000, 1_000], smallCapQuote: 5_000_000n, lotteryUnit: 5_000_000n, minLockSecs: 3_600, lockVestSecs: 7_200, earlyUntilTs: CLOSE - 500n, priorityGate: PRIORITY, class1CliffSecs: 10, class1VestSecs: 20 },
  neutrality: { insiders: [addr(30), addr(31)], insiderCliffSecs: 100, insiderVestSecs: 200, bondQuote: 1_000_000n, challengeSecs: 7_200 },
  referral: { referrer: REFERRER, shareBps: 2_500 },
  oracleSet: { extraFeeds: [new Uint8Array(32).fill(1), new Uint8Array(32).fill(2)], quorum: 2, maxSpreadBps: 300, offHoursWidenBps: 500 },
};
const CONFIGS: [string, RulesConfig | null, Parameters<typeof crossWith>[1]][] = [
  ['no rules (a cross the deployed program wrote, or one whose creator set none)', null, {}],
  ['a drawn ending of four buckets', { ending: { endingSecs: 400, buckets: 4, randomEnd: true, cancelCutoffSecs: 60 } }, { endBucket: 2, auxMerged: 0b0001n }],
  ['an ending that is not drawn', { ending: { endingSecs: 400, buckets: 3, randomEnd: false } }, {}],
  ['an ending, a drawn extension in epoch 1', { ending: { endingSecs: 400, buckets: 4, randomEnd: true, extensionMinSecs: 60, extensionMaxSecs: 600 } }, { epoch: 1, endBucket: 1, auxMerged: 0b11n }],
  ['identity limits on a gated cross', { identity: { capQuote: 50_000_000n, maxOrders: 1 } }, { gate: true }],
  ['classes and a lottery', { alloc: { reserveBps: [3_000, 0, 0], smallCapQuote: 5_000_000n, lotteryUnit: 5_000_000n } }, { gate: true }],
  ['a priority class with a pass', { alloc: { reserveBps: [0, 0, 2_000], earlyUntilTs: CLOSE - 500n, priorityGate: PRIORITY } }, {}],
  ['lockups', { alloc: { reserveBps: [0, 2_000, 0], minLockSecs: 3_600, lockVestSecs: 7_200 } }, {}],
  ['declared insiders with a bond', { neutrality: { insiders: [addr(30)], insiderCliffSecs: 10, bondQuote: 1_000_000n, challengeSecs: 7_200 } }, {}],
  ['a referral share', { referral: { referrer: REFERRER, shareBps: 2_500 } }, {}],
  ['a sealed cross with an ending and classes', { ending: { endingSecs: 400, buckets: 4, randomEnd: true }, alloc: { reserveBps: [0, 2_000, 0], minLockSecs: 60 } }, { disclosure: Disclosure.Sealed, endBucket: 3 }],
  ['every rule at once', EVERYTHING, { gate: true, endBucket: 2, auxMerged: 0b101n }],
];
const salt = new Uint8Array(32).fill(7);

describe('the SDK builders produce the instructions the LiteSVM suites run', () => {
  describe.each(CONFIGS)('%s', (_name, rules, o) => {
    const f = crossWith(rules, o);
    const open = f.view.data.disclosure === Disclosure.Open;
    // an order on a cross without rules has no tail of its own: only the default placement exists there
    const orderExts: OrderExt[] = [
      { version: 1, epoch: 0, bucket: 255, class: 0, flags: 0, lockCliff: 0, lockVest: 0, placedTs: 0n, ticket: 0 },
      ...(f.ext ? [
        { version: 1, epoch: 0, bucket: 2, class: 2, flags: 0, lockCliff: 3_600, lockVest: 7_200, placedTs: 5n, ticket: 0 },
        { version: 1, epoch: 1, bucket: 255, class: 0, flags: 0, lockCliff: 0, lockVest: 0, placedTs: 5n, ticket: 0 },
      ] : []),
    ];

    it('place: at every moment of the call, for a buy and a sell, with and without a class', async () => {
      for (const now of [CLOSE - 900n, CLOSE - 401n, CLOSE - 400n, CLOSE - 301n, CLOSE - 200n, CLOSE - 1n]) {
        for (const side of [OrderSide.Buy, OrderSide.Sell]) {
          for (const opts of f.ext && side === OrderSide.Buy ? [{}, { class: 1 }, { class: 2, lockSecs: 3_600 }, { class: 3 }, { escrow: 12_345n }] : [{}]) {
            const built = await buildPlaceOrder({ cross: f.view, owner: createNoopSigner(OWNER), nonce: 11n, side, price: 1_300_000n, quantity: 5_000_000n, salt, now, ...opts });
            same(built, await reference.commit(f.view, f.ext, OWNER, 11n, side, 1_300_000n, 5_000_000n, salt, now, opts));
          }
        }
      }
    });

    it('reveal and cancel: for orders in every placement', async () => {
      for (const oe of orderExts) {
        for (const isBuy of [true, false]) {
          same(await buildReveal(f.view, createNoopSigner(OWNER), 4n, 1_300_000n, 5_000_000n, salt, { ext: oe, isBuy }), await reference.reveal(f.view, f.ext, OWNER, 4n, 1_300_000n, 5_000_000n, salt, oe, isBuy));
          same(await buildCancel(f.view, createNoopSigner(OWNER), 4n, isBuy ? OrderSide.Buy : OrderSide.Sell, open, { ext: oe, isBuy }), await reference.cancel(f.view, f.ext, OWNER, 4n, isBuy ? OrderSide.Buy : OrderSide.Sell, oe));
        }
      }
    });

    it('settle: the merges (main, buckets to the drawn one, extension shards), then the clear with the accounts the rules name', async () => {
      const feeds = [addr(70), addr(71)];
      const built = await buildSettleBook(f.view, { oracleAccounts: feeds, allowUndrawn: true, now: CLOSE + 1_000n });
      same(built, await reference.settle(f.view, f.ext, { oracleAccounts: feeds }));
    });

    it('claim, finalize, release and push refunds', async () => {
      for (const oe of orderExts) {
        for (const isBuy of [true, false]) {
          const facts = { ext: oe, isBuy };
          same(await buildClaim(f.view, createNoopSigner(PAYER), OWNER, 4n, facts), await reference.claim(f.view, OWNER, 4n, isBuy, oe));
        }
      }
      same(await buildFinalize(f.view, createNoopSigner(PAYER)), await reference.finalize(f.view, f.ext));
      same(await buildReleaseLocked(f.view, createNoopSigner(PAYER), OWNER, 4n), await reference.release(f.view, OWNER, 4n));
      const orders = [{ owner: OWNER, nonce: 1n, side: OrderSide.Buy }, { owner: addr(80), nonce: 2n, side: OrderSide.Sell }];
      same(await buildPushRefunds(f.view, orders), await reference.pushRefunds(f.view, orders));
    });
  });

  it('create_cross and set_rules: the pair, the shards, the buckets, the class book and the lock vault', async () => {
    for (const [name, rules] of CONFIGS.filter((c) => c[1])) {
      const feed = FLAG_FEEDS_LENDERS & (completeRules(rules!).flags) ? addr(40) : undefined;
      const built = await buildCreateRuledCross({
        creator: createNoopSigner(CREATOR), baseMint: BASE, quoteMint: QUOTE, baseTokenProgram: TP, quoteTokenProgram: TP, crossId: 1n, kind: CrossKind.Launch, supplyMode: SupplyMode.Mint, disclosure: Disclosure.Open,
        minPrice: 1_000_000n, tick: 100_000n, ticks: 20, priceScale: 1_000_000n, openTs: CLOSE - 1_000n, closeTs: CLOSE, revealEndTs: CLOSE + 100n, referencePrice: null, minMatched: 0n, maxImbalanceBps: null, integratorFeeBps: 20,
        integrator: INTEGRATOR, gateMint: GATE, shards: 3, maxOrders: 64, proceedsTo: CREATOR, schedule: [{ price: 1n, quantity: 1n }], oracle: null, calendar: rules!.oracleSet?.offHoursWidenBps ? CAL : null, settler: null, settleDeadlineTs: 0n, rules: rules!, ...(feed ? { feed } : {}),
      });
      const cross = await crossAddress(CREATOR, 1n);
      same(built.setRules!, await reference.setRules(cross, rules!, { baseMint: BASE, calendar: rules!.oracleSet?.offHoursWidenBps ? CAL : null, ...(feed ? { feed } : {}) }));
      expect(built.atomic.length, name).toBe(2);
      const full = completeRules(rules!);
      same(built.auxShards, await Promise.all(auxShardIndexesFor(full.ending, 3).map(async (index) => getInitShardInstruction({ payer: createNoopSigner(CREATOR), cross, shard: await shardAddress(cross, index), index }))));
      const classes = full.alloc.reserveBps.some((b) => b > 0) || full.alloc.lotteryUnit > 0n || full.neutrality.insiders.length > 0;
      expect(built.classBook !== null, name).toBe(classes);
      if (classes) same(built.classBook!, getInitClassBookInstruction({ payer: createNoopSigner(CREATOR), cross, classBook: await classBookAddress(cross) }));
      const locks = full.alloc.minLockSecs > 0 || full.alloc.class1CliffSecs > 0 || full.alloc.class1VestSecs > 0 || full.neutrality.insiderCliffSecs > 0 || full.neutrality.insiderVestSecs > 0;
      expect(built.lockVault !== null, name).toBe(locks);
      if (locks) same(built.lockVault!, getInitLockVaultInstruction({ payer: createNoopSigner(CREATOR), cross, baseMint: BASE, lockVault: await lockVaultAddress(cross), baseTokenProgram: TP }));
    }
  });

  it('a lockup on a deferred-mint cross is refused when the cross is built, not by the cluster', async () => {
    await expect(
      buildCreateRuledCross({
        creator: createNoopSigner(CREATOR), quoteMint: QUOTE, baseTokenProgram: TP, quoteTokenProgram: TP, crossId: 1n, kind: CrossKind.Launch, supplyMode: SupplyMode.DeferredMint, disclosure: Disclosure.Open, minPrice: 1n, tick: 1n, ticks: 2, priceScale: 1n,
        openTs: 1n, closeTs: 2n, revealEndTs: 3n, referencePrice: null, minMatched: 0n, maxImbalanceBps: null, integratorFeeBps: 0, integrator: INTEGRATOR, gateMint: null, shards: 1, maxOrders: 8, proceedsTo: CREATOR, schedule: [], oracle: null, calendar: null, settler: null, settleDeadlineTs: 0n,
        rules: { alloc: { reserveBps: [0, 1_000, 0], minLockSecs: 60 } },
      }),
    ).rejects.toThrow(/deferred-mint/);
  });
});

describe('what the builders refuse before the cluster does', () => {
  it('a class on a cross without rules, and a class on a sell', async () => {
    const plain = crossWith(null);
    await expect(buildPlaceOrder({ cross: plain.view, owner: createNoopSigner(OWNER), nonce: 1n, side: OrderSide.Buy, price: 1_300_000n, quantity: 1n, now: CLOSE - 5n, class: 1 })).rejects.toThrow(/no rules/);
    const ruled = crossWith({ alloc: { reserveBps: [0, 2_000, 0], minLockSecs: 60 } });
    await expect(buildPlaceOrder({ cross: ruled.view, owner: createNoopSigner(OWNER), nonce: 1n, side: OrderSide.Sell, price: 1_300_000n, quantity: 1n, now: CLOSE - 5n, class: 2, lockSecs: 60 })).rejects.toThrow(/buy orders only/);
  });

  it('settle names the draw it is waiting for, and builds once the draw is done', async () => {
    const owed = crossWith({ ending: { endingSecs: 400, buckets: 4, randomEnd: true } }, { state: CrossState.Live });
    // the seed is not ready: patch the tail the way the program leaves it before the draw
    const bytes = owed.bytes.slice();
    const x = readCrossExt(bytes)!;
    expect(x.draw.seedReady).toBe(true);
    const notReady = crossWith({ ending: { endingSecs: 400, buckets: 4, randomEnd: true } });
    const view = { ...notReady.view, ext: { ...notReady.view.ext!, draw: { ...notReady.view.ext!.draw, seedReady: false, endBucket: 255 } } };
    await expect(buildSettleBook(view, { now: CLOSE + 1_000n })).rejects.toThrow(/DrawRequired/);
    await expect(buildSettleBook(view, { now: CLOSE })).rejects.toThrow(/DrawRequired/).catch(() => undefined);
    expect((await buildSettleBook(owed.view, { now: CLOSE + 1_000n })).length).toBeGreaterThan(0);
  });

  it('claim on a cross with lockups and cancel on a cross with rules need the order', async () => {
    const f = crossWith({ alloc: { reserveBps: [0, 2_000, 0], minLockSecs: 60 } });
    await expect(buildClaim(f.view, createNoopSigner(PAYER), OWNER, 1n)).rejects.toThrow(/needs the order/);
    await expect(buildCancel(f.view, createNoopSigner(OWNER), 1n, OrderSide.Buy, true)).rejects.toThrow(/needs the order/);
    await expect(buildReveal(f.view, createNoopSigner(OWNER), 1n, 1n, 1n, salt)).rejects.toThrow(/needs the order/);
  });

  it('a cross without rules is built exactly as it was before the rules existed', async () => {
    const plain = crossWith(null);
    const legacyView = { address: plain.view.address, data: plain.view.data };
    same(await buildPlaceOrder({ cross: legacyView, owner: createNoopSigner(OWNER), nonce: 1n, side: OrderSide.Buy, price: 1_300_000n, quantity: 5_000_000n, now: CLOSE - 5n }), await buildPlaceOrder({ cross: plain.view, owner: createNoopSigner(OWNER), nonce: 1n, side: OrderSide.Buy, price: 1_300_000n, quantity: 5_000_000n, now: CLOSE - 5n }));
    const [only] = await Promise.all([buildSettleBook(legacyView)]);
    // three shards then the clear, each with the accounts it always had and nothing after them
    expect(only.map((i) => i.accounts?.length)).toEqual([3, 3, 3, 3]);
  });

  it('draw instructions, challenges and the missing accounts of an interrupted create', async () => {
    const f = crossWith({ ending: { endingSecs: 400, buckets: 2, randomEnd: true }, neutrality: { insiders: [addr(30)], bondQuote: 1n, challengeSecs: 3_600 }, alloc: { reserveBps: [0, 1_000, 0], minLockSecs: 60 } });
    same(buildDrawBegin(f.address), getDrawBeginInstruction({ cross: f.address }));
    same(buildDrawFinish(f.address), getDrawFinishInstruction({ cross: f.address, slotHashes: SLOT_HASHES }));
    const challenge = await buildChallengeInsider({ cross: f.address, challenger: createNoopSigner(OWNER), id: 3, subject: addr(30), evidence: new Uint8Array(32).fill(1) });
    expect(challenge.accounts?.map((a) => a.address)).toContain((await import('@opening-cross/sdk')).challengeAddress && (await (await import('@opening-cross/sdk')).challengeAddress(f.address, 3)));
    const missing = await buildMissingRuledAccounts(f.view as never, createNoopSigner(PAYER), async () => false);
    // two ending buckets, the class book (insiders) and the lock vault (a minimum lock): four accounts
    expect(missing).toHaveLength(2 + 1 + 1);
    expect(await buildMissingRuledAccounts(f.view as never, createNoopSigner(PAYER), async () => true)).toEqual([]);
  });
});
void applicantAddress;
void hasFlag;
