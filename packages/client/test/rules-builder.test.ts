// The local transaction builder and the chain read on a cross with rules: the tail is read from the cross account, the accounts the rules call for are added,
// the orders of an ending period are part of the book, and a cross without rules is built as before. The chain is a map of accounts; the program is not run.
import { describe, expect, it } from 'vitest';
import { type Address, decompileTransactionMessage, getCompiledTransactionMessageDecoder, getTransactionDecoder, getAddressDecoder, none } from '@solana/kit';
import {
  AUX_END_BASE,
  CROSS_BODY_LEN,
  CROSS_CORE_PROGRAM_ADDRESS,
  CROSS_EXT_LEN,
  CrossKind,
  CrossState,
  Disclosure,
  COMMIT_ORDER_EXT_DISCRIMINATOR,
  SupplyMode,
  classBookAddress,
  completeRules,
  crossAddress,
  getCrossEncoder,
  getCrossExtEncoder,
  getLevelsEncoder,
  getOrderEncoder,
  orderAddress,
  shardAddress,
} from '@opening-cross/sdk';
import { localTxBuilder, readBookFromChain, readCrossFromChain, type RpcClient } from '../src/index.js';

const addr = (n: number) => getAddressDecoder().decode(new Uint8Array(32).fill(n + 150)) as Address;
const [CREATOR, BASE, QUOTE, GATE, ALICE] = [0, 1, 2, 3, 4].map(addr) as [Address, Address, Address, Address, Address];
const ZERO = '11111111111111111111111111111111' as Address;
const NOW = 1_800_000_000n;

type Acct = { data: Uint8Array; owner: string };
const chain = new Map<string, Acct>();
const rpc = {
  getAccount: async (a: string) => chain.get(a) ?? null,
  getAccounts: async (as: readonly string[]) => as.map((a) => chain.get(a) ?? null),
  latestBlockhash: async () => ({ blockhash: '4NCYB3kRT8sCNodPNuCZo8VkwveZSHhg7R7mrRBFM1Uy', lastValidBlockHeight: 100n }),
} as unknown as RpcClient;

async function putCross(id: bigint, rules: Parameters<typeof completeRules>[0] | null, o: { state?: CrossState; gate?: boolean } = {}) {
  const address = await crossAddress(CREATOR, id);
  const body = getCrossEncoder().encode({
    creator: CREATOR, crossId: id, kind: CrossKind.Launch, supplyMode: SupplyMode.Mint, disclosure: Disclosure.Open, state: o.state ?? CrossState.Live, baseMint: BASE, quoteMint: QUOTE, baseTokenProgram: ZERO, quoteTokenProgram: ZERO,
    baseDecimals: 6, quoteDecimals: 6, proceedsTo: CREATOR, minPrice: 1_000_000n, tick: 100_000n, ticks: 20, priceScale: 1_000_000n, openTs: NOW - 1_000n, closeTs: NOW + 1_000n, revealEndTs: NOW + 1_100n, referencePrice: none(), minMatched: 0n, maxImbalanceBps: none(),
    protocolFeeBps: 30, integratorFeeBps: 20, integrator: CREATOR, feeRecipient: CREATOR, gateMint: o.gate ? { __option: 'Some', value: GATE } : none(), shards: 2, maxOrders: 64, dustBond: 0n, ordersTotal: 0, ordersOpen: 0, mergedMask: 0, clearing: none(), noPrintReason: none(),
    buyerPaid: 0n, baseBought: 0n, baseSold: 0n, sellerPaid: 0n, feesAccrued: 0n, oracle: none(), calendar: none(), settler: none(), settleDeadlineTs: 0n, baseBound: true, bump: 1, quoteVaultBump: 1, baseVaultBump: 1, bookBump: 1,
  } as never);
  const data = new Uint8Array(CROSS_BODY_LEN + (rules ? CROSS_EXT_LEN : 0));
  data.set(body);
  if (rules) {
    const r = completeRules(rules);
    data.set(
      getCrossExtEncoder().encode({
        version: 1, rulesSet: true, createdSlot: 1n, flags: r.flags, guards: { ...r.guards, haltSource: null }, ending: r.ending,
        draw: { epoch: 0, pendingSlot: 0n, pendingPurpose: 0, seed: new Uint8Array(32), seedEpoch: 0, seedReady: false, endBucket: 255, extPending: false, extensionUsed: false, auxMerged: 0n },
        identity: r.identity, alloc: { ...r.alloc, priorityGate: null }, neutrality: { insiders: Array.from({ length: 8 }, () => ZERO), insiderCount: 0, insiderCliffSecs: 0, insiderVestSecs: 0, bondQuote: 0n, challengeSecs: 0 },
        neutralState: { bondHeld: 0n, slashed: 0n, openChallenges: 0, challenges: 0 }, clearing: { classQty: [0n, 0n, 0n], tickets: 0, rho: 0, clearedTs: 0n, insiderUb: 0n }, referral: r.referral,
        oracleSet: { extraFeeds: [new Uint8Array(32), new Uint8Array(32)] as never, extraCount: 0, quorum: 0, maxSpreadBps: 0, offHoursWidenBps: 0 },
      } as never),
      CROSS_BODY_LEN,
    );
  }
  chain.set(address, { owner: CROSS_CORE_PROGRAM_ADDRESS, data });
  return address;
}
const instructionsOf = (tx: string) => decompileTransactionMessage(getCompiledTransactionMessageDecoder().decode(getTransactionDecoder().decode(Uint8Array.from(Buffer.from(tx, 'base64'))).messageBytes)).instructions;

describe('the local builder on a cross with rules', () => {
  it('reads the rules tail with the cross, and nothing for a cross without it', async () => {
    const ruled = await putCross(1n, { ending: { endingSecs: 400, buckets: 4, randomEnd: false } });
    const plain = await putCross(2n, null);
    expect((await readCrossFromChain(rpc, ruled)).ext?.ending.buckets).toBe(4);
    expect((await readCrossFromChain(rpc, plain)).ext).toBeNull();
  });

  it('places a class-1 buy with the class book and the applicant, and refuses a class on a cross without rules', async () => {
    const ruled = await putCross(3n, { alloc: { reserveBps: [3_000, 0, 0], smallCapQuote: 5_000_000n, lotteryUnit: 5_000_000n }, identity: { capQuote: 50_000_000n, maxOrders: 1 } }, { gate: true });
    const plain = await putCross(4n, null);
    const b = localTxBuilder(rpc);
    const built = await b.placeOrder({ cross: ruled, owner: ALICE, nonce: 1n, side: 'buy', price: 1_300_000n, quantity: 5_000_000n, class: 1 });
    const [ix] = instructionsOf(built.transactions[0]!.transaction);
    expect(COMMIT_ORDER_EXT_DISCRIMINATOR.every((x, i) => ix!.data![i] === x)).toBe(true);
    expect(ix!.accounts!.map((a) => a.address)).toContain(await classBookAddress(ruled));
    await expect(b.placeOrder({ cross: plain, owner: ALICE, nonce: 1n, side: 'buy', price: 1_300_000n, quantity: 5_000_000n, class: 1 })).rejects.toThrow(/no rules/);
  });

  it('cancels an order of an ending bucket in that bucket\'s shard, and claims with the order\'s facts', async () => {
    const ruled = await putCross(5n, { ending: { endingSecs: 400, buckets: 4, randomEnd: false } });
    const order = await orderAddress(ruled, ALICE, 7n);
    const data = new Uint8Array(getOrderEncoder().encode({ cross: ruled, owner: ALICE, nonce: 7n, index: 0, side: 0, state: 1, commitment: new Uint8Array(32), price: 1_300_000n, quantity: 5n, escrow: 7n, bump: 255 } as never).length + 64);
    data.set(getOrderEncoder().encode({ cross: ruled, owner: ALICE, nonce: 7n, index: 0, side: 0, state: 1, commitment: new Uint8Array(32), price: 1_300_000n, quantity: 5n, escrow: 7n, bump: 255 } as never));
    // the order's tail: version 1, epoch 0, bucket 2
    const tailAt = getOrderEncoder().encode({ cross: ruled, owner: ALICE, nonce: 7n, index: 0, side: 0, state: 1, commitment: new Uint8Array(32), price: 0n, quantity: 0n, escrow: 0n, bump: 0 } as never).length;
    data.set([1, 0, 2, 0, 0], tailAt);
    chain.set(order, { owner: CROSS_CORE_PROGRAM_ADDRESS, data });
    const built = await localTxBuilder(rpc).cancel({ cross: ruled, owner: ALICE, nonce: 7n });
    const [ix] = instructionsOf(built.transactions[0]!.transaction);
    expect(ix!.accounts!.map((a) => a.address)).toContain(await shardAddress(ruled, AUX_END_BASE + 2));
  });

  it('settle merges the buckets, and init-shards names the bucket shards a create left undone', async () => {
    const ruled = await putCross(6n, { ending: { endingSecs: 400, buckets: 3, randomEnd: false } });
    for (let i = 0; i < 2; i++) chain.set(await shardAddress(ruled, i), { owner: CROSS_CORE_PROGRAM_ADDRESS, data: new Uint8Array(8) });
    const settle = await localTxBuilder(rpc).settle({ cross: ruled, payer: ALICE });
    // two main shards, three buckets (not drawn: all count), the clear
    expect(settle.transactions).toHaveLength(2 + 3 + 1);
    const init = await localTxBuilder(rpc).initShards({ cross: ruled, payer: ALICE });
    expect(init.transactions).toHaveLength(3);
  });

  it('a cross without rules builds exactly the legacy instructions: three merges and the clear carry no extra accounts', async () => {
    const plain = await putCross(7n, null);
    const settle = await localTxBuilder(rpc).settle({ cross: plain, payer: ALICE });
    expect(settle.transactions.map((t) => instructionsOf(t.transaction)[0]!.accounts!.length)).toEqual([3, 3, 3]);
  });
});

describe('the book of a cross with an ending period', () => {
  it('includes the orders resting in the bucket shards up to the last counted bucket, and skips a bucket shard that does not exist', async () => {
    const ruled = await putCross(8n, { ending: { endingSecs: 400, buckets: 3, randomEnd: false } });
    const level = (qty: bigint) => {
      const zeros = new Array<bigint>(256).fill(0n);
      const counts = new Array<number>(256).fill(0);
      const buy = zeros.slice();
      const bo = counts.slice();
      buy[5] = qty;
      bo[5] = qty > 0n ? 1 : 0;
      return new Uint8Array(getLevelsEncoder().encode({ cross: ruled, buy, sell: zeros, buyOrders: bo, sellOrders: counts, index: 0, pad: new Uint8Array(7) }));
    };
    const { bookAddress } = await import('@opening-cross/sdk');
    chain.set(await bookAddress(ruled), { owner: CROSS_CORE_PROGRAM_ADDRESS, data: level(0n) });
    for (let i = 0; i < 2; i++) chain.set(await shardAddress(ruled, i), { owner: CROSS_CORE_PROGRAM_ADDRESS, data: level(10n) });
    chain.set(await shardAddress(ruled, AUX_END_BASE + 0), { owner: CROSS_CORE_PROGRAM_ADDRESS, data: level(3n) });
    chain.set(await shardAddress(ruled, AUX_END_BASE + 1), { owner: CROSS_CORE_PROGRAM_ADDRESS, data: level(4n) });
    // bucket 2 has no account yet
    const { data, ext } = await readCrossFromChain(rpc, ruled);
    const book = await readBookFromChain(rpc, ruled, data, ext);
    expect(book.levels.find((l) => l.price === '1500000')?.buy).toBe(String(10 + 10 + 3 + 4));
    // read without the tail, as before the rules existed: only the main shards
    const legacy = await readBookFromChain(rpc, ruled, data);
    expect(legacy.levels.find((l) => l.price === '1500000')?.buy).toBe('20');
  });
});
