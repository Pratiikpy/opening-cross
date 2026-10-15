// Devnet proof for the per-cross depth route (ROADMAP X8, docs/evidence/W5-1C.md).
//
// A real cross is created on the deployed cross_core with an open book: the issuer offers 1,500 tokens at 1.00 and 1,500 at 1.30 (the launch schedule),
// one bidder bids 1,000 at 1.60 and another 1,800 at 1.30. Then:
//
//   1. GET /v1/depth/cross/:address is read against the live chain and compared with the verifier's reference clearing of the same four orders;
//   2. the price impact it predicts for a market buy of S tokens is written down;
//   3. that very order is placed on the cross;
//   4. the route is read again: the clearing it now reports must equal the price predicted in step 2, and the cross is then settled on chain: the price
//      cleared on chain must equal it too.
//
// The cross stays Live for CLOSE_SECS (default 900) so its page can be looked at before it settles. The creator wallet is throwaway; what is left is swept back.
//
//   pnpm --filter @opening-cross/api exec tsx ../../packages/router/scripts/cross-depth-proof.ts
import Fastify from 'fastify';
import { createKeyPairSignerFromBytes, fetchEncodedAccount, generateKeyPairSigner, type KeyPairSigner } from '@solana/kit';
import { getCreateAssociatedTokenIdempotentInstruction, getMintToInstruction, TOKEN_2022_PROGRAM_ADDRESS, AuthorityType, getSetAuthorityInstruction } from '@solana-program/token-2022';
import { getTransferSolInstruction } from '@solana-program/system';
import { Keypair } from '@solana/web3.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { CrossKind, OrderSide, SupplyMode, Disclosure, CrossState, buildCreateCross, buildPlaceOrder, buildSettleBook, crossAddress, getInitProtocolInstruction, protocolAddress } from '@opening-cross/sdk';
import { referenceClear, type RefOrder } from '@opening-cross/verifier';
import { ROOT, rpc } from '../../../tests/devnet/src/lib.js';
import { ata, chainTime, crossView, newMint, operatorSigner, promiserSigner, send, waitUntil } from '../../../tests/devnet/src/adapter-lib.js';
import { RequestError } from '../../../services/api/src/tx.js';
import { registerPools } from '../../../services/api/src/routes/pools.js';

const GRID = { min: 1_000_000n, tick: 100_000n, ticks: 20 };
const SCALE = 1_000_000n;
const CLOSE_SECS = BigInt(process.env.CLOSE_SECS ?? 900);
const log: Record<string, unknown>[] = [];
const note = (r: Record<string, unknown>) => {
  log.push(r);
  console.error(JSON.stringify(r, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
};

async function main() {
  const promiser = await promiserSigner();
  const operator = await operatorSigner();
  const key = Keypair.generate();
  mkdirSync(`${ROOT}.keys/adapter-creators`, { recursive: true });
  writeFileSync(`${ROOT}.keys/adapter-creators/${key.publicKey.toBase58()}.json`, JSON.stringify([...key.secretKey]));
  const creator = await createKeyPairSignerFromBytes(key.secretKey);
  const bidder = await generateKeyPairSigner();
  const trader = await generateKeyPairSigner();
  await send([getTransferSolInstruction({ source: promiser, destination: creator.address, amount: 150_000_000n })], promiser);

  const protocol = await protocolAddress();
  if (!(await fetchEncodedAccount(rpc, protocol)).exists) await send([getInitProtocolInstruction({ admin: operator, protocol, guardian: operator.address, feeRecipient: operator.address, feeBps: [30, 5, 15, 30] })], operator);

  const quoteMint = await newMint(creator, creator.address);
  await send([getCreateAssociatedTokenIdempotentInstruction({ payer: creator, ata: await ata(creator.address, quoteMint), owner: creator.address, mint: quoteMint, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS }), getMintToInstruction({ mint: quoteMint, token: await ata(creator.address, quoteMint), mintAuthority: creator, amount: 20_000_000_000n }, { programAddress: TOKEN_2022_PROGRAM_ADDRESS })], creator);
  const crossId = BigInt(Date.now());
  const cross = await crossAddress(creator.address, crossId);
  const baseMint = await newMint(creator, creator.address);
  await send(
    [
      getSetAuthorityInstruction({ owned: baseMint, owner: creator, authorityType: AuthorityType.MintTokens, newAuthority: cross }, { programAddress: TOKEN_2022_PROGRAM_ADDRESS }),
      getCreateAssociatedTokenIdempotentInstruction({ payer: creator, ata: await ata(creator.address, baseMint), owner: creator.address, mint: baseMint, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS }),
    ],
    creator,
  );
  const schedule = [
    { price: 1_000_000n, quantity: 1_500_000_000n },
    { price: 1_300_000n, quantity: 1_500_000_000n },
  ];
  const now = await chainTime();
  const closeTs = now + CLOSE_SECS;
  const built = await buildCreateCross({
    creator, baseMint, quoteMint, baseTokenProgram: TOKEN_2022_PROGRAM_ADDRESS, quoteTokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
    crossId, kind: CrossKind.Launch, supplyMode: SupplyMode.Mint, disclosure: Disclosure.Open,
    minPrice: GRID.min, tick: GRID.tick, ticks: GRID.ticks, priceScale: SCALE, openTs: now - 5n, closeTs, revealEndTs: closeTs,
    referencePrice: null, minMatched: 0n, maxImbalanceBps: null, integratorFeeBps: 20, integrator: creator.address, gateMint: null,
    shards: 2, maxOrders: 16, proceedsTo: creator.address, schedule, settler: null, settleDeadlineTs: 0n, oracle: null, calendar: null,
  });
  const createSig = await send([built.create], creator);
  for (const s of built.shards) await send([s], creator);
  const view0 = await crossView(cross);
  note({ step: 'cross created', cross, baseMint, quoteMint, closeTs, createSig, state: view0.data.state });

  const setup = [];
  for (const who of new Set([creator.address, bidder.address, trader.address, view0.data.feeRecipient, view0.data.integrator, view0.data.proceedsTo])) {
    setup.push(getCreateAssociatedTokenIdempotentInstruction({ payer: creator, ata: await ata(who, quoteMint), owner: who, mint: quoteMint, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS }));
  }
  for (const w of [bidder, trader]) setup.push(getTransferSolInstruction({ source: creator, destination: w.address, amount: 12_000_000n }));
  for (const w of [bidder, trader]) setup.push(getMintToInstruction({ mint: quoteMint, token: await ata(w.address, quoteMint), mintAuthority: creator, amount: 20_000_000_000n }, { programAddress: TOKEN_2022_PROGRAM_ADDRESS }));
  await send(setup, creator);

  const refOrders: RefOrder[] = schedule.map((s) => ({ side: 'sell', price: s.price, quantity: s.quantity }));
  const bids: [KeyPairSigner, bigint, bigint, bigint][] = [
    [creator, 0n, 1_600_000n, 1_000_000_000n],
    [bidder, 0n, 1_300_000n, 1_800_000_000n],
  ];
  for (const [w, nonce, price, quantity] of bids) {
    await send([await buildPlaceOrder({ cross: await crossView(cross), owner: w, nonce, side: OrderSide.Buy, price, quantity })], w);
    refOrders.push({ side: 'buy', price, quantity });
  }

  // The route, in process, against the live chain.
  const app = Fastify();
  app.setErrorHandler((err, _req, reply) => (err instanceof RequestError ? reply.code(err.status).send({ error: err.message, ...err.detail }) : reply.code(500).send({ error: String(err) })));
  registerPools(app, {
    account: async (a) => {
      const r = await rpc.getAccountInfo(a, { encoding: 'base64', commitment: 'confirmed' }).send();
      return r.value ? { data: new Uint8Array(Buffer.from(r.value.data[0], 'base64')), owner: r.value.owner } : null;
    },
    lifetime: async () => (await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send()).value,
    network: 'devnet',
  });
  await app.ready();
  const depth = async (sizes?: string) => {
    const r = await app.inject({ method: 'GET', url: `/v1/depth/cross/${cross}${sizes ? `?sizes=${sizes}` : ''}` });
    return { status: r.statusCode, body: JSON.parse(r.body) as Record<string, any> };
  };

  const S = 400_000_000n; // a market buy of 400 tokens
  const before = await depth(`${S}`);
  const ref0 = referenceClear(refOrders, GRID, null)!;
  const predictedBuy = before.body.impact.find((r: { side: string }) => r.side === 'buy');
  const withBuy = referenceClear([...refOrders, { side: 'buy', price: GRID.min + BigInt(GRID.ticks - 1) * GRID.tick, quantity: S }], GRID, null)!;
  note({
    step: 'depth read before the extra order',
    status: before.status,
    baseline: before.body.baseline,
    referenceClearing: { price: ref0.price, matched: ref0.matched },
    baselineEqualsReference: before.body.baseline.price === ref0.price.toString() && before.body.baseline.matched === ref0.matched.toString(),
    levels: before.body.levels,
    predictedBuy,
    referenceWithBuy: { price: withBuy.price, matched: withBuy.matched },
    predictionEqualsReference: predictedBuy.price === withBuy.price.toString(),
  });

  // Place exactly the order that was predicted, then read the cross again and settle it.
  const topPrice = GRID.min + BigInt(GRID.ticks - 1) * GRID.tick;
  const placeSig = await send([await buildPlaceOrder({ cross: await crossView(cross), owner: trader, nonce: 0n, side: OrderSide.Buy, price: topPrice, quantity: S })], trader);
  const after = await depth();
  note({ step: 'depth read after the predicted order was placed', placeSig, baseline: after.body.baseline, predictedPrice: predictedBuy.price, equalsPrediction: after.body.baseline.price === predictedBuy.price, totals: after.body.totals });

  // A second prediction, for an order large enough to move the price: demand beyond what the issuer offers pushes the clearing price up the grid.
  const BIG = 2_500_000_000n;
  const bigNow = await depth(`${BIG}`);
  const bigPredicted = bigNow.body.impact.find((r: { side: string }) => r.side === 'buy');
  const orders2: RefOrder[] = [...refOrders, { side: 'buy', price: topPrice, quantity: S }];
  const refBig = referenceClear([...orders2, { side: 'buy', price: topPrice, quantity: BIG }], GRID, null)!;
  const refBase = referenceClear(orders2, GRID, null)!;
  note({ step: 'second prediction (an order that moves the price)', size: BIG, baselineNow: bigNow.body.baseline, referenceBaseline: { price: refBase.price, matched: refBase.matched }, predicted: bigPredicted, referenceWithOrder: { price: refBig.price, matched: refBig.matched }, predictionEqualsReference: bigPredicted.price === refBig.price.toString(), priceMovesBps: bigPredicted.impactBps });
  const placeBigSig = await send([await buildPlaceOrder({ cross: await crossView(cross), owner: trader, nonce: 1n, side: OrderSide.Buy, price: topPrice, quantity: BIG })], trader);
  const afterBig = await depth();
  note({ step: 'depth read after the second predicted order was placed', placeBigSig, baseline: afterBig.body.baseline, predictedPrice: bigPredicted.price, equalsPrediction: afterBig.body.baseline.price === bigPredicted.price, totals: afterBig.body.totals });

  note({ step: 'cross stays live', cross, closesAt: closeTs.toString(), page: `/pools/depth/${cross}` });
  await waitUntil(closeTs + 1n);
  let settleSig = '';
  for (const ix of await buildSettleBook(await crossView(cross))) settleSig = await send([ix], creator);
  const settled = await crossView(cross);
  const s = settled.data.clearing.__option === 'Some' ? settled.data.clearing.value : null;
  note({ step: 'settled on chain', settleSig, state: settled.data.state, price: s?.price, matched: s?.matched, equalsPrediction: s?.price?.toString() === afterBig.body.baseline.price && s?.matched?.toString() === afterBig.body.baseline.matched && settled.data.state === CrossState.Cleared });
  const leftover = await rpc.getBalance(creator.address, { commitment: 'confirmed' }).send();
  if (leftover.value > 10_000n) await send([getTransferSolInstruction({ source: creator, destination: promiser.address, amount: leftover.value - 5_000n })], creator);
  await app.close();
  console.log(JSON.stringify(log, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 1));
}

main().catch((e) => {
  console.error(e);
  console.log(JSON.stringify(log, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 1));
  process.exit(1);
});
