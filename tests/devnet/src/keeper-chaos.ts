// Devnet keeper chaos (ROADMAP D2). Four real crosses on devnet — an open-book launch that prints, a sealed cross
// with one unrevealed bid, a no-print, and a deferred-mint launch whose settler never binds — are handed to two
// real keeper processes (services/keeper) that race over them: one discovers crosses through the indexer's
// Postgres, the other through getProgramAccounts. One keeper is SIGKILLed the moment the first cross settles and
// restarted later; a third party claims an order out from under both. Afterwards every cross must be Finalized,
// every order account closed, every owner paid or refunded to the atom, and the keepers must find nothing to do.
//
//   needs the stack from tests/devnet/run-stack.sh (indexer on DATABASE_URL), run in WSL:
//   DATABASE_URL=postgres://postgres:oc@localhost:55432/oc_devnet node --import tsx src/keeper-chaos.ts
import { appendFileSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { Keypair } from '@solana/web3.js';
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
  getMintDecoder,
  getMintSize,
  getMintToInstruction,
  getSetAuthorityInstruction,
  getTokenDecoder,
} from '@solana-program/token-2022';
import { NoPrintReason } from '@opening-cross/cross-core-client';
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
  costCeil,
  crossAddress,
  getCrossDecoder,
  getProtocolDecoder,
  orderAddress,
  protocolAddress,
  quoteVaultAddress,
} from '@opening-cross/sdk';
import { referenceClear, referenceFills, type RefOrder } from '@opening-cross/verifier';
import { Evidence, ROOT, RPC, rpc } from './lib.js';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error('DATABASE_URL (the indexer database) is required');
const EVIDENCE = 'D2-keeper-devnet.md';
const ev = new Evidence(EVIDENCE, 'D2 — Keepers racing on devnet (chaos)', [
  'Script `tests/devnet/src/keeper-chaos.ts`; stack from `tests/devnet/run-stack.sh`; keepers are the real `services/keeper` process',
  `Program: cross_core \`${CROSS_CORE_PROGRAM_ADDRESS}\``,
]);
const SCALE = 1_000_000n;
const CREATOR_QUOTE = 1_000_000_000n;
const TRADER_QUOTE = 10_000_000_000n;
const GRID = { min: 1_000_000n, tick: 100_000n, ticks: 20 };
const KEYS = `${ROOT}.keys/fork-d2`;
mkdirSync(KEYS, { recursive: true });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- plumbing
/** Lands a transaction on a lossy public cluster: the first send is preflighted so program errors surface at once, the
 *  signed bytes are re-sent every few seconds until the blockhash expires, then the whole transaction is rebuilt. */
async function send(ixs: Instruction[], payer: KeyPairSigner): Promise<string> {
  const started = Date.now();
  for (let attempt = 0; attempt < 6; attempt++) {
    const { value: blockhash } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send();
    const msg = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(payer, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
      (m) => appendTransactionMessageInstructions(ixs, m),
    );
    const tx = await signTransactionMessageWithSigners(msg);
    const signature = getSignatureFromTransaction(tx);
    const wire = getBase64EncodedWireTransaction(tx);
    let lastSent = 0;
    for (let first = true; ; first = false) {
      if (Date.now() - lastSent > 4_000) {
        try {
          await rpc.sendTransaction(wire, { encoding: 'base64', skipPreflight: !first || attempt > 0, preflightCommitment: 'confirmed' }).send();
        } catch (e) {
          // A load-balanced public node can lag behind the one that issued the blockhash: send again shortly.
          if (!String(e).includes('Blockhash not found') && !String((e as { cause?: unknown }).cause).includes('Blockhash not found')) throw e;
          await sleep(1_500);
          continue;
        }
        lastSent = Date.now();
      }
      const st = (await rpc.getSignatureStatuses([signature]).send()).value[0];
      if (st?.err) throw new Error(`transaction ${signature} failed: ${JSON.stringify(st.err)}`);
      if (st && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) {
        console.log(`  tx ${signature.slice(0, 8)} landed in ${Math.round((Date.now() - started) / 1000)} s${attempt ? ` (attempt ${attempt + 1})` : ''}`);
        return signature;
      }
      if ((await rpc.getBlockHeight({ commitment: 'confirmed' }).send()) > blockhash.lastValidBlockHeight) break;
      await sleep(2_000);
    }
    const last = (await rpc.getSignatureStatuses([signature], { searchTransactionHistory: true }).send()).value[0];
    if (last && !last.err && last.confirmationStatus) return signature;
  }
  throw new Error('transaction did not land after six blockhashes');
}
async function sendChunks(ixs: Instruction[], payer: KeyPairSigner, size: number): Promise<void> {
  const batches: Instruction[][] = [];
  for (let i = 0; i < ixs.length; i += size) batches.push(ixs.slice(i, i + size));
  await Promise.all(batches.map((b) => send(b, payer)));
}
async function chainTime(): Promise<bigint> {
  const slot = await rpc.getSlot({ commitment: 'confirmed' }).send();
  return BigInt((await rpc.getBlockTime(slot).send()) ?? Math.floor(Date.now() / 1000));
}
async function waitUntil(ts: bigint): Promise<void> {
  while ((await chainTime()) < ts) await sleep(2_000);
}
async function maybeAccount(address: Address) {
  const a = await fetchEncodedAccount(rpc, address, { commitment: 'confirmed' });
  return a.exists ? a : null;
}
const crossView = async (address: Address) => {
  const a = await maybeAccount(address);
  if (!a) throw new Error(`missing cross ${address}`);
  return { address, data: getCrossDecoder().decode(a.data) };
};
async function ata(owner: Address, mint: Address): Promise<Address> {
  return (await findAssociatedTokenPda({ owner, mint, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS }))[0];
}
async function balanceOf(owner: Address, mint: Address): Promise<bigint> {
  const a = await maybeAccount(await ata(owner, mint));
  return a ? getTokenDecoder().decode(a.data).amount : 0n;
}
async function loadSigner(name: string): Promise<KeyPairSigner> {
  const file = `${KEYS}/${name}.json`;
  if (!existsSync(file)) writeFileSync(file, JSON.stringify(Array.from(Keypair.generate().secretKey)));
  return createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(readFileSync(file, 'utf8'))));
}
async function newMint(payer: KeyPairSigner, authority: Address): Promise<Address> {
  const mint = await generateKeyPairSigner();
  const space = getMintSize();
  const lamports = await rpc.getMinimumBalanceForRentExemption(BigInt(space)).send();
  await send([getCreateAccountInstruction({ payer, newAccount: mint, lamports, space, programAddress: TOKEN_2022_PROGRAM_ADDRESS }), getInitializeMint2Instruction({ mint: mint.address, decimals: 6, mintAuthority: authority, freezeAuthority: null })], payer);
  return mint.address;
}

// ---------------------------------------------------------------- keeper processes
const KEEPERS = ['A', 'B', 'C'] as const;
type KeeperName = (typeof KEEPERS)[number];
const keeperLogs: Record<string, string> = { A: '/tmp/dn-keeperA.log', B: '/tmp/dn-keeperB.log', C: '/tmp/dn-keeperC.log' };
const children: Record<string, ChildProcess | undefined> = {};
let creatorScope = '';
function startKeeper(name: KeeperName): void {
  const fd = openSync(keeperLogs[name]!, 'a');
  children[name] = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
    cwd: `${ROOT}services/keeper`,
    env: {
      ...process.env,
      RPC_URL: RPC,
      KEEPER_KEYPAIR: `${KEYS}/keeper${name}.json`,
      PASS_MS: '6000',
      KEEPER_CREATORS: creatorScope,
      // Keeper A discovers through the indexer; B and C through a getProgramAccounts scan.
      ...(name === 'A' ? { DATABASE_URL } : { DATABASE_URL: '' }),
    },
    stdio: ['ignore', fd, fd],
  });
  children[name]!.on('exit', (code, signal) => appendFileSync(keeperLogs[name]!, JSON.stringify({ at: new Date().toISOString(), exit: { code, signal } }) + '\n'));
}
type LogEntry = { at: string; done?: { action: { kind: string; cross: string; order?: { owner: string; nonce: string } }; signature: string }[]; failed?: { action: { kind: string; cross: string; order?: { owner: string } }; error: string }[]; error?: string; exit?: unknown };
function readLog(name: string): LogEntry[] {
  if (!existsSync(keeperLogs[name]!)) return [];
  return readFileSync(keeperLogs[name]!, 'utf8').split('\n').filter((l) => l.startsWith('{')).flatMap((l) => { try { return [JSON.parse(l) as LogEntry]; } catch { return []; } });
}
const doneCount = (name: string) => readLog(name).reduce((n, e) => n + (e.done?.length ?? 0), 0);

// ---------------------------------------------------------------- the run
async function main() {
  for (const f of Object.values(keeperLogs)) writeFileSync(f, '');
  const funder = await createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(readFileSync(`${ROOT}.keys/devnet-promiser.json`, 'utf8'))));
  const creator = await loadSigner(`creator-${process.env.RUN ?? new Date().toISOString().slice(0, 16).replace(/[^0-9]/g, '')}`); // a fresh creator per run: no leftovers from earlier attempts
  const keeperA = await loadSigner('keeperA');
  const keeperB = await loadSigner('keeperB');
  const keeperC = await loadSigner('keeperC');
  const traders = await Promise.all(Array.from({ length: 9 }, (_, i) => loadSigner(`t${i}`)));
  const settler = await loadSigner('settler');
  creatorScope = creator.address; // the keepers serve this run's crosses only, never another job's
  const names = new Map<string, string>([[creator.address, 'creator'], [keeperA.address, 'keeperA'], [keeperB.address, 'keeperB'], [keeperC.address, 'keeperC'], ...traders.map((t, i) => [t.address, `t${i}`] as [string, string])]);

  // Fund: top each key up to its target from the funder (a throwaway devnet key).
  const targets: [KeyPairSigner, bigint][] = [[creator, 400_000_000n], [keeperA, 30_000_000n], [keeperB, 30_000_000n], [keeperC, 30_000_000n], ...traders.map((t) => [t, 10_000_000n] as [KeyPairSigner, bigint])];
  const needs: [Address, bigint][] = [];
  for (const [who, target] of targets) {
    const have = (await rpc.getBalance(who.address, { commitment: 'confirmed' }).send()).value;
    if (have < target) needs.push([who.address, target - have]);
  }
  // Fund from the throwaway devnet key; if other jobs have drained it just now, from the operator key.
  const total = needs.reduce((n, [, v]) => n + v, 0n);
  const operator = await createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(readFileSync(`${ROOT}.keys/opening-bell-devnet.json`, 'utf8'))));
  let source = funder;
  if ((await rpc.getBalance(funder.address, { commitment: 'confirmed' }).send()).value < total + 10_000_000n) source = operator;
  if (needs.length) await sendChunks(needs.map(([destination, amount]) => getTransferSolInstruction({ source, destination, amount })), source, 5);
  ev.check('fund', 'creator, three keepers and nine traders funded with devnet SOL (total under 0.5 SOL)', true, `${total} lamports moved from ${source.address === funder.address ? 'the throwaway funder' : 'the operator key'}; creator ${creator.address}, keeper A ${keeperA.address}, keeper B ${keeperB.address}, keeper C ${keeperC.address}`);

  const protocol = await protocolAddress();
  const prot = getProtocolDecoder().decode((await maybeAccount(protocol))!.data);
  const feeRecipient = prot.feeRecipient;

  // Tokens: one quote mint; a base mint per cross shape.
  // quote, sealed-cross base (sellers hold it), no-print base, launch base (mint authority handed to the cross)
  const [Q, BS, BN, BL] = await Promise.all([newMint(creator, creator.address), newMint(creator, creator.address), newMint(creator, creator.address), newMint(creator, creator.address)]);
  const baseIdSeed = BigInt(Date.now());
  const idL = baseIdSeed, idS = baseIdSeed + 1n, idN = baseIdSeed + 2n, idD = baseIdSeed + 3n;
  const crossL = await crossAddress(creator.address, idL);
  const atas: Instruction[] = [];
  const mkAta = async (owner: Address, mint: Address) => atas.push(getCreateAssociatedTokenIdempotentInstruction({ payer: creator, ata: await ata(owner, mint), owner, mint, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS }));
  for (const m of [Q, BS, BN, BL]) await mkAta(creator.address, m);
  await mkAta(feeRecipient, Q);
  for (const t of traders) await mkAta(t.address, Q);
  await mkAta(traders[3]!.address, BS);
  await mkAta(traders[7]!.address, BN);
  await sendChunks(atas, creator, 4);
  const mints: Instruction[] = [];
  for (const t of traders) mints.push(getMintToInstruction({ mint: Q, token: await ata(t.address, Q), mintAuthority: creator, amount: TRADER_QUOTE }, { programAddress: TOKEN_2022_PROGRAM_ADDRESS }));
  // The creator posts a dust bond in quote at creation (returned when the cross finalizes).
  mints.push(getMintToInstruction({ mint: Q, token: await ata(creator.address, Q), mintAuthority: creator, amount: CREATOR_QUOTE }, { programAddress: TOKEN_2022_PROGRAM_ADDRESS }));
  mints.push(getMintToInstruction({ mint: BS, token: await ata(traders[3]!.address, BS), mintAuthority: creator, amount: 1_000_000_000n }, { programAddress: TOKEN_2022_PROGRAM_ADDRESS }));
  mints.push(getMintToInstruction({ mint: BN, token: await ata(traders[7]!.address, BN), mintAuthority: creator, amount: 1_000_000_000n }, { programAddress: TOKEN_2022_PROGRAM_ADDRESS }));
  await sendChunks(mints, creator, 4);
  await send([getSetAuthorityInstruction({ owned: BL, owner: creator, authorityType: AuthorityType.MintTokens, newAuthority: crossL }, { programAddress: TOKEN_2022_PROGRAM_ADDRESS })], creator);

  // The four crosses. Windows are generous: devnet lands transactions in 1–17 s.
  const t0 = await chainTime();
  const closeL = t0 + 630n;
  const closeS = t0 + 600n, revealS = closeS + 300n;
  const closeN = t0 + 600n, closeD = t0 + 600n, deadlineD = t0 + 950n;
  const common = { creator, quoteMint: Q, baseTokenProgram: TOKEN_2022_PROGRAM_ADDRESS, quoteTokenProgram: TOKEN_2022_PROGRAM_ADDRESS, minPrice: GRID.min, tick: GRID.tick, ticks: GRID.ticks, priceScale: SCALE, openTs: t0 - 5n, integratorFeeBps: 20, integrator: creator.address, gateMint: null, proceedsTo: creator.address, referencePrice: null, maxImbalanceBps: null, oracle: null, calendar: null, settler: null, settleDeadlineTs: 0n, minMatched: 0n, shards: 2, maxOrders: 16 };
  const scheduleL = [{ price: 1_000_000n, quantity: 1_000_000_000n }, { price: 1_200_000n, quantity: 1_000_000_000n }, { price: 1_500_000n, quantity: 1_000_000_000n }];
  const create = async (label: string, input: Parameters<typeof buildCreateCross>[0]) => {
    const built = await buildCreateCross(input);
    const sig = await send([built.create], creator);
    for (const s of built.shards) await send([s], creator);
    const address = await crossAddress(creator.address, BigInt(input.crossId));
    ev.check(`create-${label}`, `${label} cross created`, true, `cross ${address}`, sig);
    return address;
  };
  const [L, S, N, D] = await Promise.all([
    create('launch (open book, mint mode)', { ...common, baseMint: BL, crossId: idL, kind: CrossKind.Launch, supplyMode: SupplyMode.Mint, disclosure: Disclosure.Open, closeTs: closeL, revealEndTs: closeL, schedule: scheduleL, integratorFeeBps: 20 }),
    create('sealed (one bid never revealed)', { ...common, baseMint: BS, crossId: idS, kind: CrossKind.Reopen, supplyMode: SupplyMode.Escrow, disclosure: Disclosure.Sealed, closeTs: closeS, revealEndTs: revealS, referencePrice: 1_500_000n, integratorFeeBps: 0, shards: 1, maxOrders: 8, schedule: [] }),
    create('no-print (volume below the minimum)', { ...common, baseMint: BN, crossId: idN, kind: CrossKind.Launch, supplyMode: SupplyMode.Escrow, disclosure: Disclosure.Open, closeTs: closeN, revealEndTs: closeN, minMatched: 10_000_000_000n, schedule: [], shards: 1, maxOrders: 8 }),
    create('deferred-mint launch (settler never binds)', { ...common, crossId: idD, kind: CrossKind.Launch, supplyMode: SupplyMode.DeferredMint, disclosure: Disclosure.Open, closeTs: closeD, revealEndTs: closeD, schedule: [{ price: 1_000_000n, quantity: 2_000_000_000n }], settler: settler.address, settleDeadlineTs: deadlineD, shards: 1, maxOrders: 8 }),
  ]);
  const crosses = [{ name: 'launch', address: L }, { name: 'sealed', address: S }, { name: 'no-print', address: N }, { name: 'deferred', address: D }];

  // Orders, all owners in parallel.
  const salts = traders.map(() => new Uint8Array(randomBytes(32)));
  const buyL: [number, bigint, bigint][] = [[0, 1_500_000n, 1_500_000_000n], [1, 1_200_000n, 800_000_000n], [2, 1_100_000n, 500_000_000n]];
  const sealedPlan: [number, OrderSide, bigint, bigint, boolean, bigint][] = [
    [3, OrderSide.Sell, 1_300_000n, 100_000_000n, true, 100n], [4, OrderSide.Buy, 1_600_000n, 80_000_000n, true, 101n], [5, OrderSide.Buy, 1_900_000n, 50_000_000n, false, 102n],
  ];
  const placed: Promise<string>[] = [];
  const lv = await crossView(L), sv = await crossView(S), nv = await crossView(N), dv = await crossView(D);
  for (const [i, price, quantity] of buyL) placed.push(send([await buildPlaceOrder({ cross: lv, owner: traders[i]!, nonce: BigInt(i), side: OrderSide.Buy, price, quantity })], traders[i]!));
  for (const [i, side, price, quantity, , nonce] of sealedPlan) {
    const escrow = side === OrderSide.Buy ? costCeil(quantity, 1_900_000n, SCALE) : quantity;
    placed.push(send([await buildPlaceOrder({ cross: sv, owner: traders[i]!, nonce, side, price, quantity, salt: salts[i]!, escrow })], traders[i]!));
  }
  placed.push(send([await buildPlaceOrder({ cross: nv, owner: traders[6]!, nonce: 200n, side: OrderSide.Buy, price: 1_500_000n, quantity: 100_000_000n })], traders[6]!));
  placed.push(send([await buildPlaceOrder({ cross: nv, owner: traders[7]!, nonce: 201n, side: OrderSide.Sell, price: 1_000_000n, quantity: 100_000_000n })], traders[7]!));
  placed.push(send([await buildPlaceOrder({ cross: dv, owner: traders[8]!, nonce: 300n, side: OrderSide.Buy, price: 1_200_000n, quantity: 1_000_000_000n })], traders[8]!));
  const placeSigs = await Promise.all(placed);
  ev.check('orders', `${placeSigs.length} orders placed concurrently by nine owners across the four crosses`, true, `windows close at chain time ${closeL}`, placeSigs[0]);
  const nowAfter = await chainTime();
  if (nowAfter >= closeS - 60n) throw new Error(`setup took too long: chain time ${nowAfter}, close ${closeS}`);

  // Owners reveal their sealed orders after the call (the unrevealed bidder never does).
  let revealError: unknown;
  const revealTask = (async () => {
    await waitUntil(closeS + 1n);
    const view = await crossView(S);
    await Promise.all(sealedPlan.filter((p) => p[4]).map(([i, , price, quantity, , nonce]) => buildReveal(view, traders[i]!, nonce, price, quantity, salts[i]!).then((ix) => send([ix], traders[i]!))));
  })().catch((e) => { revealError = e; });

  // Baseline for the ledger and the refund checks.
  // Every trader was minted exactly this much quote before any order was placed.
  const quoteBefore = new Map<string, bigint>(traders.map((t) => [t.address, TRADER_QUOTE]));

  // Keepers start now; nothing may happen until a reveal window ends.
  for (const k of KEEPERS) startKeeper(k);
  const keepersStarted = await chainTime();
  ev.check('keepers-up', 'three keeper processes started (A via the indexer, B and C via getProgramAccounts), each with its own payer, all scoped to this run creator', true, `A ${keeperA.address} · B ${keeperB.address} · C ${keeperC.address}`);

  // ---- chaos loop
  let killedAt = 0, firstSettled = 0, restarted = false, thirdParty = '';
  let killedInfo = '';
  const hard = Date.now() + 30 * 60_000;
  let lastPrint = 0;
  for (;;) {
    if (Date.now() > hard) throw new Error('crosses did not all finalize within 30 minutes');
    const views = await Promise.all(crosses.map((c) => crossView(c.address)));
    if (Date.now() - lastPrint > 20_000) {
      console.log(new Date().toISOString(), views.map((v, i) => `${crosses[i]!.name}:${CrossState[v.data.state]}/${v.data.ordersOpen}`).join(' '), `A done ${doneCount('A')} · B done ${doneCount('B')} · C done ${doneCount('C')}`);
      lastPrint = Date.now();
    }
    const anySettled = views.some((v) => v.data.state === CrossState.Cleared || v.data.state === CrossState.NoPrint);
    if (anySettled && !firstSettled) firstSettled = Date.now();
    // Kill A mid-work: as soon as it has landed an action, or after 60 s of the cross being settled if it never got there first.
    if (anySettled && !killedAt && (doneCount('A') >= 1 || Date.now() - firstSettled > 60_000)) {
      children.A?.kill('SIGKILL');
      killedAt = Date.now();
      killedInfo = `SIGKILL to keeper A with ${doneCount('A')} action(s) logged; keeper B has ${doneCount('B')}, keeper C ${doneCount('C')}`;
      ev.check('chaos-kill', 'keeper A killed (SIGKILL) mid-work, after the first cross settled', true, killedInfo);
    }
    if (killedAt && !restarted && Date.now() - killedAt > 30_000) {
      startKeeper('A');
      restarted = true;
      ev.check('chaos-restart', 'keeper A restarted 30 s later and rejoined the race', true, `A done ${doneCount('A')} · B done ${doneCount('B')} · C done ${doneCount('C')}`);
    }
    const lView = views[0]!;
    if (!thirdParty && lView.data.state === CrossState.Cleared && lView.data.ordersOpen > 0) {
      // A third party claims an order under both keepers' feet. Either it wins or a keeper already paid it.
      try {
        const sig = await send(await buildClaim(lView, creator, traders[1]!.address, 1n), creator);
        thirdParty = `landed (${sig})`;
      } catch (e) {
        thirdParty = `refused: ${String(e).split('\n')[0]!.slice(0, 160)}`;
      }
      ev.check('chaos-third-party', 'a third party claimed trader 1\'s order while both keepers were working (either outcome is legitimate; the owner is paid once)', true, thirdParty);
    }
    if (views.every((v) => v.data.state === CrossState.Finalized)) break;
    await sleep(5_000);
  }
  await revealTask;
  ev.check('reveal', 'the two owners who revealed their sealed orders did so inside the reveal window', !revealError, revealError ? String(revealError).slice(0, 200) : 'both reveals landed');
  const finalizedAt = Date.now();
  const doneAtFinal = { A: doneCount('A'), B: doneCount('B'), C: doneCount('C') };
  ev.check('finalized', 'all four crosses reached Finalized', true, `A performed ${doneAtFinal.A} actions, B ${doneAtFinal.B}, C ${doneAtFinal.C}`);

  // ---- outcomes against the independent reference
  const views = await Promise.all(crosses.map((c) => crossView(c.address)));
  const [vL, vS, vN, vD] = views as [typeof lv, typeof sv, typeof nv, typeof dv];
  const open = async (cross: Address, owner: Address, nonce: bigint) => (await maybeAccount(await orderAddress(cross, owner, nonce))) !== null;
  const allOrders: [Address, Address, bigint][] = [
    ...buyL.map(([i]) => [L, traders[i]!.address, BigInt(i)] as [Address, Address, bigint]),
    ...sealedPlan.map(([i, , , , , n]) => [S, traders[i]!.address, n] as [Address, Address, bigint]),
    [N, traders[6]!.address, 200n], [N, traders[7]!.address, 201n], [D, traders[8]!.address, 300n],
  ];
  const stillOpen = (await Promise.all(allOrders.map(async (o) => ((await open(...o)) ? o : null)))).filter(Boolean);
  ev.check('orders-closed', 'every order account is closed (rent returned) and ordersOpen is 0 on all four crosses', stillOpen.length === 0 && views.every((v) => v.data.ordersOpen === 0), `${allOrders.length} orders, ${stillOpen.length} still open`);

  const refL = referenceClear([...scheduleL.map((s) => ({ side: 'sell', price: s.price, quantity: s.quantity }) as RefOrder), ...buyL.map(([, price, quantity]) => ({ side: 'buy', price, quantity }) as RefOrder)], GRID, null)!;
  const cL = vL.data.clearing.__option === 'Some' ? vL.data.clearing.value : null;
  ev.check('launch-clear', 'launch printed at the reference price and volume', cL?.price === refL.price && cL?.matched === refL.matched, `P* ${cL?.price} (ref ${refL.price}), matched ${cL?.matched} (ref ${refL.matched})`);
  const fillsL = referenceFills(buyL.map(([, price, quantity]) => ({ side: 'buy', price, quantity }) as RefOrder), refL);
  for (const [k, [i]] of buyL.entries()) {
    const got = await balanceOf(traders[i]!.address, BL);
    const paid = quoteBefore.get(traders[i]!.address)! - (await balanceOf(traders[i]!.address, Q));
    ev.check(`launch-buyer-${i}`, `buyer ${i} received exactly the reference fill and paid exactly fill × P*`, got === fillsL[k] && paid === costCeil(fillsL[k]!, refL.price, SCALE), `base ${got} (ref ${fillsL[k]}), paid ${paid} (ref ${costCeil(fillsL[k]!, refL.price, SCALE)})`);
  }
  const mintL = getMintDecoder().decode((await maybeAccount(BL))!.data);
  ev.check('launch-supply', 'launch base supply equals the matched volume and the mint authority is revoked', mintL.supply === refL.matched && mintL.mintAuthority.__option === 'None', `supply ${mintL.supply}, authority ${mintL.mintAuthority.__option}`);

  const revealed: RefOrder[] = sealedPlan.filter((p) => p[4]).map(([, side, price, quantity]) => ({ side: side === OrderSide.Buy ? 'buy' : 'sell', price, quantity }));
  const refS = referenceClear(revealed, GRID, 1_500_000n)!;
  const cS = vS.data.clearing.__option === 'Some' ? vS.data.clearing.value : null;
  ev.check('sealed-clear', 'sealed cross cleared to the reference with the unrevealed bid excluded', cS?.price === refS.price && cS?.matched === refS.matched, `P* ${cS?.price} (ref ${refS.price}), matched ${cS?.matched} (ref ${refS.matched})`);
  const fillS = referenceFills([{ side: 'buy', price: 1_600_000n, quantity: 80_000_000n }], refS)[0]!;
  const gotS = await balanceOf(traders[4]!.address, BS);
  const paidS = quoteBefore.get(traders[4]!.address)! - (await balanceOf(traders[4]!.address, Q));
  ev.check('sealed-buyer', 'the revealed buyer received exactly the reference fill and paid fill × P*', gotS === fillS && paidS === costCeil(fillS, refS.price, SCALE), `base ${gotS} (ref ${fillS}), paid ${paidS}`);
  const keptS = quoteBefore.get(traders[5]!.address)! - (await balanceOf(traders[5]!.address, Q));
  ev.check('sealed-refund', 'the bidder who never revealed was refunded in full, to the atom', keptS === 0n && (await balanceOf(traders[5]!.address, BS)) === 0n, `net change in quote ${keptS}, base 0`);

  ev.check('noprint-state', 'the no-print cross ended NoPrint (volume below the minimum)', vN.data.state === CrossState.Finalized && vN.data.noPrintReason.__option === 'Some', `reason ${vN.data.noPrintReason.__option === 'Some' ? NoPrintReason[vN.data.noPrintReason.value] : 'none'}`);
  const nBuyer = quoteBefore.get(traders[6]!.address)! - (await balanceOf(traders[6]!.address, Q));
  ev.check('noprint-refund', 'no-print: buyer and seller both refunded in full', nBuyer === 0n && (await balanceOf(traders[7]!.address, BN)) === 1_000_000_000n, `buyer net quote ${nBuyer}, seller base ${await balanceOf(traders[7]!.address, BN)}`);

  const dBuyer = quoteBefore.get(traders[8]!.address)! - (await balanceOf(traders[8]!.address, Q));
  ev.check('deferred-abandon', 'deferred launch: the settler never bound, the keepers waited, abandoned it after the deadline and refunded the buyer in full', vD.data.noPrintReason.__option === 'Some' && vD.data.noPrintReason.value === NoPrintReason.SettlementExpired && dBuyer === 0n, `reason ${vD.data.noPrintReason.__option === 'Some' ? NoPrintReason[vD.data.noPrintReason.value] : 'none'}, buyer net quote ${dBuyer}`);

  // Conservation: quote only moves between owners, the creator (proceeds, integrator) and the fee recipient.
  const quoteParties = [...traders.map((t) => t.address), creator.address, feeRecipient];
  const quoteTotal = (await Promise.all(quoteParties.map((a) => balanceOf(a, Q)))).reduce((a, b) => a + b, 0n);
  const vaultsLeft = (await Promise.all(crosses.map(async (c) => { const a = await maybeAccount(await quoteVaultAddress(c.address)); return a ? getTokenDecoder().decode(a.data).amount : 0n; }))).reduce((a, b) => a + b, 0n);
  ev.check('conservation-quote', 'quote is conserved: owners + creator + fee recipient hold exactly what was minted, and every quote vault is empty', quoteTotal === 9n * TRADER_QUOTE + CREATOR_QUOTE && vaultsLeft === 0n, `total ${quoteTotal} (minted ${9n * TRADER_QUOTE + CREATOR_QUOTE}), vaults ${vaultsLeft}`);
  const baseSumS = (await Promise.all([...[3, 4, 5].map((i) => balanceOf(traders[i]!.address, BS)), balanceOf(creator.address, BS)])).reduce((a, b) => a + b, 0n);
  ev.check('conservation-base', 'sealed-cross base is conserved between seller, buyer and the creator\'s proceeds account', baseSumS === 1_000_000_000n, `total ${baseSumS}`);

  // ---- idle: both keepers keep running; nothing may happen
  await sleep(60_000);
  const idleA = doneCount('A') - doneAtFinal.A, idleB = doneCount('B') - doneAtFinal.B, idleC = doneCount('C') - doneAtFinal.C;
  ev.check('idempotent-idle', 'after Finalized, all three keepers ran about ten passes each and performed zero actions', idleA === 0 && idleB === 0 && idleC === 0, `A +${idleA}, B +${idleB}, C +${idleC} actions in 60 s (${Math.round((Date.now() - finalizedAt) / 1000)} s since the last cross finalized)`);

  // ---- duplicate manual actions are refused, never double-paying
  const dupClaim = await send(await buildClaim(vL, creator, traders[0]!.address, 0n), creator).then((s) => `LANDED ${s}`, (e) => String(e).split('\n').slice(0, 2).join(' ').slice(0, 220));
  ev.check('dup-claim', 'claiming an already-claimed order again is refused', !dupClaim.startsWith('LANDED'), dupClaim);
  const dupFin = await send([await buildFinalize(vL, creator)], creator).then((s) => `LANDED ${s}`, (e) => String(e).split('\n').slice(0, 2).join(' ').slice(0, 220));
  ev.check('dup-finalize', 'finalizing an already-finalized cross again is refused', !dupFin.startsWith('LANDED'), dupFin);

  for (const k of KEEPERS) children[k]?.kill('SIGTERM');

  // ---- who did what, from chain
  const roles = new Map(names);
  const rows: string[] = [];
  const perPayer: Record<string, number> = {};
  const landedFailed: string[] = [];
  for (const c of crosses) {
    const sigs = await rpc.getSignaturesForAddress(c.address, { commitment: 'confirmed', limit: 200 }).send();
    for (const s of sigs) {
      const tx = await rpc.getTransaction(s.signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0, encoding: 'json' }).send();
      const payer = tx?.transaction.message.accountKeys[0];
      const who = payer ? (roles.get(payer) ?? payer) : '?';
      const logs = tx?.meta?.logMessages ?? [];
      const instr = logs.flatMap((l) => /Program log: Instruction: (w+)/.exec(l)?.[1] ?? []).filter((n) => !/^(CreateIdempotent|Create|InitializeAccount3|InitializeImmutableOwner|GetAccountDataSize|Transfer|TransferChecked|MintTo|MintToChecked|CloseAccount|SetAuthority|Burn)$/.test(n))[0] ?? '';
      if (s.err) landedFailed.push(`${c.name}/${s.signature.slice(0, 8)}… ${who} ${instr}`);
      if (who.startsWith('keeper')) perPayer[`${c.name}/${who}`] = (perPayer[`${c.name}/${who}`] ?? 0) + (s.err ? 0 : 1);
      rows.push(`| ${c.name} | ${s.blockTime ?? ''} | ${who} | ${instr || '—'} | ${s.err ? 'FAILED' : 'ok'} | [${s.signature.slice(0, 8)}…](https://explorer.solana.com/tx/${s.signature}?cluster=devnet) |`);
    }
  }
  const settleBy = (n: string) => Object.entries(perPayer).filter(([k]) => k.endsWith(n)).reduce((a, [, v]) => a + v, 0);
  ev.check('both-keepers-worked', 'at least two keepers landed transactions on these crosses (the race was real, not one keeper doing everything)', KEEPERS.filter((k) => settleBy(`keeper${k}`) > 0).length >= 2, `landed transactions on these crosses: ${KEEPERS.map((k) => `keeper ${k} ${settleBy(`keeper${k}`)}`).join(', ')}`);

  const logEntries = (n: string) => readLog(n);
  const lostRaces = KEEPERS.flatMap((k) => logEntries(k).flatMap((e) => (e.failed ?? []).map((f) => `${k}: ${f.action.kind} → ${f.error.slice(0, 120)}`)));
  const keeperErrors = KEEPERS.flatMap((k) => logEntries(k).flatMap((e) => (e.error ? [`${k}: ${e.error.slice(0, 160)}`] : [])));

  ev.write();
  const extra = [
    '', '## Transactions on the four crosses, by fee payer (from chain)', '',
    '| Cross | Block time | Fee payer | Instruction | Result | Transaction |', '|---|---|---|---|---|---|', ...rows, '',
    `Landed-but-failed transactions touching these crosses: ${landedFailed.length ? landedFailed.join('; ') : 'none'}.`, '',
    '## What the losing side of each race looked like (keeper logs)', '',
    lostRaces.length ? lostRaces.map((l) => `- ${l}`).join('\n') : '- no refused actions were logged',
    '', '## Keeper pass errors (RPC, discovery)', '', keeperErrors.length ? [...new Set(keeperErrors)].slice(0, 12).map((l) => `- ${l}`).join('\n') : '- none', '',
    '## Crosses', '', ...crosses.map((c) => `- ${c.name}: \`${c.address}\``), '',
  ];
  appendFileSync(`${ROOT}docs/evidence/${EVIDENCE}`, extra.join('\n'));
  writeFileSync('/tmp/dn-d2-state.json', JSON.stringify({ crosses, keepersStarted: keepersStarted.toString(), creator: creator.address, quote: Q }, null, 2));
}

main().then(() => process.exit(process.exitCode ?? 0), (e) => {
  console.error(e);
  for (const k of KEEPERS) children[k]?.kill('SIGKILL');
  ev.write(e);
  process.exit(1);
});
