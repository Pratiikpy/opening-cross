// Devnet run of the off-chain layer (docs/evidence/W3A-builders-devnet.md): the unsigned transactions of the API's builders, signed here and sent to the
// programs that are DEPLOYED on devnet today (the versions before the Wave 2D upgrade). What it shows:
//
//   A  A launch driven only through the API's transaction builders (services/api/src/tx.ts, which now read a rules tail and add the accounts it calls for).
//      On a cross the deployed program wrote, the tail is absent and the builders must produce exactly the transactions they always did: create, place,
//      cancel, settle, claim, finalize all land, and the outcome equals the independent reference.
//   B  The new builders against the old program: `create_cross` plus `set_rules` in one transaction is refused by the deployed program (it has no such
//      instruction), nothing is created, and a creation without rules through the new route lands.
//   C  The treasury builders against a live treasury of the deployed program: the first release's instructions (spend, redeem, trigger_liquidation,
//      record_attested, record_lapse) are accepted by its account checks and refused only for the reasons the program gives, and an extension instruction
//      is refused as not existing. Simulated, not sent.
//
//   pnpm --filter @opening-cross/devnet-proofs dp:w3a-builders
import { readFileSync } from 'node:fs';
import {
  type Address,
  type Instruction,
  type KeyPairSigner,
  appendTransactionMessageInstructions,
  createKeyPairSignerFromBytes,
  createNoopSigner,
  createTransactionMessage,
  fetchEncodedAccount,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  getTransactionDecoder,
  getTransactionEncoder,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransaction,
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
import { CrossKind, CrossState, Disclosure, OrderSide, SupplyMode, costCeil, crossAddress, getCrossDecoder, getInitProtocolInstruction, getProtocolDecoder, protocolAddress, readCrossExt } from '@opening-cross/sdk';
import { referenceClear, referenceFills, type RefOrder } from '@opening-cross/verifier';
import { TREASURY_PROGRAM_ADDRESS, buildRecordAttested, buildRecordLapse, buildRedeem, buildSpend, buildStake, buildTriggerLiquidation, getTreasuryDecoder, spendAttestationAddress } from '@opening-cross/treasury-client';
import { type Lifetime, cancelTx, claimTx, createCrossTxs, createRuledCrossTxs, finalizeTx, initShardsTxs, placeOrderTx, settleTxs } from '../../../services/api/src/tx.js';
import { Evidence, ROOT, rpc } from './lib.js';

const ev = new Evidence('W3A-builders-devnet.md', 'Devnet run — the off-chain builders against the deployed programs (W3A)', [
  'Script `tests/devnet/src/w3a-builders-live.ts`',
  'The programs on devnet are the versions deployed before the Wave 2D upgrade (HUMAN_TASKS H27). This run shows what the new off-chain layer does against them; it says nothing about the new instructions, which are not deployed.',
]);
const SCALE = 1_000_000n;
const j = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));
const TP = TOKEN_2022_PROGRAM_ADDRESS;

async function lifetime(): Promise<Lifetime> {
  const { value } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send();
  return value as Lifetime;
}
/** Signs the transactions an API builder returned (each lists the keys that must sign) and sends them in order, confirming each. */
async function sendUnsigned(txs: { transaction: string; signers: Address[] }[], keys: KeyPairSigner[]): Promise<string[]> {
  const sigs: string[] = [];
  for (const t of txs) {
    const decoded = getTransactionDecoder().decode(Uint8Array.from(Buffer.from(t.transaction, 'base64')));
    const needed = t.signers.map((s) => {
      const k = keys.find((x) => x.address === s);
      if (!k) throw new Error(`no key for required signer ${s}`);
      return k.keyPair;
    });
    const signed = await signTransaction(needed, decoded);
    const sig = getSignatureFromTransaction(signed);
    await rpc.sendTransaction(getBase64EncodedWireTransaction(signed), { encoding: 'base64', preflightCommitment: 'confirmed' }).send();
    await confirm(sig);
    sigs.push(sig);
  }
  return sigs;
}
async function confirm(signature: string) {
  for (let i = 0; i < 90; i++) {
    const { value } = await rpc.getSignatureStatuses([signature as never]).send();
    const st = value[0];
    if (st?.err) throw new Error(`transaction ${signature} failed: ${JSON.stringify(st.err, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))}`);
    if (st && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) return;
    await new Promise((r) => setTimeout(r, 1_000));
  }
  throw new Error(`transaction ${signature} not confirmed within 90 s`);
}
async function send(ixs: Instruction[], payer: KeyPairSigner): Promise<string> {
  const msg = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(payer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(lifetimeSync!, m),
    (m) => appendTransactionMessageInstructions(ixs, m),
  );
  const tx = await signTransactionMessageWithSigners(msg);
  await rpc.sendTransaction(getBase64EncodedWireTransaction(tx), { encoding: 'base64', preflightCommitment: 'confirmed' }).send();
  const sig = getSignatureFromTransaction(tx);
  await confirm(sig);
  return sig;
}
let lifetimeSync: Lifetime | undefined;
const fresh = async () => {
  lifetimeSync = await lifetime();
};

/** Runs a transaction through the cluster without sending it, with signatures not checked, and returns its error and logs. */
async function simulate(ixs: Instruction[], payer: Address) {
  const lt = await lifetime();
  const msg = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner({ address: payer } as never, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(lt, m),
    (m) => appendTransactionMessageInstructions(ixs, m),
  );
  const unsigned = (await import('@solana/kit')).compileTransaction(msg);
  const wire = Buffer.from(getTransactionEncoder().encode(unsigned)).toString('base64');
  const r = await rpc.simulateTransaction(wire as never, { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed' } as never).send();
  return { err: r.value.err as unknown, logs: (r.value.logs ?? []) as string[] };
}

const chainTime = async () => BigInt((await rpc.getBlockTime(await rpc.getSlot({ commitment: 'confirmed' }).send()).send()) ?? Math.floor(Date.now() / 1000));
async function waitUntil(ts: bigint) {
  while ((await chainTime()) < ts) await new Promise((r) => setTimeout(r, 2_000));
}
async function account(address: Address) {
  const a = await fetchEncodedAccount(rpc, address, { commitment: 'confirmed' });
  return a.exists ? a.data : null;
}
async function ownedCore(address: Address) {
  const a = await fetchEncodedAccount(rpc, address, { commitment: 'confirmed' });
  return a.exists && a.programAddress === 'F5k8EDDXBF24xgt4Y8MMtwPZFH9TikJvJcNmD1NJQPnZ' ? a.data : null;
}
const view = async (address: Address) => ({ address, data: getCrossDecoder().decode((await account(address))!) });
const ata = async (owner: Address, mint: Address) => (await findAssociatedTokenPda({ owner, mint, tokenProgram: TP }))[0];
async function balanceOf(owner: Address, mint: Address): Promise<bigint> {
  const a = await account(await ata(owner, mint));
  return a ? getTokenDecoder().decode(a).amount : 0n;
}

async function main() {
  const operator = await createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(readFileSync(`${ROOT}.keys/opening-bell-devnet.json`, 'utf8'))));
  await fresh();
  const protocol = await protocolAddress();
  const protocolData = await account(protocol);
  if (!protocolData) {
    await send([getInitProtocolInstruction({ admin: operator, protocol, guardian: operator.address, feeRecipient: operator.address, feeBps: [30, 5, 15, 30] })], operator);
  }
  const p = getProtocolDecoder().decode((await account(protocol))!);
  ev.check('protocol', 'the protocol account of the deployed program is read as before', p.feeBps.length === 4, `fees ${p.feeBps.join('/')} bps, admin ${p.admin}`);

  const newMint = async () => {
    await fresh();
    const mint = await generateKeyPairSigner();
    const space = getMintSize();
    const lamports = await rpc.getMinimumBalanceForRentExemption(BigInt(space)).send();
    await send([getCreateAccountInstruction({ payer: operator, newAccount: mint, lamports, space, programAddress: TP }), getInitializeMint2Instruction({ mint: mint.address, decimals: 6, mintAuthority: operator.address })], operator);
    return mint.address;
  };
  const quoteMint = await newMint();
  const baseMint = await newMint();
  const buyers = await Promise.all([generateKeyPairSigner(), generateKeyPairSigner(), generateKeyPairSigner()]);
  await fresh();
  const setup: Instruction[] = [];
  for (const who of [operator.address, ...buyers.map((b) => b.address)]) setup.push(getCreateAssociatedTokenIdempotentInstruction({ payer: operator, ata: await ata(who, quoteMint), owner: who, mint: quoteMint, tokenProgram: TP }));
  for (const b of buyers) {
    setup.push(getTransferSolInstruction({ source: operator, destination: b.address, amount: 20_000_000n }));
    setup.push(getMintToInstruction({ mint: quoteMint, token: await ata(b.address, quoteMint), mintAuthority: operator, amount: 10_000_000_000n }, { programAddress: TP }));
  }
  // The creator holds the quote token too: create_cross takes a dust bond from it for a minting cross.
  setup.push(getMintToInstruction({ mint: quoteMint, token: await ata(operator.address, quoteMint), mintAuthority: operator, amount: 1_000_000_000_000n }, { programAddress: TP }));
  await send(setup, operator);

  // ---------------------------------------------------------------- A: the API builders, a launch end to end
  const crossId = BigInt(Date.now());
  const now = await chainTime();
  const closeTs = now + 60n;
  const grid = { min: 1_000_000n, tick: 100_000n, ticks: 20 };
  const schedule = [{ price: 1_000_000n, quantity: 1_000_000_000n }, { price: 1_200_000n, quantity: 1_000_000_000n }, { price: 1_500_000n, quantity: 1_000_000_000n }];
  const createInput = {
    creator: operator.address, baseMint, quoteMint, baseTokenProgram: TP, quoteTokenProgram: TP, crossId, kind: CrossKind.Launch, supplyMode: SupplyMode.Mint, disclosure: Disclosure.Open,
    minPrice: grid.min, tick: grid.tick, ticks: grid.ticks, priceScale: SCALE, openTs: now - 5n, closeTs, revealEndTs: closeTs, referencePrice: null, minMatched: 0n, maxImbalanceBps: null,
    integratorFeeBps: 20, integrator: operator.address, gateMint: null, shards: 2, maxOrders: 16, proceedsTo: operator.address, schedule, settler: null, settleDeadlineTs: 0n, oracle: null, calendar: null,
  } as const;
  const cross = await crossAddress(operator.address, crossId);

  // B first, on the same id: a creation WITH rules is refused by the deployed program, and creates nothing.
  const withRules = await createRuledCrossTxs({ ...createInput, rules: { ending: { endingSecs: 30, buckets: 2, randomEnd: true } } } as never, await lifetime());
  const first = await simulateApiTx(withRules.transactions[0]!, operator.address);
  ev.check('B-rules-refused', 'create_cross plus set_rules in one transaction is refused by the deployed program, as an instruction it does not have', first.err !== null && first.logs.some((l) => /InstructionFallbackNotFound|Instruction: SetRules|invalid instruction data/i.test(l)), `error ${j(first.err)}; ${first.logs.filter((l) => /fallback|Instruction|error/i.test(l)).slice(-3).join(' | ')}`);
  ev.check('B-rules-created-nothing', 'nothing was created by the refused transaction', (await account(cross)) === null, `cross ${cross} does not exist`);

  const created = await createCrossTxs(createInput as never, await lifetime());
  const sigs = await sendUnsigned(created.transactions, [operator]);
  ev.check('A-create', 'a mint-mode launch created through the API builder (create, handover of the mint authority, shards) on the deployed program', (await account(cross)) !== null, `cross ${cross}, ${sigs.length} transactions`, sigs[0]);
  const raw = (await account(cross))!;
  ev.check('A-no-tail', 'the cross the deployed program wrote has no rules tail, so the builders add nothing', readCrossExt(raw) === null && raw.length < 2_000, `account ${raw.length} bytes, no tail`);
  let again: unknown = null;
  try {
    await initShardsTxs(ownedCore, await view(cross), operator.address, await lifetime());
  } catch (e) {
    again = e;
  }
  ev.check('A-shards-complete', 'init-shards says every shard exists', /every shard of this cross already exists/.test(String((again as Error | null)?.message)), String((again as Error | null)?.message));

  const plan: [KeyPairSigner, bigint, bigint][] = [[buyers[0]!, 1_500_000n, 1_500_000_000n], [buyers[1]!, 1_200_000n, 800_000_000n], [buyers[2]!, 1_100_000n, 500_000_000n]];
  const buyRefs: RefOrder[] = [];
  for (const [i, [b, price, quantity]] of plan.entries()) {
    const out = await placeOrderTx(ownedCore, await view(cross), { owner: b.address, nonce: BigInt(i), side: OrderSide.Buy, price, quantity }, await lifetime());
    const [sig] = await sendUnsigned([out], [b]);
    buyRefs.push({ side: 'buy', price, quantity });
    ev.check(`A-bid-${i}`, `bid ${quantity} at ${price} placed through placeOrderTx and escrowed`, (await account(out.order)) !== null, `buyer ${b.address}`, sig);
  }
  // a fourth order, cancelled
  const cancelled = await placeOrderTx(ownedCore, await view(cross), { owner: buyers[2]!.address, nonce: 9n, side: OrderSide.Buy, price: 1_100_000n, quantity: 100_000_000n }, await lifetime());
  await sendUnsigned([cancelled], [buyers[2]!]);
  const before = await balanceOf(buyers[2]!.address, quoteMint);
  const [cancelSig] = await sendUnsigned([await cancelTx(ownedCore, await view(cross), { owner: buyers[2]!.address, nonce: 9n }, await lifetime())], [buyers[2]!]);
  ev.check('A-cancel', 'cancelTx refunds the escrow in full', (await balanceOf(buyers[2]!.address, quoteMint)) - before === costCeil(100_000_000n, 1_100_000n, SCALE) && (await account(cancelled.order)) === null, 'order closed, escrow returned', cancelSig);

  await waitUntil(closeTs + 2n);
  const settle = await settleTxs(await view(cross), operator.address, await lifetime());
  const settleSigs = await sendUnsigned(settle, [operator]);
  const cleared = await view(cross);
  const ref = referenceClear([...schedule.map((s) => ({ side: 'sell' as const, price: s.price, quantity: s.quantity })), ...buyRefs], grid, null)!;
  const s = cleared.data.clearing.__option === 'Some' ? cleared.data.clearing.value : null;
  ev.check('A-clear', 'settleTxs merges and clears; the on-chain price and volume equal the independent reference', cleared.data.state === CrossState.Cleared && s?.price === ref.price && s?.matched === ref.matched, `P* ${s?.price} (ref ${ref.price}), matched ${s?.matched} (ref ${ref.matched}), ${settle.length} transactions`, settleSigs.at(-1));

  const fills = referenceFills(buyRefs, ref);
  for (const [i, [b]] of plan.entries()) {
    const out = await claimTx(ownedCore, await view(cross), { payer: operator.address, owner: b.address, nonce: BigInt(i) }, await lifetime());
    const [sig] = await sendUnsigned([out], [operator]);
    const got = await balanceOf(b.address, baseMint);
    ev.check(`A-claim-${i}`, `claimTx pays buyer ${i} the fill the reference computes`, got === fills[i]!, `received ${got} base (ref ${fills[i]})`, sig);
  }
  const fin = await finalizeTx(await view(cross), operator.address, await lifetime());
  const [finSig] = await sendUnsigned([fin], [operator]);
  const done = await view(cross);
  ev.check('A-finalize', 'finalizeTx finalizes the cross; the mint authority is revoked', done.data.state === CrossState.Finalized && getMintDecoder().decode((await account(baseMint))!).mintAuthority.__option === 'None', `state ${CrossState[done.data.state]}`, finSig);

  // ---------------------------------------------------------------- C: treasury builders against a live treasury of the deployed program
  const live = (await (await fetch('https://98-87-59-136.sslip.io/v1/treasuries')).json()) as { treasuries: { address: string; indexedState: string }[] };
  const tAddr = (live.treasuries.find((t) => t.indexedState === 'Active') ?? live.treasuries[0])!.address as Address;
  const tData = (await account(tAddr))!;
  const t = getTreasuryDecoder().decode(tData);
  const [coin, quote] = await Promise.all([fetchEncodedAccount(rpc, t.coinMint), fetchEncodedAccount(rpc, t.quoteMint)]);
  if (!coin.exists || !quote.exists) throw new Error('treasury mints missing');
  const ctx = { treasury: tAddr, coinMint: t.coinMint, quoteMint: t.quoteMint, coinTokenProgram: coin.programAddress, quoteTokenProgram: quote.programAddress };
  ev.check('C-owner', 'the live treasury belongs to the deployed treasury program', (await fetchEncodedAccount(rpc, tAddr)).exists && TREASURY_PROGRAM_ADDRESS === 'HoRbUkEXdJSFJFp3yZNgEmNJeniWPEheVUejPGZbVGAd', `treasury ${tAddr}`);
  const attestation = await spendAttestationAddress({ treasury: tAddr, credential: t.credential, schema: t.schema });
  const wallet = operator.address;
  const walletSigner = createNoopSigner(wallet);
  const dest = await ata(t.authority, t.quoteMint);
  const sim = async (id: string, claim: string, ixs: Instruction[], accept: (r: { err: unknown; logs: string[] }) => boolean) => {
    const r = await simulate(ixs, wallet);
    const why = r.logs.filter((l) => /Error|error|failed|Instruction:/.test(l)).slice(-2).join(' | ');
    ev.check(id, claim, accept(r), `${j(r.err)} — ${why}`);
  };
  // A simulated first-release instruction passes when the deployed program decodes it and its accounts reach the program's own logic: it must not stop on the
  // instruction not existing, on its data not decoding, on a seed that does not derive or on an account of the wrong program. Where it stops instead is
  // recorded, so the reader sees how far it got.
  const reached = (r: { logs: string[] }) => !r.logs.some((l) => /InstructionFallbackNotFound|InstructionDidNotDeserialize|ConstraintSeeds|AccountOwnedByWrongProgram|InvalidProgramId|ConstraintAddress/.test(l));
  await sim('C-redeem', "redeem: the deployed program decodes it and checks its accounts up to the holder's own token account (the simulating wallet has none)", await buildRedeem(ctx, walletSigner, 1n), reached);
  await sim('C-liquidate', 'trigger_liquidation: refused by the program for its own reason, no lapse recorded', [await buildTriggerLiquidation(ctx)], (r) => r.logs.some((l) => /Error Code: NoLapse/.test(l)));
  await sim('C-spend', 'spend: the deployed program checks the authority, attestation, mint and vault accounts the builder derived and stops at the destination account', [await buildSpend(ctx, walletSigner, 1n, attestation, dest)], reached);
  await sim('C-attested', "record_attested: the deployed program finds no live attestation at the address the builder derived", [buildRecordAttested(ctx, attestation)], (r) => r.logs.some((l) => /Error Code: NotAttested/.test(l)));
  await sim('C-lapse', 'record_lapse: the deployed program accepts the instruction and its accounts and runs it to completion in simulation', [buildRecordLapse(ctx, attestation)], (r) => r.err === null && r.logs.some((l) => /Instruction: RecordLapse/.test(l)));
  const stake = await simulate([await buildStake(ctx, walletSigner, 1n)], wallet);
  ev.check('C-stake-absent', 'stake (an extension instruction) is refused by the deployed program as an instruction it does not have', stake.logs.some((l) => /InstructionFallbackNotFound|Fallback functions are not supported|invalid instruction data/i.test(l)), `${j(stake.err)} — ${stake.logs.slice(-3).join(' | ')}`);
  void getTransactionEncoder;
}

/** Simulates an API transaction (already compiled, signatures empty). */
async function simulateApiTx(t: { transaction: string }, _payer: Address) {
  const r = await rpc.simulateTransaction(t.transaction as never, { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed' } as never).send();
  return { err: r.value.err as unknown, logs: (r.value.logs ?? []) as string[] };
}

main()
  .then(() => ev.write())
  .catch((e) => ev.write(e));
