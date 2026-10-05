// Devnet end-to-end for cross_core (ROADMAP C2): a mint-mode launch with an open book and an
// escrow-mode sealed cross, driven through @opening-cross/sdk exactly as a client would, with
// every outcome checked from chain state and against the independent reference implementation.
//
//   pnpm --filter @opening-cross/devnet-proofs dp:core
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import {
  type Address,
  type Instruction,
  type KeyPairSigner,
  appendTransactionMessageInstructions,
  createKeyPairSignerFromBytes,
  createSolanaRpcSubscriptions,
  createTransactionMessage,
  fetchEncodedAccount,
  generateKeyPairSigner,
  getSignatureFromTransaction,
  pipe,
  sendAndConfirmTransactionFactory,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from '@solana/kit';
import { getCreateAccountInstruction, getTransferSolInstruction } from '@solana-program/system';
import {
  AuthorityType,
  TOKEN_2022_PROGRAM_ADDRESS,
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstruction,
  getInitializeMint2Instruction,
  getMintDecoder,
  getMintSize,
  getMintToInstruction,
  getSetAuthorityInstruction,
  getTokenDecoder,
} from '@solana-program/token-2022';
import {
  CROSS_CORE_PROGRAM_ADDRESS,
  CrossKind,
  CrossState,
  Disclosure,
  OrderSide,
  SupplyMode,
  buildClaim,
  buildCreateCross,
  buildFinalize,
  buildPlaceOrder,
  buildReveal,
  buildSettleBook,
  costCeil,
  crossAddress,
  getCrossDecoder,
  getInitProtocolInstruction,
  getOrderDecoder,
  orderAddress,
  protocolAddress,
  quoteVaultAddress,
} from '@opening-cross/sdk';
import { referenceClear, referenceFills, type RefOrder } from '../../core/src/reference.js';
import { Evidence, ROOT, RPC, rpc } from './lib.js';

const WS = process.env.WS_URL ?? RPC.replace('https://', 'wss://').replace('http://', 'ws://');
const sendAndConfirm = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions: createSolanaRpcSubscriptions(WS) });
const ev = new Evidence('C2-cross-core-devnet.md', 'Devnet end-to-end — cross_core (C2)', [
  'Script `tests/devnet/src/core-e2e.ts` (drives `@opening-cross/sdk`)',
  `Program: cross_core \`${CROSS_CORE_PROGRAM_ADDRESS}\``,
]);
const SCALE = 1_000_000n;
const GRID = { min: 1_000_000n, tick: 100_000n, ticks: 20 };

async function send(ixs: Instruction[], payer: KeyPairSigner): Promise<string> {
  const { value: blockhash } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send();
  const msg = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(payer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions(ixs, m),
  );
  const tx = await signTransactionMessageWithSigners(msg);
  await sendAndConfirm(tx as Parameters<typeof sendAndConfirm>[0], { commitment: 'confirmed' });
  return getSignatureFromTransaction(tx);
}

async function chainTime(): Promise<bigint> {
  const slot = await rpc.getSlot({ commitment: 'confirmed' }).send();
  return BigInt((await rpc.getBlockTime(slot).send()) ?? Math.floor(Date.now() / 1000));
}
async function waitUntil(ts: bigint): Promise<void> {
  while ((await chainTime()) < ts) await new Promise((r) => setTimeout(r, 2_000));
}
async function account(address: Address) {
  const a = await fetchEncodedAccount(rpc, address, { commitment: 'confirmed' });
  if (!a.exists) throw new Error(`missing account ${address}`);
  return a;
}
const crossView = async (address: Address) => ({ address, data: getCrossDecoder().decode((await account(address)).data) });
async function balanceOf(owner: Address, mint: Address): Promise<bigint> {
  const [ata] = await findAssociatedTokenPda({ owner, mint, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS });
  const a = await fetchEncodedAccount(rpc, ata, { commitment: 'confirmed' });
  return a.exists ? getTokenDecoder().decode(a.data).amount : 0n;
}
async function ata(owner: Address, mint: Address): Promise<Address> {
  return (await findAssociatedTokenPda({ owner, mint, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS }))[0];
}

async function main() {
  const operator = await createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(readFileSync(`${ROOT}.keys/opening-bell-devnet.json`, 'utf8'))));

  // Protocol singleton (idempotent across runs).
  const protocol = await protocolAddress();
  if (!(await fetchEncodedAccount(rpc, protocol)).exists) {
    const sig = await send([getInitProtocolInstruction({ admin: operator, protocol, guardian: operator.address, feeRecipient: operator.address, feeBps: [30, 5, 15, 30] })], operator);
    ev.check('protocol', 'protocol initialised (fees 30/5/15/30 bps, guardian set)', true, `protocol ${protocol}`, sig);
  } else {
    ev.check('protocol', 'protocol already initialised', true, `protocol ${protocol}`);
  }

  // Mints: a test quote token and a launch token whose authority goes to the cross PDA.
  const newMint = async (authority: Address) => {
    const mint = await generateKeyPairSigner();
    const space = getMintSize();
    const lamports = await rpc.getMinimumBalanceForRentExemption(BigInt(space)).send();
    await send([getCreateAccountInstruction({ payer: operator, newAccount: mint, lamports, space, programAddress: TOKEN_2022_PROGRAM_ADDRESS }), getInitializeMint2Instruction({ mint: mint.address, decimals: 6, mintAuthority: authority, freezeAuthority: null })], operator);
    return mint.address;
  };
  const quoteMint = await newMint(operator.address);
  const buyers = await Promise.all([generateKeyPairSigner(), generateKeyPairSigner(), generateKeyPairSigner()]);
  const setup: Instruction[] = [];
  for (const who of [operator.address, ...buyers.map((b) => b.address)]) {
    setup.push(getCreateAssociatedTokenIdempotentInstruction({ payer: operator, ata: await ata(who, quoteMint), owner: who, mint: quoteMint, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS }));
  }
  for (const b of buyers) {
    setup.push(getTransferSolInstruction({ source: operator, destination: b.address, amount: 20_000_000n }));
    setup.push(getMintToInstruction({ mint: quoteMint, token: await ata(b.address, quoteMint), mintAuthority: operator, amount: 10_000_000_000n }, { programAddress: TOKEN_2022_PROGRAM_ADDRESS }));
  }
  setup.push(getMintToInstruction({ mint: quoteMint, token: await ata(operator.address, quoteMint), mintAuthority: operator, amount: 1_000_000_000_000n }, { programAddress: TOKEN_2022_PROGRAM_ADDRESS }));
  await send(setup, operator);

  // ---------------- Launch: mint mode, open book ----------------
  const crossId = BigInt(Date.now());
  const cross = await crossAddress(operator.address, crossId);
  const baseMint = await newMint(operator.address);
  await send([getSetAuthorityInstruction({ owned: baseMint, owner: operator, authorityType: AuthorityType.MintTokens, newAuthority: cross }, { programAddress: TOKEN_2022_PROGRAM_ADDRESS }), getCreateAssociatedTokenIdempotentInstruction({ payer: operator, ata: await ata(operator.address, baseMint), owner: operator.address, mint: baseMint, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS })], operator);
  const schedule = [{ price: 1_000_000n, quantity: 1_000_000_000n }, { price: 1_200_000n, quantity: 1_000_000_000n }, { price: 1_500_000n, quantity: 1_000_000_000n }];
  const now = await chainTime();
  const closeTs = now + 45n;
  const built = await buildCreateCross({
    creator: operator, baseMint, quoteMint, baseTokenProgram: TOKEN_2022_PROGRAM_ADDRESS, quoteTokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
    crossId, kind: CrossKind.Launch, supplyMode: SupplyMode.Mint, disclosure: Disclosure.Open,
    minPrice: GRID.min, tick: GRID.tick, ticks: GRID.ticks, priceScale: SCALE, openTs: now - 5n, closeTs, revealEndTs: closeTs,
    referencePrice: null, minMatched: 0n, maxImbalanceBps: null, integratorFeeBps: 20, integrator: operator.address, gateMint: null,
    shards: 2, maxOrders: 16, proceedsTo: operator.address, schedule, settler: null, settleDeadlineTs: 0n, oracle: null,
  });
  const createSig = await send([built.create], operator);
  for (const s of built.shards) await send([s], operator);
  ev.check('launch-create', 'mint-mode launch cross created; cross PDA holds the base mint authority', true, `cross ${cross}, base ${baseMint}, quote ${quoteMint}`, createSig);

  const plan: [KeyPairSigner, bigint, bigint][] = [[buyers[0]!, 1_500_000n, 1_500_000_000n], [buyers[1]!, 1_200_000n, 800_000_000n], [buyers[2]!, 1_100_000n, 500_000_000n]];
  const refOrders: RefOrder[] = schedule.map((s) => ({ side: 'sell', price: s.price, quantity: s.quantity }));
  const buyRefs: RefOrder[] = [];
  for (const [i, [b, price, quantity]] of plan.entries()) {
    const sig = await send([await buildPlaceOrder({ cross: await crossView(cross), owner: b, nonce: BigInt(i), side: OrderSide.Buy, price, quantity })], b);
    buyRefs.push({ side: 'buy', price, quantity });
    ev.check(`launch-bid-${i}`, `bid ${quantity} at ${price} escrowed`, true, `buyer ${b.address}`, sig);
  }
  await waitUntil(closeTs + 1n);
  const settleIxs = await buildSettleBook(await crossView(cross));
  let lastSig = '';
  for (const ix of settleIxs) lastSig = await send([ix], operator);
  const cleared = await crossView(cross);
  const ref = referenceClear([...refOrders, ...buyRefs], GRID, null)!;
  const s = cleared.data.clearing.__option === 'Some' ? cleared.data.clearing.value : null;
  ev.check('launch-clear', 'on-chain clearing price and volume equal the independent reference', cleared.data.state === CrossState.Cleared && s?.price === ref.price && s?.matched === ref.matched, `P* ${s?.price} (ref ${ref.price}), matched ${s?.matched} (ref ${ref.matched})`, lastSig);

  const fills = referenceFills(buyRefs, ref);
  for (const [i, [b]] of plan.entries()) {
    const before = await balanceOf(b.address, quoteMint);
    const sig = await send(await buildClaim(await crossView(cross), operator, b.address, BigInt(i)), operator);
    const got = await balanceOf(b.address, baseMint);
    const refund = (await balanceOf(b.address, quoteMint)) - before;
    const escrow = costCeil(plan[i]![2], plan[i]![1], SCALE);
    const pay = costCeil(fills[i]!, ref.price, SCALE);
    ev.check(`launch-claim-${i}`, 'claim minted the fill and refunded escrow above P*', got === fills[i] && refund === escrow - pay, `fill ${got} (ref ${fills[i]}), refund ${refund} (expected ${escrow - pay})`, sig);
  }
  const finSig = await send([await buildFinalize(await crossView(cross), operator)], operator);
  const mintAfter = getMintDecoder().decode((await account(baseMint)).data);
  const vaultLeft = await (async () => { const a = await fetchEncodedAccount(rpc, await quoteVaultAddress(cross)); return a.exists ? getTokenDecoder().decode(a.data).amount : 0n; })();
  ev.check('launch-finalize', 'finalize: fees and proceeds paid, quote vault empty, mint authority revoked', mintAfter.mintAuthority.__option === 'None' && vaultLeft === 0n, `mintAuthority ${mintAfter.mintAuthority.__option}, quote vault ${vaultLeft}`, finSig);

  // ---------------- Sealed escrow cross ----------------
  const id2 = crossId + 1n;
  const cross2 = await crossAddress(operator.address, id2);
  const now2 = await chainTime();
  const close2 = now2 + 40n;
  const reveal2 = close2 + 40n;
  // Sellers need a separate base token they hold before the cross.
  const sealedBase = await newMint(operator.address);
  const seedBase: Instruction[] = [];
  for (const who of [operator.address, ...buyers.map((b) => b.address)]) {
    seedBase.push(getCreateAssociatedTokenIdempotentInstruction({ payer: operator, ata: await ata(who, sealedBase), owner: who, mint: sealedBase, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS }));
  }
  seedBase.push(getMintToInstruction({ mint: sealedBase, token: await ata(buyers[0]!.address, sealedBase), mintAuthority: operator, amount: 1_000_000_000n }, { programAddress: TOKEN_2022_PROGRAM_ADDRESS }));
  await send(seedBase, operator);
  const b2 = await buildCreateCross({
    creator: operator, baseMint: sealedBase, quoteMint, baseTokenProgram: TOKEN_2022_PROGRAM_ADDRESS, quoteTokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
    crossId: id2, kind: CrossKind.Reopen, supplyMode: SupplyMode.Escrow, disclosure: Disclosure.Sealed,
    minPrice: GRID.min, tick: GRID.tick, ticks: GRID.ticks, priceScale: SCALE, openTs: now2 - 5n, closeTs: close2, revealEndTs: reveal2,
    referencePrice: 1_500_000n, minMatched: 0n, maxImbalanceBps: null, integratorFeeBps: 0, integrator: operator.address, gateMint: null,
    shards: 1, maxOrders: 8, proceedsTo: operator.address, schedule: [], settler: null, settleDeadlineTs: 0n, oracle: null,
  });
  const c2Sig = await send([b2.create, ...b2.shards], operator);
  ev.check('sealed-create', 'sealed escrow-mode cross created', true, `cross ${cross2}`, c2Sig);
  const salts = buyers.map(() => new Uint8Array(randomBytes(32)));
  const sealedPlan: [KeyPairSigner, OrderSide, bigint, bigint, boolean][] = [
    [buyers[0]!, OrderSide.Sell, 1_300_000n, 100_000_000n, true],
    [buyers[1]!, OrderSide.Buy, 1_600_000n, 80_000_000n, true],
    [buyers[2]!, OrderSide.Buy, 1_900_000n, 50_000_000n, false],
  ];
  for (const [i, [w, side, price, qty]] of sealedPlan.entries()) {
    const escrow = side === OrderSide.Buy ? costCeil(qty, 1_900_000n, SCALE) : qty;
    await send([await buildPlaceOrder({ cross: await crossView(cross2), owner: w, nonce: 100n + BigInt(i), side, price, quantity: qty, salt: salts[i]!, escrow })], w);
  }
  const committed = await account(await orderAddress(cross2, buyers[1]!.address, 101n));
  const order = getOrderDecoder().decode(committed.data);
  ev.check('sealed-hidden', 'during the call only a commitment is on chain (price and quantity are zero)', order.price === 0n && order.quantity === 0n, `order ${await orderAddress(cross2, buyers[1]!.address, 101n)} escrow ${order.escrow}`);
  await waitUntil(close2 + 1n);
  for (const [i, [w, , price, qty, reveal]] of sealedPlan.entries()) {
    if (!reveal) continue;
    const o = getOrderDecoder().decode((await account(await orderAddress(cross2, w.address, 100n + BigInt(i)))).data);
    await send([await buildReveal(await crossView(cross2), w, 100n + BigInt(i), o.index, price, qty, salts[i]!)], w);
  }
  await waitUntil(reveal2 + 1n);
  for (const ix of await buildSettleBook(await crossView(cross2))) lastSig = await send([ix], operator);
  const c2 = await crossView(cross2);
  const ref2 = referenceClear(sealedPlan.filter((p) => p[4]).map(([, side, price, quantity]) => ({ side: side === OrderSide.Buy ? 'buy' : 'sell', price, quantity })), GRID, 1_500_000n)!;
  const s2 = c2.data.clearing.__option === 'Some' ? c2.data.clearing.value : null;
  ev.check('sealed-clear', 'sealed cross clears to the reference (reference price rule applied); unrevealed order excluded', s2?.price === ref2.price && s2?.matched === ref2.matched, `P* ${s2?.price} (ref ${ref2.price}), matched ${s2?.matched}`, lastSig);
  const before3 = await balanceOf(buyers[2]!.address, quoteMint);
  for (const [i, [w]] of sealedPlan.entries()) await send(await buildClaim(await crossView(cross2), operator, w.address, 100n + BigInt(i)), operator);
  const refunded = (await balanceOf(buyers[2]!.address, quoteMint)) - before3;
  ev.check('sealed-refund', 'the order that never revealed is refunded in full', refunded === costCeil(50_000_000n, 1_900_000n, SCALE), `refund ${refunded}`);
  const fin2 = await send([await buildFinalize(await crossView(cross2), operator)], operator);
  ev.check('sealed-finalize', 'sealed cross finalised', (await crossView(cross2)).data.state === CrossState.Finalized, 'state Finalized', fin2);
}

main().then(() => ev.write(), (e) => { console.error(e); ev.write(e); });
