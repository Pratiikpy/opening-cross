// Devnet proof for the rules extension of cross_core (docs/evidence/W2D-*.md): what LiteSVM cannot show, the real cluster's
// block hashes and clock. Two crosses, driven the way a client would drive them, every outcome read back from chain state and
// checked against the independent reference implementation.
//
//   A  A mint-mode launch with a hard-to-game ending (two buckets, a drawn last counted bucket, B14/ADR-0452) and a referral
//      share of the protocol fee (W4/ADR-0460). The draw runs on the cluster's SlotHashes. The cleared price, volume and every
//      fill must equal the reference over the orders the draw counted; the referrer must receive exactly floor(fee * share).
//   B  A cross whose minimum raise cannot be met (B5/ADR-0451). It must not print, and `push_refunds` must return every
//      escrow in one transaction without the owners signing (ADR-0457).
//
//   pnpm --filter @opening-cross/devnet-proofs dp:w2d-core
import { readFileSync } from 'node:fs';
import {
  type Address,
  type Instruction,
  type KeyPairSigner,
  createKeyPairSignerFromBytes,
  fetchEncodedAccount,
  generateKeyPairSigner,
} from '@solana/kit';
import { getTransferSolInstruction } from '@solana-program/system';
import { AuthorityType, TOKEN_2022_PROGRAM_ADDRESS, getCreateAssociatedTokenIdempotentInstruction, getMintDecoder, getSetAuthorityInstruction } from '@solana-program/token-2022';
import {
  AUX_END_BASE,
  CrossKind,
  CrossState,
  Disclosure,
  NoPrintReason,
  OrderSide,
  SLOT_HASHES,
  SupplyMode,
  auxBit,
  baseVaultAddress,
  bookAddress,
  buildCreateCross,
  claimExtras,
  clearExtras,
  commitExtras,
  completeRules,
  costCeil,
  crossAddress,
  getClaimInstruction,
  getClearInstruction,
  getCommitOrderInstruction,
  getCrossDecoder,
  getDrawBeginInstruction,
  getDrawFinishInstruction,
  getFinalizeInstruction,
  getInitProtocolInstruction,
  getInitShardInstruction,
  getMergeShardInstruction,
  getOrderDecoder,
  getProtocolDecoder,
  getPushRefundsInstruction,
  getSetRulesInstruction,
  lastBucket,
  orderAddress,
  orderPda,
  placementAt,
  protocolAddress,
  quoteVaultAddress,
  readCrossExt,
  readOrderExt,
  shardAddress,
  shardIndexFor,
  withAccounts,
  writable,
  CROSS_CORE_PROGRAM_ADDRESS,
} from '@opening-cross/sdk';
import { CROSS_GATE_PROGRAM_ADDRESS } from '@opening-cross/cross-gate-client';
import { referenceClear, referenceFills, type RefOrder } from '@opening-cross/verifier';
import { Evidence, ROOT, RPC, rpc } from './lib.js';
import { accountData, ata, ataIx, balanceOf, chainTime, mintTo, newMint, send, sleep, tokenBalance, waitUntil } from './kit.js';

// Against the public devnet endpoint the record is the devnet proof; against anything else (a local validator running the
// same binaries) it is written under another name and says so, so it can never be read as a devnet result.
const onDevnet = /devnet\.solana\.com|helius|quicknode|triton|tatum|onfinality/i.test(RPC) || !process.env.RPC_URL;
const ev = new Evidence(
  onDevnet ? 'W2D-core-devnet.md' : 'W2D-core-local-validator.md',
  onDevnet ? 'Devnet proof: cross_core rules extension (W2D)' : 'Local validator proof: cross_core rules extension (W2D), NOT a devnet result',
  [
    'Script `tests/devnet/src/w2d-core-proof.ts`',
    `Program: cross_core \`${CROSS_CORE_PROGRAM_ADDRESS}\``,
    'Rows exercised: B14 (ending and draw on the cluster block hashes), W4 (referral share), B5 (minimum raise, pushed refunds).',
    ...(onDevnet ? [] : ['Cluster: `solana-test-validator` running the locally built `cross_core` binary and its own Token-2022 and SlotHashes. The devnet run is `scripts/deploy-batch-2.sh` (HUMAN_TASKS H27).']),
  ],
);
const SCALE = 1_000_000n;
const GRID = { min: 1_000_000n, tick: 100_000n, ticks: 20 };

type Placed = { owner: KeyPairSigner; nonce: bigint; side: OrderSide; price: bigint; quantity: bigint; escrow: bigint };

async function crossOf(cross: Address) {
  const data = await accountData(cross);
  return { address: cross, data: getCrossDecoder().decode(data), ext: readCrossExt(data) };
}

async function place(cross: Address, owner: KeyPairSigner, nonce: bigint, price: bigint, quantity: bigint): Promise<Placed> {
  const view = await crossOf(cross);
  const c = view.data;
  const now = await chainTime();
  const placement = placementAt(view.ext, c.closeTs, now);
  const [order, orderBump] = await orderPda(cross, owner.address, nonce);
  const shardIndex = placement.bucket !== 255 ? AUX_END_BASE + placement.bucket : shardIndexFor(owner.address, nonce, c.shards);
  const escrow = costCeil(quantity, price, c.priceScale);
  const ix = getCommitOrderInstruction({
    owner,
    protocol: await protocolAddress(),
    cross,
    order,
    shard: await shardAddress(cross, shardIndex),
    escrowMint: c.quoteMint,
    escrowVault: await quoteVaultAddress(cross),
    ownerEscrow: await ata(owner.address, c.quoteMint),
    escrowTokenProgram: c.quoteTokenProgram,
    nonce,
    side: OrderSide.Buy,
    escrow,
    commitment: new Uint8Array(32),
    price,
    quantity,
    orderBump,
  });
  await send([withAccounts(ix, await commitExtras(view.ext, cross, owner.address, { now, gateProgram: CROSS_GATE_PROGRAM_ADDRESS }))], owner);
  const stored = getOrderDecoder().decode(await accountData(order));
  return { owner, nonce, side: OrderSide.Buy, price, quantity, escrow: stored.escrow };
}

/** The bucket an order was placed in, read back from its extension record (the chain's clock decided it, not ours). */
async function bucketOf(cross: Address, o: Placed): Promise<number> {
  return readOrderExt(await accountData(await orderAddress(cross, o.owner.address, o.nonce))).bucket;
}

async function protocolFeeRecipient(): Promise<Address> {
  return getProtocolDecoder().decode(await accountData(await protocolAddress())).feeRecipient;
}

async function launch(o: { operator: KeyPairSigner; quoteMint: Address; closeInSecs: bigint; integratorFeeBps: number; integrator: Address; rules: Parameters<typeof completeRules>[0]; proceedsTo: Address; shards: number }) {
  const { operator } = o;
  const crossId = BigInt(Date.now()) * 10n + BigInt(Math.floor(Math.random() * 10));
  const cross = await crossAddress(operator.address, crossId);
  const baseMint = await newMint(operator, operator.address);
  await send([getSetAuthorityInstruction({ owned: baseMint, owner: operator, authorityType: AuthorityType.MintTokens, newAuthority: cross }, { programAddress: TOKEN_2022_PROGRAM_ADDRESS }), await ataIx(operator, operator.address, baseMint)], operator);
  const now = await chainTime();
  const closeTs = now + o.closeInSecs;
  const schedule = [
    { price: 1_000_000n, quantity: 1_000_000_000n },
    { price: 1_200_000n, quantity: 1_000_000_000n },
    { price: 1_500_000n, quantity: 1_000_000_000n },
  ];
  const built = await buildCreateCross({
    creator: operator, baseMint, quoteMint: o.quoteMint, baseTokenProgram: TOKEN_2022_PROGRAM_ADDRESS, quoteTokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
    crossId, kind: CrossKind.Launch, supplyMode: SupplyMode.Mint, disclosure: Disclosure.Open,
    minPrice: GRID.min, tick: GRID.tick, ticks: GRID.ticks, priceScale: SCALE, openTs: now - 5n, closeTs, revealEndTs: closeTs,
    referencePrice: null, minMatched: 0n, maxImbalanceBps: null, integratorFeeBps: o.integratorFeeBps, integrator: o.integrator, gateMint: null,
    shards: o.shards, maxOrders: 32, proceedsTo: o.proceedsTo, schedule, settler: null, settleDeadlineTs: 0n, oracle: null, calendar: null,
  });
  const rules = completeRules(o.rules);
  // The rules are written in the slot the cross is created in: both instructions in one transaction.
  const sig = await send([built.create, getSetRulesInstruction({ creator: operator, cross, ...rules })], operator);
  for (const s of built.shards) await send([s], operator);
  const aux: number[] = [];
  if (rules.ending.endingSecs > 0) for (let b = 0; b < rules.ending.buckets; b++) aux.push(AUX_END_BASE + b);
  for (const index of aux) await send([getInitShardInstruction({ payer: operator, cross, shard: await shardAddress(cross, index), index })], operator);
  return { cross, baseMint, closeTs, schedule, createSig: sig };
}

async function main() {
  const operator = await createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(readFileSync(`${ROOT}.keys/opening-bell-devnet.json`, 'utf8'))));
  const protocol = await protocolAddress();
  if (!(await fetchEncodedAccount(rpc, protocol)).exists) {
    await send([getInitProtocolInstruction({ admin: operator, protocol, guardian: operator.address, feeRecipient: operator.address, feeBps: [30, 5, 15, 30] })], operator);
  }
  const feeRecipient = await protocolFeeRecipient();

  const quoteMint = await newMint(operator, operator.address);
  const buyers = await Promise.all([generateKeyPairSigner(), generateKeyPairSigner(), generateKeyPairSigner(), generateKeyPairSigner()]);
  const referrer = await generateKeyPairSigner();
  const proceeds = await generateKeyPairSigner();
  const integrator = await generateKeyPairSigner();
  await send(
    [
      ...(await Promise.all([operator.address, feeRecipient, referrer.address, proceeds.address, integrator.address].map((w) => ataIx(operator, w as Address, quoteMint)))),
      ...buyers.map((b) => getTransferSolInstruction({ source: operator, destination: b.address, amount: 40_000_000n })),
    ],
    operator,
  );
  for (const b of buyers) await mintTo(operator, quoteMint, b.address, operator, 20_000_000_000n);
  // Creating a cross posts a small quote deposit from the creator.
  await mintTo(operator, quoteMint, operator.address, operator, 1_000_000_000n);

  // ---------------- A: ending, draw, referral ----------------
  const a = await launch({
    operator, quoteMint, closeInSecs: 80n, integratorFeeBps: 200, integrator: integrator.address, shards: 2, proceedsTo: proceeds.address,
    rules: { ending: { endingSecs: 24, buckets: 2, cancelCutoffSecs: 0, randomEnd: true }, referral: { referrer: referrer.address, shareBps: 2_500 }, guards: { minRaiseQuote: 1n } },
  });
  const ext = (await crossOf(a.cross)).ext;
  ev.check('A-rules', 'rules written in the creating slot: 2 ending buckets, random end, 25% referral share, minimum raise 1', ext !== null && ext.ending.buckets === 2 && ext.ending.randomEnd && ext.referral.shareBps === 2_500, `cross ${a.cross}`, a.createSig);

  const plan: [KeyPairSigner, bigint, bigint][] = [[buyers[0]!, 1_500_000n, 1_500_000_000n], [buyers[1]!, 1_200_000n, 800_000_000n]];
  const placed: Placed[] = [];
  for (const [i, [b, price, qty]] of plan.entries()) placed.push(await place(a.cross, b, BigInt(i), price, qty));
  // Bucket 0 is the first twelve seconds of the ending, bucket 1 the next twelve; aim for the middle of each.
  await waitUntil(a.closeTs - 24n + 3n);
  placed.push(await place(a.cross, buyers[2]!, 2n, 1_100_000n, 600_000_000n));
  await waitUntil(a.closeTs - 24n + 15n);
  placed.push(await place(a.cross, buyers[3]!, 3n, 1_400_000n, 700_000_000n));
  const buckets = await Promise.all(placed.map((o) => bucketOf(a.cross, o)));
  ev.check('A-buckets', 'orders landed in the bucket of the instant the chain clock saw them (main, main, 0, 1)', buckets[0] === 255 && buckets[1] === 255 && buckets[2] === 0 && buckets[3] === 1, `buckets ${buckets.join(', ')}`);

  await waitUntil(a.closeTs + 1n);
  // The draw: begin, then at least 20 slots later finish with the cluster's SlotHashes.
  const beginSig = await send([getDrawBeginInstruction({ cross: a.cross })], operator);
  const beginSlot = (await rpc.getSlot({ commitment: 'confirmed' }).send());
  while ((await rpc.getSlot({ commitment: 'confirmed' }).send()) < beginSlot + 25n) await sleep(1_000);
  let finishSig = '';
  for (let attempt = 0; ; attempt++) {
    try {
      finishSig = await send([getDrawFinishInstruction({ cross: a.cross, slotHashes: SLOT_HASHES })], operator);
      break;
    } catch (e) {
      if (attempt >= 3) throw e;
      await sleep(3_000);
    }
  }
  let view = await crossOf(a.cross);
  const last = lastBucket(view.ext!);
  ev.check('A-draw', 'the draw finished on the cluster block hashes and fixed the last counted bucket', view.ext!.draw.endBucket !== 255, `last counted bucket ${last}`, finishSig);
  void beginSig;

  // Merge main shards, the counted ending buckets, then clear.
  const book = await bookAddress(a.cross);
  const ixs: Instruction[] = [];
  for (let i = 0; i < view.data.shards; i++) ixs.push(getMergeShardInstruction({ cross: a.cross, book, shard: await shardAddress(a.cross, i) }));
  for (let b = 0; b <= last; b++) ixs.push(getMergeShardInstruction({ cross: a.cross, book, shard: await shardAddress(a.cross, AUX_END_BASE + b) }));
  void auxBit;
  ixs.push(withAccounts(getClearInstruction({ cross: a.cross, book }), await clearExtras(view.ext, a.cross, a.baseMint, {})));
  let lastSig = '';
  for (const ix of ixs) lastSig = await send([ix], operator);
  view = await crossOf(a.cross);

  const counted = placed.filter((_, i) => buckets[i] === 255 || buckets[i]! <= last);
  const sells: RefOrder[] = a.schedule.map((s) => ({ side: 'sell', price: s.price, quantity: s.quantity }));
  const buys: RefOrder[] = counted.map((o) => ({ side: 'buy', price: o.price, quantity: o.quantity }));
  const ref = referenceClear([...sells, ...buys], GRID, null);
  const s = view.data.clearing.__option === 'Some' ? view.data.clearing.value : null;
  ev.check('A-clear', 'on-chain price and volume equal the independent reference over the orders the draw counted', !!ref && view.data.state === CrossState.Cleared && s?.price === ref.price && s?.matched === ref.matched, `P* ${s?.price} (ref ${ref?.price}), matched ${s?.matched} (ref ${ref?.matched}), counted ${counted.length} of 4 orders, last bucket ${last}`, lastSig);

  // Claim every order (a stranger pays); the excluded bucket's order is refunded in full.
  const fills = ref ? referenceFills(buys, ref) : [];
  for (const [i, o] of placed.entries()) {
    const countedIndex = counted.indexOf(o);
    const wantFill = countedIndex >= 0 ? fills[countedIndex]! : 0n;
    const wantPay = ref && wantFill > 0n ? costCeil(wantFill, ref.price, SCALE) : 0n;
    const beforeQuote = await balanceOf(o.owner.address, quoteMint);
    const c = view.data;
    const ownerBase = await ata(o.owner.address, c.baseMint);
    const claim = getClaimInstruction({
      payer: operator, cross: a.cross, owner: o.owner.address, order: await orderAddress(a.cross, o.owner.address, o.nonce),
      quoteVault: await quoteVaultAddress(a.cross), ownerQuote: await ata(o.owner.address, c.quoteMint), baseMint: c.baseMint, ownerBase,
      quoteMint: c.quoteMint, baseTokenProgram: c.baseTokenProgram, quoteTokenProgram: c.quoteTokenProgram,
    });
    const sig = await send([getCreateAssociatedTokenIdempotentInstruction({ payer: operator, ata: ownerBase, owner: o.owner.address, mint: c.baseMint, tokenProgram: c.baseTokenProgram }), withAccounts(claim, await claimExtras(a.cross, o.owner.address, o.nonce, { isBuy: true, ext: readOrderExt(await accountData(await orderAddress(a.cross, o.owner.address, o.nonce))) }))], operator);
    const got = await balanceOf(o.owner.address, c.baseMint);
    const refund = (await balanceOf(o.owner.address, quoteMint)) - beforeQuote;
    ev.check(`A-claim-${i}`, countedIndex >= 0 ? `bucket ${buckets[i] === 255 ? 'main' : buckets[i]} order filled as the reference says` : `bucket ${buckets[i]} order (after the drawn end) refunded in full`, got === wantFill && refund === o.escrow - wantPay, `fill ${got} (ref ${wantFill}), refund ${refund} (expected ${o.escrow - wantPay})`, sig);
  }

  // Finalize with the referrer's account; split of the protocol fee must be exact.
  const feeBefore = await balanceOf(feeRecipient, quoteMint);
  const proceedsBefore = await balanceOf(proceeds.address, quoteMint);
  const refBefore = await balanceOf(referrer.address, quoteMint);
  const c = view.data;
  const fin = withAccounts(
    getFinalizeInstruction({
      payer: operator, cross: a.cross, baseMint: c.baseMint, quoteMint: c.quoteMint, quoteVault: await quoteVaultAddress(a.cross),
      feeRecipientQuote: await ata(feeRecipient, c.quoteMint), integratorQuote: await ata(c.integrator, c.quoteMint), proceedsQuote: await ata(c.proceedsTo, c.quoteMint),
      baseTokenProgram: c.baseTokenProgram, quoteTokenProgram: c.quoteTokenProgram,
    }),
    [writable(await ata(referrer.address, c.quoteMint))],
  );
  const finSig = await send([fin], operator);
  const feeGot = (await balanceOf(feeRecipient, quoteMint)) - feeBefore;
  const refGot = (await balanceOf(referrer.address, quoteMint)) - refBefore;
  const proceedsGot = (await balanceOf(proceeds.address, quoteMint)) - proceedsBefore;
  const protocolFee = feeGot + refGot;
  const integratorGot = await balanceOf(integrator.address, quoteMint);
  const buyerPaid = (await crossOf(a.cross)).data.buyerPaid;
  const dustBond = (await crossOf(a.cross)).data.dustBond;
  const totalFees = (buyerPaid * 230n) / 10_000n;
  const expectedProtocol = (totalFees * 30n) / 230n;
  const vaultLeft = await tokenBalance(await quoteVaultAddress(a.cross));
  const mintAfter = getMintDecoder().decode(await accountData(a.baseMint));
  ev.check(
    'A-fees',
    'fees on the buyers payment: protocol 30 bps (capped at a fifth of the total), integrator 200 bps; the issuer receives the payment less both fees, plus its returned creation deposit',
    protocolFee === expectedProtocol && integratorGot === totalFees - expectedProtocol && proceedsGot === buyerPaid - totalFees + dustBond,
    `payment ${buyerPaid}; protocol ${protocolFee} (expected ${expectedProtocol}); integrator ${integratorGot} (expected ${totalFees - expectedProtocol}); proceeds ${proceedsGot} (payment less fees plus the creator's returned deposit ${dustBond})`,
    finSig,
  );
  ev.check(
    'A-referral',
    'the referrer receives exactly floor(protocol fee x 25%), the fee recipient the rest, and the vault ends empty with the mint authority revoked',
    refGot === (protocolFee * 2_500n) / 10_000n && refGot > 0n && feeGot === protocolFee - refGot && vaultLeft === 0n && mintAfter.mintAuthority.__option === 'None',
    `protocol fee ${protocolFee} = recipient ${feeGot} + referrer ${refGot}; vault ${vaultLeft}; mint authority ${mintAfter.mintAuthority.__option}`,
    finSig,
  );

  // ---------------- B: no print, pushed refunds ----------------
  const b = await launch({
    operator, quoteMint, closeInSecs: 45n, integratorFeeBps: 0, integrator: integrator.address, shards: 2, proceedsTo: proceeds.address,
    rules: { guards: { minRaiseQuote: 1_000_000_000_000_000n } },
  });
  const bOrders: Placed[] = [];
  bOrders.push(await place(b.cross, buyers[0]!, 10n, 1_300_000n, 500_000_000n));
  bOrders.push(await place(b.cross, buyers[1]!, 11n, 1_600_000n, 300_000_000n));
  await waitUntil(b.closeTs + 1n);
  const bView = await crossOf(b.cross);
  const bBook = await bookAddress(b.cross);
  let bSig = '';
  for (let i = 0; i < bView.data.shards; i++) bSig = await send([getMergeShardInstruction({ cross: b.cross, book: bBook, shard: await shardAddress(b.cross, i) })], operator);
  bSig = await send([withAccounts(getClearInstruction({ cross: b.cross, book: bBook }), await clearExtras(bView.ext, b.cross, b.baseMint, {}))], operator);
  const cleared = await crossOf(b.cross);
  ev.check('B-no-print', 'a minimum raise nobody can meet: the cross does not print (reason BelowMinimumRaise)', cleared.data.state === CrossState.NoPrint && cleared.data.noPrintReason.__option === 'Some' && cleared.data.noPrintReason.value === NoPrintReason.BelowMinimumRaise, `state ${CrossState[cleared.data.state]}, reason ${cleared.data.noPrintReason.__option === 'Some' ? NoPrintReason[cleared.data.noPrintReason.value] : 'none'}`, bSig);

  const before = await Promise.all(bOrders.map((o) => balanceOf(o.owner.address, quoteMint)));
  const bc = cleared.data;
  const push = getPushRefundsInstruction({
    cross: b.cross, quoteMint: bc.quoteMint, quoteVault: await quoteVaultAddress(b.cross), baseMint: bc.baseMint, baseVault: await baseVaultAddress(b.cross),
    quoteTokenProgram: bc.quoteTokenProgram, baseTokenProgram: bc.baseTokenProgram,
  });
  const extra = [];
  for (const o of bOrders) extra.push(writable(await orderAddress(b.cross, o.owner.address, o.nonce)), writable(o.owner.address), writable(await ata(o.owner.address, bc.quoteMint)));
  const pushSig = await send([withAccounts(push, extra)], operator);
  const after = await Promise.all(bOrders.map((o) => balanceOf(o.owner.address, quoteMint)));
  const closed = await Promise.all(bOrders.map(async (o) => !(await fetchEncodedAccount(rpc, await orderAddress(b.cross, o.owner.address, o.nonce), { commitment: 'confirmed' })).exists));
  ev.check('B-push-refunds', 'one transaction, signed by neither owner, returns both escrows in full and closes both orders', after.every((x, i) => x === before[i]! + bOrders[i]!.escrow) && closed.every(Boolean), `refunded ${bOrders.map((o) => o.escrow).join(', ')}; orders closed ${closed.join(', ')}`, pushSig);
}

main().then(() => ev.write(), (e) => { console.error(e); ev.write(e); });
void RPC;
