// Shared setup for the settlement-adapter devnet proofs (ROADMAP A2, A3, A4): a fresh creator funded from the
// promiser key, a real mint-mode launch cross cleared on the deployed cross_core, and the helpers the proofs use to
// send transactions and read chain state. Nothing here touches the program binaries.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import {
  type Address,
  type Instruction,
  type KeyPairSigner,
  appendTransactionMessageInstructions,
  createKeyPairSignerFromBytes,
  createTransactionMessage,
  fetchEncodedAccount,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  pipe,
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
  getMintSize,
  getMintToInstruction,
  getSetAuthorityInstruction,
  getTokenDecoder,
  getTransferCheckedInstruction,
} from '@solana-program/token-2022';
import { ComputeBudgetProgram, Keypair } from '@solana/web3.js';
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
  buildSettleBook,
  costCeil,
  crossAddress,
  getCrossDecoder,
  getInitProtocolInstruction,
  protocolAddress,
} from '@opening-cross/sdk';
import { referenceClear, type RefOrder } from '@opening-cross/verifier';
import { type Evidence, ROOT, rpc } from './lib.js';

export { CROSS_CORE_PROGRAM_ADDRESS, TOKEN_2022_PROGRAM_ADDRESS };
export const SCALE = 1_000_000n;
const GRID = { min: 1_000_000n, tick: 100_000n, ticks: 20 };

/** The public devnet endpoint is shared with other runs and answers bursts with HTTP 429: back off and retry only that. */
export async function retry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const text = describeError(e);
      if (attempt >= 10 || !/429|Too Many Requests|fetch failed|Timeout|ECONNRESET|socket hang up/i.test(text)) throw e;
      await new Promise((r) => setTimeout(r, 750 * 2 ** Math.min(attempt, 5)));
    }
  }
}

export async function send(ixs: Instruction[], payer: KeyPairSigner): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    // A load-balanced devnet node sometimes has not seen the blockhash another node just gave: sign again with a fresh one.
    const { value: blockhash } = await retry(() => rpc.getLatestBlockhash({ commitment: 'confirmed' }).send());
    const msg = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(payer, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
      (m) => appendTransactionMessageInstructions(ixs, m),
    );
    const tx = await signTransactionMessageWithSigners(msg);
    const signature = getSignatureFromTransaction(tx);
    try {
      // Public devnet WebSockets drop connections; send over HTTP and poll the status instead.
      await retry(() => rpc.sendTransaction(getBase64EncodedWireTransaction(tx), { encoding: 'base64', preflightCommitment: 'confirmed' }).send());
    } catch (e) {
      if (attempt < 6 && /Blockhash not found/i.test(describeError(e))) {
        await new Promise((r) => setTimeout(r, 1_500));
        continue;
      }
      throw e;
    }
    for (let i = 0; i < 90; i++) {
      const { value } = await retry(() => rpc.getSignatureStatuses([signature]).send());
      const st = value[0];
      if (st?.err) throw new Error(`transaction ${signature} failed: ${JSON.stringify(st.err)}`);
      if (st && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) return signature;
      await new Promise((r) => setTimeout(r, 1_000));
    }
    throw new Error(`transaction ${signature} not confirmed within 90 s`);
  }
}

/** Sends a transaction that must be rejected and returns the program logs naming the reason. */
export async function sendExpectingFailure(ixs: Instruction[], payer: KeyPairSigner, mustContain: string): Promise<string> {
  const { value: blockhash } = await retry(() => rpc.getLatestBlockhash({ commitment: 'confirmed' }).send());
  const msg = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(payer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions(ixs, m),
  );
  const tx = await signTransactionMessageWithSigners(msg);
  try {
    await retry(() => rpc.sendTransaction(getBase64EncodedWireTransaction(tx), { encoding: 'base64', preflightCommitment: 'confirmed' }).send());
  } catch (e) {
    const text = describeError(e);
    if (!text.includes(mustContain)) throw new Error(`rejected for the wrong reason (wanted "${mustContain}"): ${text.slice(0, 1500)}`);
    return mustContain;
  }
  throw new Error(`expected "${mustContain}" but the transaction was accepted`);
}

function describeError(e: unknown): string {
  const parts: string[] = [];
  for (let cur: unknown = e, depth = 0; cur && depth < 6; depth++) {
    const o = cur as { message?: string; context?: unknown; cause?: unknown };
    parts.push(String(o.message ?? cur));
    if (o.context) parts.push(JSON.stringify(o.context, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
    cur = o.cause;
  }
  return parts.join(" | ");
}

/** Sends a transaction that must be rejected and returns the program log lines plus the error text, whatever they say. */
export async function sendCapturingFailure(ixs: Instruction[], payer: KeyPairSigner): Promise<string> {
  const { value: blockhash } = await retry(() => rpc.getLatestBlockhash({ commitment: 'confirmed' }).send());
  const msg = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(payer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions(ixs, m),
  );
  const tx = await signTransactionMessageWithSigners(msg);
  try {
    await retry(() => rpc.sendTransaction(getBase64EncodedWireTransaction(tx), { encoding: 'base64', preflightCommitment: 'confirmed' }).send());
  } catch (e) {
    return describeError(e);
  }
  throw new Error('expected the transaction to be rejected, but it was accepted');
}

export const computeLimit = (units: number): Instruction => {
  const ix = ComputeBudgetProgram.setComputeUnitLimit({ units });
  return { programAddress: ix.programId.toBase58() as Address, data: new Uint8Array(ix.data) } as Instruction;
};

export async function chainTime(): Promise<bigint> {
  const slot = await retry(() => rpc.getSlot({ commitment: 'confirmed' }).send());
  return BigInt((await retry(() => rpc.getBlockTime(slot).send())) ?? Math.floor(Date.now() / 1000));
}
export async function waitUntil(ts: bigint): Promise<void> {
  while ((await chainTime()) < ts) await new Promise((r) => setTimeout(r, 2_000));
}
export async function account(address: Address) {
  const a = await retry(() => fetchEncodedAccount(rpc, address, { commitment: 'confirmed' }));
  if (!a.exists) throw new Error(`missing account ${address}`);
  return a;
}
export const crossView = async (address: Address) => ({ address, data: getCrossDecoder().decode((await account(address)).data) });
export async function ata(owner: Address, mint: Address): Promise<Address> {
  return (await findAssociatedTokenPda({ owner, mint, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS }))[0];
}
export async function balanceOf(owner: Address, mint: Address): Promise<bigint> {
  const mintAta = await ata(owner, mint);
  const a = await retry(() => fetchEncodedAccount(rpc, mintAta, { commitment: 'confirmed' }));
  return a.exists ? getTokenDecoder().decode(a.data).amount : 0n;
}
export async function lamports(address: Address): Promise<bigint> {
  return (await retry(() => rpc.getBalance(address, { commitment: 'confirmed' }).send())).value;
}

/** The devnet promiser key funds the fresh creator; the cap per run is 2 SOL. */
export async function promiserSigner(): Promise<KeyPairSigner> {
  return createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(readFileSync(`${ROOT}.keys/devnet-promiser.json`, 'utf8'))));
}
export async function operatorSigner(): Promise<KeyPairSigner> {
  return createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(readFileSync(`${ROOT}.keys/opening-bell-devnet.json`, 'utf8'))));
}

export async function newMint(payer: KeyPairSigner, authority: Address): Promise<Address> {
  const mint = await generateKeyPairSigner();
  const space = getMintSize();
  const rent = await retry(() => rpc.getMinimumBalanceForRentExemption(BigInt(space)).send());
  await send(
    [
      getCreateAccountInstruction({ payer, newAccount: mint, lamports: rent, space, programAddress: TOKEN_2022_PROGRAM_ADDRESS }),
      getInitializeMint2Instruction({ mint: mint.address, decimals: 6, mintAuthority: authority, freezeAuthority: null }),
    ],
    payer,
  );
  return mint.address;
}

export type ClearedCross = {
  creator: KeyPairSigner;
  trader: KeyPairSigner;
  baseMint: Address;
  quoteMint: Address;
  cross: Address;
  pStar: bigint;
  matched: bigint;
  creatorBase: bigint;
  startLamports: bigint;
};

/**
 * Fresh creator (≤ 2 SOL from the promiser), a mint-mode launch cross on the deployed cross_core with an open book
 * (the issuer offers 1,500 tokens at 1.00 and 1,500 at 1.30; the creator bids 1,000 at 1.60 and a second bidder
 * 1,800 at 1.30), settled and finalised. Every figure is compared with the independent reference clearing.
 */
export async function clearLaunchCross(ev: Evidence, fundLamports = BigInt(process.env.FUND_LAMPORTS ?? 150_000_000)): Promise<ClearedCross> {
  const promiser = await promiserSigner();
  const operator = await operatorSigner();
  // The creator's secret is kept in the git-ignored key folder: leftover SOL is swept back to the promiser at the
  // end of a run, and is recoverable from the file if a run dies first.
  const creatorKey = Keypair.generate();
  mkdirSync(`${ROOT}.keys/adapter-creators`, { recursive: true });
  writeFileSync(`${ROOT}.keys/adapter-creators/${creatorKey.publicKey.toBase58()}.json`, JSON.stringify([...creatorKey.secretKey]));
  const creator = await createKeyPairSignerFromBytes(creatorKey.secretKey);
  const bidder = await generateKeyPairSigner();
  const trader = await generateKeyPairSigner();
  const startLamports = fundLamports;
  const fundSig = await send([getTransferSolInstruction({ source: promiser, destination: creator.address, amount: fundLamports })], promiser);
  ev.check('fund', `fresh creator ${creator.address} funded ${Number(fundLamports) / 1e9} SOL from the promiser key`, true, `bidder ${bidder.address}, trader ${trader.address}`, fundSig);

  const protocol = await protocolAddress();
  if (!(await retry(() => fetchEncodedAccount(rpc, protocol))).exists) {
    const sig = await send([getInitProtocolInstruction({ admin: operator, protocol, guardian: operator.address, feeRecipient: operator.address, feeBps: [30, 5, 15, 30] })], operator);
    ev.check('protocol', 'protocol singleton initialised', true, `protocol ${protocol}`, sig);
  }

  const quoteMint = await newMint(creator, creator.address);
  await send([getCreateAssociatedTokenIdempotentInstruction({ payer: creator, ata: await ata(creator.address, quoteMint), owner: creator.address, mint: quoteMint, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS }), getMintToInstruction({ mint: quoteMint, token: await ata(creator.address, quoteMint), mintAuthority: creator, amount: 10_000_000_000n }, { programAddress: TOKEN_2022_PROGRAM_ADDRESS })], creator);
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
  const closeTs = now + 120n;
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
  ev.check('cross-create', 'mint-mode launch cross created on the deployed cross_core; the cross PDA holds the base mint authority', view0.data.baseBound, `cross ${cross}, base ${baseMint}, quote ${quoteMint}`, createSig);

  // Quote tokens for the two bidders and ATAs for everyone finalize pays.
  const setup: Instruction[] = [];
  for (const who of new Set([creator.address, bidder.address, trader.address, view0.data.feeRecipient, view0.data.integrator, view0.data.proceedsTo])) {
    setup.push(getCreateAssociatedTokenIdempotentInstruction({ payer: creator, ata: await ata(who, quoteMint), owner: who, mint: quoteMint, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS }));
  }
  setup.push(getTransferSolInstruction({ source: creator, destination: bidder.address, amount: 12_000_000n }));
  setup.push(getTransferSolInstruction({ source: creator, destination: trader.address, amount: 12_000_000n }));
  setup.push(getMintToInstruction({ mint: quoteMint, token: await ata(bidder.address, quoteMint), mintAuthority: creator, amount: 10_000_000_000n }, { programAddress: TOKEN_2022_PROGRAM_ADDRESS }));
  await send(setup, creator);

  const bids: [KeyPairSigner, bigint, bigint, bigint][] = [
    [creator, 0n, 1_600_000n, 1_000_000_000n],
    [bidder, 1n, 1_300_000n, 1_800_000_000n],
  ];
  const refOrders: RefOrder[] = schedule.map((s) => ({ side: 'sell', price: s.price, quantity: s.quantity }));
  for (const [w, nonce, price, quantity] of bids) {
    const sig = await send([await buildPlaceOrder({ cross: await crossView(cross), owner: w, nonce, side: OrderSide.Buy, price, quantity })], w);
    refOrders.push({ side: 'buy', price, quantity });
    ev.check(`bid-${nonce}`, `bid ${Number(quantity) / 1e6} tokens at ${Number(price) / 1e6} escrowed`, true, `bidder ${w.address}`, sig);
  }
  await waitUntil(closeTs + 1n);
  let lastSig = '';
  for (const ix of await buildSettleBook(await crossView(cross))) lastSig = await send([ix], creator);
  const cleared = await crossView(cross);
  const ref = referenceClear(refOrders, GRID, null)!;
  const s = cleared.data.clearing.__option === 'Some' ? cleared.data.clearing.value : null;
  ev.check('clear', 'on-chain clearing price and volume equal the independent reference', cleared.data.state === CrossState.Cleared && s?.price === ref.price && s?.matched === ref.matched, `P* ${s?.price} (reference ${ref.price}), matched ${s?.matched} (reference ${ref.matched})`, lastSig);
  if (!s) throw new Error('cross did not clear');

  for (const [w, nonce, price, quantity] of bids) {
    const before = await balanceOf(w.address, quoteMint);
    const sig = await send(await buildClaim(await crossView(cross), creator, w.address, nonce), creator);
    const got = await balanceOf(w.address, baseMint);
    const refund = (await balanceOf(w.address, quoteMint)) - before;
    ev.check(`claim-${nonce}`, 'claim minted the fill at P* and refunded the escrow above it', got > 0n && refund === costCeil(quantity, price, SCALE) - costCeil(got, s.price, SCALE), `fill ${got}, refund ${refund}`, sig);
  }
  const finSig = await send([await buildFinalize(await crossView(cross), creator)], creator);
  const fin = await crossView(cross);
  ev.check('finalize', 'cross finalised on chain', fin.data.state === CrossState.Finalized, `state ${fin.data.state}`, finSig);
  return { creator, trader, baseMint, quoteMint, cross, pStar: s.price, matched: s.matched, creatorBase: await balanceOf(creator.address, baseMint), startLamports };
}

/** Gives the trader some of the creator's base tokens so a swap is made by a different wallet from the pool's creator. */
export async function fundTrader(c: ClearedCross, baseAmount: bigint): Promise<void> {
  await send(
    [
      getCreateAssociatedTokenIdempotentInstruction({ payer: c.creator, ata: await ata(c.trader.address, c.baseMint), owner: c.trader.address, mint: c.baseMint, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS }),
      getCreateAssociatedTokenIdempotentInstruction({ payer: c.creator, ata: await ata(c.trader.address, c.quoteMint), owner: c.trader.address, mint: c.quoteMint, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS }),
      getTransferCheckedInstruction({ source: await ata(c.creator.address, c.baseMint), mint: c.baseMint, destination: await ata(c.trader.address, c.baseMint), authority: c.creator, amount: baseAmount, decimals: 6 }, { programAddress: TOKEN_2022_PROGRAM_ADDRESS }),
    ],
    c.creator,
  );
}

/** Returns what is left of the creator's SOL to the promiser, so a run costs only what it spent. */
export async function sweep(c: ClearedCross): Promise<bigint> {
  const promiser = await promiserSigner();
  const left = await lamports(c.creator.address);
  const amount = left - 5_000n;
  if (amount <= 0n) return 0n;
  await send([getTransferSolInstruction({ source: c.creator, destination: promiser.address, amount })], c.creator);
  return amount;
}
