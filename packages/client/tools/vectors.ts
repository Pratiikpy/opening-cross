// The vectors the Rust SDK is tested against: what @opening-cross/sdk computes for a fixed set of inputs. Deterministic, so the
// checked-in file changes only when the SDK or the IDL does (test/cross-language.test.ts fails until it is regenerated).
import { createHash } from 'node:crypto';
import { type Address, type Instruction, createNoopSigner, getAddressDecoder, getAddressEncoder, getProgramDerivedAddress, getU64Encoder } from '@solana/kit';
import { TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import { TOKEN_2022_PROGRAM_ADDRESS } from '@solana-program/token-2022';
import {
  CROSS_CORE_PROGRAM_ADDRESS,
  CrossKind,
  CrossState,
  Disclosure,
  OrderSide,
  SupplyMode,
  type CrossView,
  buildCancel,
  buildClaim,
  buildCreateCross,
  buildFinalize,
  buildFinalizeWithAccounts,
  buildMissingShards,
  buildPlaceOrder,
  buildReveal,
  buildSettleBook,
  costCeil,
  crossAddress,
  getCrossDecoder,
  getCrossEncoder,
  getLevelsEncoder,
  getOrderEncoder,
  orderCommitment,
  orderPda,
  shardIndexFor,
  protocolAddress,
  bookAddress,
  shardAddress,
  quoteVaultAddress,
  baseVaultAddress,
  gatePassAddress,
  ata,
} from '@opening-cross/sdk';
import { CROSS_GATE_PROGRAM_ADDRESS } from '@opening-cross/cross-gate-client';

const dec = getAddressDecoder();
const hex = (b: ArrayLike<number>) => Buffer.from(b as Uint8Array).toString('hex');
const key = (label: string): Address => dec.decode(createHash('sha256').update(`opening-cross sdk vector: ${label}`).digest());
const bytes32 = (label: string) => Uint8Array.from(createHash('sha256').update(`salt: ${label}`).digest());
const ix = (i: Instruction) => ({
  programId: i.programAddress,
  accounts: (i.accounts ?? []).map((a) => ({ pubkey: a.address, signer: a.role >= 2, writable: a.role === 1 || a.role === 3 })),
  data: hex(i.data ?? []),
});
const enc = getAddressEncoder();
const u64 = getU64Encoder();
const seed = (s: string) => new TextEncoder().encode(s);

const creators = [key('creator-0'), key('creator-1'), key('creator-2')];
const owners = [key('owner-0'), key('owner-1'), key('owner-2'), key('owner-3')];
const mints = [key('mint-0'), key('mint-1'), key('mint-2')];
const programs = [TOKEN_PROGRAM_ADDRESS, TOKEN_2022_PROGRAM_ADDRESS];
const ids = [0n, 1n, 7n, 255n, 65_536n, 0xffff_ffffn, 0x1_0000_0000n, (1n << 63n) + 5n, (1n << 64n) - 1n];

async function pdas() {
  const rows: Record<string, unknown>[] = [];
  const protocol = await getProgramDerivedAddress({ programAddress: CROSS_CORE_PROGRAM_ADDRESS, seeds: [seed('protocol')] });
  rows.push({ kind: 'protocol', address: protocol[0], bump: protocol[1] });
  expectEq(protocol[0], await protocolAddress());
  for (const creator of creators) {
    for (const id of ids) {
      const [cross, bump] = await getProgramDerivedAddress({ programAddress: CROSS_CORE_PROGRAM_ADDRESS, seeds: [seed('cross'), enc.encode(creator), u64.encode(id)] });
      expectEq(cross, await crossAddress(creator, id));
      rows.push({ kind: 'cross', creator, crossId: id.toString(), address: cross, bump });
    }
  }
  for (const creator of creators) {
    const cross = await crossAddress(creator, 7n);
    for (const [kind, fn, label] of [
      ['book', bookAddress, 'book'],
      ['quote_vault', quoteVaultAddress, 'quote_vault'],
      ['base_vault', baseVaultAddress, 'base_vault'],
    ] as const) {
      const [a, bump] = await getProgramDerivedAddress({ programAddress: CROSS_CORE_PROGRAM_ADDRESS, seeds: [seed(label), enc.encode(cross)] });
      expectEq(a, await fn(cross));
      rows.push({ kind, cross, address: a, bump });
    }
    for (const index of [0, 1, 7, 31, 255]) {
      const [a, bump] = await getProgramDerivedAddress({ programAddress: CROSS_CORE_PROGRAM_ADDRESS, seeds: [seed('shard'), enc.encode(cross), new Uint8Array([index])] });
      expectEq(a, await shardAddress(cross, index));
      rows.push({ kind: 'shard', cross, index, address: a, bump });
    }
    for (const owner of owners) {
      for (const nonce of [0n, 1n, 281_474_976_710_655n, (1n << 64n) - 1n]) {
        const [a, bump] = await orderPda(cross, owner, nonce);
        rows.push({ kind: 'order', cross, owner, nonce: nonce.toString(), address: a, bump });
      }
    }
  }
  for (const mint of mints) {
    for (const owner of owners) {
      const [a, bump] = await getProgramDerivedAddress({ programAddress: CROSS_GATE_PROGRAM_ADDRESS, seeds: [seed('pass'), enc.encode(mint), enc.encode(owner)] });
      expectEq(a, await gatePassAddress(mint, owner));
      rows.push({ kind: 'gate_pass', gateMint: mint, owner, address: a, bump });
    }
  }
  for (const tokenProgram of programs) {
    for (const mint of mints) {
      for (const owner of owners) rows.push({ kind: 'ata', owner, mint, tokenProgram, address: await ata(owner, mint, tokenProgram) });
    }
  }
  return rows;
}

function expectEq(a: unknown, b: unknown) {
  if (a !== b) throw new Error(`the generator's own derivation disagrees with the SDK: ${String(a)} vs ${String(b)}`);
}

function shardRows() {
  const rows: Record<string, unknown>[] = [];
  for (const owner of owners) {
    for (const shards of [1, 2, 3, 7, 32, 255]) {
      for (const nonce of [0n, 1n, 2n, 3n, 99n, 1_000_003n, (1n << 64n) - 1n]) rows.push({ owner, nonce: nonce.toString(), shards, index: shardIndexFor(owner, nonce, shards) });
    }
  }
  return rows;
}

function commitmentRows() {
  const rows: Record<string, unknown>[] = [];
  let n = 0;
  for (const cross of [key('cross-a'), key('cross-b')]) {
    for (const owner of owners.slice(0, 2)) {
      for (const side of [OrderSide.Buy, OrderSide.Sell]) {
        for (const [price, quantity] of [[1_200_000n, 5_000_000_000n], [1n, 1n], [(1n << 64n) - 1n, (1n << 64n) - 1n], [0n, 0n]] as const) {
          const salt = bytes32(`c${n++}`);
          rows.push({ cross, owner, nonce: String(n * 31), side: side === OrderSide.Buy ? 'buy' : 'sell', price: price.toString(), quantity: quantity.toString(), salt: hex(salt), commitment: hex(orderCommitment(cross, owner, BigInt(n * 31), side, price, quantity, salt)) });
        }
      }
    }
  }
  return rows;
}

function pricingRows() {
  const rows: Record<string, unknown>[] = [];
  const cases: [bigint, bigint, bigint][] = [[3n, 10n, 4n], [4n, 10n, 4n], [0n, 5n, 3n], [1n, 1n, 1_000_000_000n], [5_000_000_000n, 1_200_000n, 1_000_000_000n], [(1n << 64n) - 1n, 1n, 1n], [1n << 40n, 1n << 20n, 1n << 20n], [999_999_999n, 1_999_999n, 1_000_000n], [7n, 0n, 9n]];
  for (const [quantity, price, scale] of cases) rows.push({ quantity: quantity.toString(), price: price.toString(), scale: scale.toString(), costCeil: costCeil(quantity, price, scale).toString() });
  return rows;
}

// ---- accounts: bytes the TypeScript codecs write, and the fields they were written from.
const U64 = (1n << 64n) - 1n;
function crossArgs(variant: number, creator: Address) {
  const full = variant === 1;
  const unbound = variant === 2;
  return {
    creator,
    crossId: BigInt(variant) * 1000n + 7n,
    kind: [CrossKind.Launch, CrossKind.Reopen, CrossKind.Tender, CrossKind.Recurring][variant % 4]!,
    supplyMode: [SupplyMode.Escrow, SupplyMode.Mint, SupplyMode.DeferredMint][variant % 3]!,
    disclosure: variant % 2 === 0 ? Disclosure.Open : Disclosure.Sealed,
    state: [CrossState.Live, CrossState.Cleared, CrossState.NoPrint, CrossState.Finalized][variant % 4]!,
    baseMint: key(`base-${variant}`),
    quoteMint: key(`quote-${variant}`),
    baseTokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
    quoteTokenProgram: variant % 2 === 0 ? TOKEN_PROGRAM_ADDRESS : TOKEN_2022_PROGRAM_ADDRESS,
    baseDecimals: 6 + variant,
    quoteDecimals: 6,
    proceedsTo: key(`proceeds-${variant}`),
    minPrice: 1_000_000n + BigInt(variant),
    tick: 50_000n,
    ticks: 40 + variant,
    priceScale: 1_000_000n,
    openTs: 1_700_000_000n + BigInt(variant),
    closeTs: 1_700_000_300n,
    revealEndTs: 1_700_000_600n,
    referencePrice: full ? 1_234_567n : null,
    minMatched: full ? 42n : 0n,
    maxImbalanceBps: full ? 2_500 : null,
    protocolFeeBps: 5 + variant,
    integratorFeeBps: 20 + variant,
    integrator: key(`integrator-${variant}`),
    feeRecipient: key(`fee-${variant}`),
    gateMint: full ? key('gate-mint') : null,
    shards: 2 + variant,
    maxOrders: 64_000 + variant,
    dustBond: full ? 9_999n : 0n,
    ordersTotal: 11 + variant,
    ordersOpen: 7,
    mergedMask: full ? 0b101 : 0,
    clearing: full ? { price: 1_250_000n, matched: (1n << 100n) + 3n, demand: (1n << 101n) + 1n, supply: (1n << 99n) + 9n, rationed: 2, marginalQuantity: (1n << 90n) + 4n, marginalRemaining: 123_456_789_012_345_678_901n, marginalOrders: 12 } : null,
    noPrintReason: variant === 3 ? 4 : null,
    buyerPaid: full ? U64 : 1n,
    baseBought: 2n,
    baseSold: 3n,
    sellerPaid: 4n,
    feesAccrued: 5n,
    oracle: full ? { feedId: bytes32('feed'), maxDivergenceBps: 300, maxStalenessSecs: 60 } : null,
    calendar: full ? key('calendar') : null,
    settler: unbound || full ? key('settler') : null,
    settleDeadlineTs: unbound ? 1_700_009_999n : 0n,
    baseBound: !unbound,
    bump: 254,
    quoteVaultBump: 253,
    baseVaultBump: 252,
    bookBump: 251,
  } as const;
}

function accountRows() {
  const crosses = [0, 1, 2, 3, 4, 5].map((v) => {
    const args = crossArgs(v, creators[v % 3]!);
    const encoded = getCrossEncoder().encode(args as never);
    return { hex: hex(encoded), padding: v % 2 === 0 ? 17 : 0, fields: jsonSafe(args) };
  });
  const orders = [0, 1, 2].map((v) => {
    const args = { cross: key(`oc-${v}`), owner: owners[v]!, nonce: 40n + BigInt(v), index: 9 + v, side: v % 2 === 0 ? OrderSide.Buy : OrderSide.Sell, state: v === 0 ? 0 : 1, commitment: bytes32(`oc${v}`), price: 1_300_000n + BigInt(v), quantity: U64 - BigInt(v), escrow: 5n << 30n, bump: 250 - v };
    return { hex: hex(getOrderEncoder().encode(args as never)), fields: jsonSafe(args) };
  });
  const levels = [0, 1].map((v) => {
    const buy = Array.from({ length: 256 }, (_, i) => BigInt(i * 1000 + v));
    const sell = Array.from({ length: 256 }, (_, i) => BigInt(i * 7 + v) << 20n);
    const args = { cross: key(`lv-${v}`), buy, sell, buyOrders: Array.from({ length: 256 }, (_, i) => i + v), sellOrders: Array.from({ length: 256 }, (_, i) => 255 - i), index: v, pad: new Uint8Array(7) };
    return { hex: hex(getLevelsEncoder().encode(args as never)), fields: jsonSafe(args) };
  });
  return { crosses, orders, levels };
}

function jsonSafe(v: unknown): unknown {
  return JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x instanceof Uint8Array ? hex(x) : x)));
}

// ---- instructions: every builder, on a spread of crosses.
type Scenario = { name: string; cross: Address; args: ReturnType<typeof crossArgs> };

async function scenarios(): Promise<(Scenario & { view: CrossView })[]> {
  const out: (Scenario & { view: CrossView })[] = [];
  for (const v of [0, 1, 2, 3, 4, 5]) {
    const args = crossArgs(v, creators[v % 3]!);
    const cross = await crossAddress(args.creator, args.crossId);
    const data = getCrossEncoder().encode(args as never);
    out.push({ name: `cross-${v}`, cross, args, view: { address: cross, data: getCrossDecoder().decode(data) } });
  }
  return out;
}

async function instructionRows() {
  const rows: Record<string, unknown>[] = [];
  const sc = await scenarios();
  for (const s of sc) {
    const base = { scenario: s.name, crossHex: hex(getCrossEncoder().encode(s.args as never)), cross: s.cross };
    const owner = owners[1]!;
    const signer = createNoopSigner(owner);
    const payer = createNoopSigner(owners[2]!);
    for (const side of [OrderSide.Buy, OrderSide.Sell]) {
      for (const nonce of [5n, 999_999n]) {
        const salt = bytes32(`${s.name}-${nonce}`);
        const opts = { cross: s.view, owner: signer, nonce, side, price: 1_300_000n, quantity: 2_000_000_000n } as const;
        const sealed = s.view.data.disclosure === Disclosure.Sealed;
        rows.push({ ...base, builder: 'place_order', input: { owner, nonce: nonce.toString(), side: side === OrderSide.Buy ? 'buy' : 'sell', price: '1300000', quantity: '2000000000', escrow: null, salt: hex(salt) }, instructions: [ix(await buildPlaceOrder({ ...opts, ...(sealed ? { salt } : {}) }))] });
        rows.push({ ...base, builder: 'place_order', input: { owner, nonce: nonce.toString(), side: side === OrderSide.Buy ? 'buy' : 'sell', price: '1300000', quantity: '2000000000', escrow: '7777777777', salt: hex(salt) }, instructions: [ix(await buildPlaceOrder({ ...opts, escrow: 7_777_777_777n, ...(sealed ? { salt } : {}) }))] });
        for (const revealed of [true, false]) {
          rows.push({ ...base, builder: 'cancel_order', input: { owner, nonce: nonce.toString(), side: side === OrderSide.Buy ? 'buy' : 'sell', revealed }, instructions: [ix(await buildCancel(s.view, signer, nonce, side, revealed))] });
        }
      }
    }
    rows.push({ ...base, builder: 'reveal_order', input: { owner, nonce: '5', price: '1300000', quantity: '2000000000', salt: hex(bytes32('reveal')) }, instructions: [ix(await buildReveal(s.view, signer, 5n, 1_300_000n, 2_000_000_000n, bytes32('reveal')))] });
    for (const mask of [0, 0b1, 0b101]) {
      const view: CrossView = { address: s.view.address, data: { ...s.view.data, mergedMask: mask } };
      const oracle = s.view.data.oracle.__option === 'Some' ? { oraclePrice: key('pyth') } : {};
      const withPrice = { builder: 'settle_book', input: { mergedMask: mask, oraclePrice: 'oraclePrice' in oracle ? oracle.oraclePrice : null }, crossHex: hex(getCrossEncoder().encode({ ...s.args, mergedMask: mask } as never)) };
      rows.push({ ...base, ...withPrice, instructions: (await buildSettleBook(view, oracle)).map(ix) });
      // An oracle-guarded cross refuses to settle without a price account; a plain one accepts one anyway and passes it through.
      if (s.view.data.oracle.__option === 'Some') {
        let refused = false;
        try { await buildSettleBook(view); } catch { refused = true; }
        if (!refused) throw new Error('expected the SDK to refuse a guarded clear without a price');
        rows.push({ ...base, builder: 'settle_book_refused', input: { mergedMask: mask, oraclePrice: null }, crossHex: withPrice.crossHex, instructions: [] });
      } else {
        rows.push({ ...base, builder: 'settle_book', input: { mergedMask: mask, oraclePrice: key('pyth-extra') }, crossHex: withPrice.crossHex, instructions: (await buildSettleBook(view, { oraclePrice: key('pyth-extra') })).map(ix) });
      }
    }
    rows.push({ ...base, builder: 'claim', input: { payer: owners[2], owner, nonce: '5' }, instructions: (await buildClaim(s.view, payer, owner, 5n)).map(ix) });
    rows.push({ ...base, builder: 'finalize', input: { payer: owners[2] }, instructions: [ix(await buildFinalize(s.view, payer))] });
    rows.push({ ...base, builder: 'finalize_with_accounts', input: { payer: owners[2] }, instructions: (await buildFinalizeWithAccounts(s.view, payer)).map(ix) });
    const present = new Set<Address>();
    for (let i = 0; i < s.view.data.shards; i += 2) present.add(await shardAddress(s.view.address, i));
    rows.push({ ...base, builder: 'missing_shards', input: { payer: owners[2], existing: [...present] }, instructions: (await buildMissingShards(s.view, payer, async (a) => present.has(a))).map(ix) });
  }
  // create_cross, on the shapes the program accepts.
  for (const [i, shape] of [
    { supplyMode: SupplyMode.Escrow, disclosure: Disclosure.Open, base: true, gate: false, oracle: false, calendar: false, schedule: [] as { price: bigint; quantity: bigint }[] },
    { supplyMode: SupplyMode.Mint, disclosure: Disclosure.Sealed, base: true, gate: true, oracle: true, calendar: true, schedule: [{ price: 1_200_000n, quantity: 1_000_000_000n }, { price: 1_500_000n, quantity: 2_000_000_000n }] },
    { supplyMode: SupplyMode.DeferredMint, disclosure: Disclosure.Sealed, base: false, gate: false, oracle: false, calendar: false, schedule: [{ price: 1_000_000n, quantity: 5n }] },
  ].entries()) {
    const creator = creators[i]!;
    const params = {
      crossId: 40n + BigInt(i),
      kind: CrossKind.Launch,
      supplyMode: shape.supplyMode,
      disclosure: shape.disclosure,
      minPrice: 1_000_000n,
      tick: 50_000n,
      ticks: 40,
      priceScale: 1_000_000n,
      openTs: 1_700_000_000n,
      closeTs: 1_700_000_300n,
      revealEndTs: 1_700_000_600n,
      referencePrice: i === 1 ? 1_100_000n : null,
      minMatched: i === 1 ? 10n : 0n,
      maxImbalanceBps: i === 1 ? 5_000 : null,
      integratorFeeBps: 20,
      integrator: key(`create-integrator-${i}`),
      gateMint: shape.gate ? key('create-gate') : null,
      oracle: shape.oracle ? { feedId: bytes32('create-feed'), maxDivergenceBps: 250, maxStalenessSecs: 90 } : null,
      calendar: shape.calendar ? key('create-calendar') : null,
      shards: 3 + i,
      maxOrders: 1_000 + i,
      proceedsTo: key(`create-proceeds-${i}`),
      schedule: shape.schedule,
      settler: i === 2 ? key('create-settler') : null,
      settleDeadlineTs: i === 2 ? 1_700_086_400n : 0n,
    };
    const baseMint = key(`create-base-${i}`);
    const quoteMint = key(`create-quote-${i}`);
    const built = await buildCreateCross({ creator: createNoopSigner(creator), ...(shape.base ? { baseMint } : {}), quoteMint, baseTokenProgram: TOKEN_2022_PROGRAM_ADDRESS, quoteTokenProgram: i === 0 ? TOKEN_PROGRAM_ADDRESS : TOKEN_2022_PROGRAM_ADDRESS, ...params } as never);
    rows.push({
      builder: 'create_cross',
      scenario: `create-${i}`,
      cross: built.cross,
      input: {
        creator,
        baseMint: shape.base ? baseMint : null,
        quoteMint,
        baseTokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
        quoteTokenProgram: i === 0 ? TOKEN_PROGRAM_ADDRESS : TOKEN_2022_PROGRAM_ADDRESS,
        params: jsonSafe({ ...params, kind: 'launch', supplyMode: ['escrow', 'mint', 'deferred-mint'][shape.supplyMode], disclosure: ['sealed', 'open'][shape.disclosure] }),
      },
      instructions: [ix(built.ensureCreatorQuote), ix(built.create), ...built.shards.map(ix)],
    });
  }
  return rows;
}

export async function buildVectors() {
  return {
    schema: 'opening-cross/sdk-vectors/v1',
    producer: 'typescript',
    programs: { crossCore: CROSS_CORE_PROGRAM_ADDRESS, crossGate: CROSS_GATE_PROGRAM_ADDRESS },
    pda: await pdas(),
    shardIndex: shardRows(),
    commitments: commitmentRows(),
    pricing: pricingRows(),
    accounts: accountRows(),
    instructions: await instructionRows(),
  };
}
