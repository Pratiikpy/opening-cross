// A real-validator proof of three things at once, all with non-zero fees and a referral (rows W4, W6, V-E keeper side, X6/J1/P6 "non-zero fees untested"):
//
//   1. the KEEPER's own code (runOnce: clear, claim, finalize) finishes crosses that name a referrer, including a referrer who has never held the quote mint, which
//      `finalize` refuses without (ReferralAccountMissing). The control sends the SDK's finalize without the keeper's extra account and shows the refusal;
//   2. the real program binary charges the fees the fee library says it charges (schedule, integrator cap, escrow-mode and mint-mode fee bases, the referral's floor);
//   3. the FEE LEDGER (packages/fees) reads the real finalize transaction's token balances and the real CrossFinalized event and returns MATCH for every cross,
//      and the referrer, fee recipient and integrator balances are read back from chain independently of the ledger.
//
// It needs a validator running the locally built cross_core at its declared address, and writes nothing but stdout. Never point it at a cluster with value:
//
//   wsl: solana-test-validator --reset --bpf-program <cross_core id> target/deploy/cross_core.so --rpc-port 8950 ...   (scripts/w3d-local-validator.sh does it for 8899)
//   RPC_URL=http://127.0.0.1:8950 pnpm --filter @opening-cross/keeper exec tsx scripts/referral-proof.ts
//
// The operator, keeper and every other wallet are generated here and funded from the validator's faucet; no key file is read except by the shared devnet helper's import.
import { type Address, AccountRole, type Instruction, type KeyPairSigner, fetchEncodedAccount, generateKeyPairSigner, getAddressEncoder, getBase58Encoder } from '@solana/kit';
import {
  CROSS_CORE_PROGRAM_ADDRESS,
  CrossKind,
  CrossState,
  Disclosure,
  OrderSide,
  SupplyMode,
  buildCreateCross,
  buildFinalizeWithAccounts,
  buildPlaceOrder,
  completeRules,
  crossAddress,
  getCrossDecoder,
  getInitProtocolInstruction,
  getSetRulesInstruction,
  protocolAddress,
  readCrossExt,
  FINALIZE_DISCRIMINATOR,
  PUSH_REFUNDS_DISCRIMINATOR,
  TOKEN_2022_PROGRAM,
  ata as sdkAta,
} from '@opening-cross/sdk';
import { createIndexerRpc, decodeLogs } from '@opening-cross/indexer';
import { type TransactionBalances, KINDS, ledgerEntry, type CrossFeeFacts, type SupplyMode as FeeSupplyMode } from '../../../packages/fees/src/index.js';
import { rpc, RPC } from '../../../tests/devnet/src/lib.js';
import { chainTime, mintTo, newMint, send, waitUntil, ataIx, mustFail, tokenBalance, ata as t22Ata, accountData } from '../../../tests/devnet/src/kit.js';
import { fromProgramAccounts, parseDuties, pollingSender, runOnce } from '../src/index.js';

if (!process.env.RPC_URL || /mainnet|devnet\.solana\.com/.test(process.env.RPC_URL)) throw new Error('set RPC_URL to a local validator that runs the locally built cross_core; this proof never targets a public cluster');
const SCALE = 1_000_000n;
const GRID = { min: 1_000_000n, tick: 100_000n, ticks: 20 };
const log = (step: string, detail: Record<string, unknown>) => console.log(JSON.stringify({ step, ...detail }, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
const startsWith = (ix: Instruction, d: ArrayLike<number>) => Array.from(d).every((b, i) => ix.data?.[i] === b);

async function airdrop(to: Address, sol: number) {
  await rpc.requestAirdrop(to, BigInt(sol) * 1_000_000_000n as never).send();
  for (let i = 0; i < 40; i++) {
    if ((await rpc.getBalance(to, { commitment: 'confirmed' }).send()).value > 0n) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('airdrop did not land');
}
const fund = async (n: number) => {
  const wallets = await Promise.all(Array.from({ length: n }, () => generateKeyPairSigner()));
  for (const w of wallets) await airdrop(w.address, 20);
  return wallets;
};

/** SPL Token / Token-2022 `SetAuthority` (instruction 6) for the mint-tokens authority, to a new owner: the cross PDA holds the base mint's authority in a minting cross. */
const handMintAuthority = (mint: Address, current: KeyPairSigner, to: Address): Instruction => ({
  programAddress: TOKEN_2022_PROGRAM,
  accounts: [
    { address: mint, role: AccountRole.WRITABLE },
    { address: current.address, role: AccountRole.READONLY_SIGNER, signer: current },
  ],
  data: Uint8Array.from([6, 0, 1, ...getAddressEncoder().encode(to)]),
} as Instruction);

type Scenario = {
  name: string;
  mode: 'mint' | 'escrow';
  integratorBps: number;
  /** The referral the cross names; the referrer's quote account is opened beforehand only if `referrerHasAccount`. */
  referral?: { shareBps: number; referrerHasAccount: boolean };
  /** A minimum raise nobody meets: the cross does not print, every escrow is refunded, and the keeper batches the refunds (`push_refunds`). */
  noPrint?: boolean;
};

async function main() {
  const [operator, keeperWallet, feeRecipient, integrator, proceeds] = await fund(5);
  const [b1, b2, b3, seller] = await fund(4);
  const refundees = await fund(3); // the buyers of the cross that does not print: their balances must come back exactly
  const protocol = await protocolAddress();
  if (!(await fetchEncodedAccount(rpc, protocol)).exists) {
    await send([getInitProtocolInstruction({ admin: operator!, protocol, guardian: operator!.address, feeRecipient: feeRecipient!.address, feeBps: [30, 5, 15, 30] })], operator!);
  }
  const quoteMint = await newMint(operator!, operator!.address);
  const buyers = [b1!, b2!, b3!];
  for (const b of buyers) await mintTo(operator!, quoteMint, b.address, operator!, 50_000_000_000n);
  for (const b of refundees) await mintTo(operator!, quoteMint, b.address, operator!, 50_000_000_000n);
  await mintTo(operator!, quoteMint, operator!.address, operator!, 1_000_000_000n); // the creator's quote account for the creation deposit
  log('setup', { rpc: RPC, operator: operator!.address, keeper: keeperWallet!.address, feeRecipient: feeRecipient!.address, quoteMint, schedule: [30, 5, 15, 30] });

  const scenarios: Scenario[] = [
    { name: 'A mint, 200 bps integrator, 10% referral, referrer has no token account', mode: 'mint', integratorBps: 200, referral: { shareBps: 1_000, referrerHasAccount: false } },
    { name: 'B mint, 120 bps integrator, no referral', mode: 'mint', integratorBps: 120 },
    { name: 'C escrow, 80 bps integrator (protocol fee capped at a quarter of it), 50% referral, referrer has an account', mode: 'escrow', integratorBps: 80, referral: { shareBps: 5_000, referrerHasAccount: true } },
    { name: 'D mint, a minimum raise nobody meets: no print, three escrows refunded in one pushed batch', mode: 'mint', integratorBps: 200, noPrint: true },
  ];

  const made: { s: Scenario; cross: Address; referrer: KeyPairSigner | null; closeTs: bigint }[] = [];
  for (const s of scenarios) {
    const referrer = s.referral ? await generateKeyPairSigner() : null;
    if (referrer && s.referral!.referrerHasAccount) await send([await ataIx(operator!, referrer.address, quoteMint)], operator!);
    const crossId = BigInt(Date.now()) * 10n + BigInt(made.length);
    const cross = await crossAddress(operator!.address, crossId);
    const baseMint = await newMint(operator!, operator!.address);
    if (s.mode === 'mint') await send([handMintAuthority(baseMint, operator!, cross), await ataIx(operator!, operator!.address, baseMint)], operator!);
    else await mintTo(operator!, baseMint, seller!.address, operator!, 5_000_000_000n);
    const now = await chainTime();
    const closeTs = now + 45n;
    const built = await buildCreateCross({
      creator: operator!, baseMint, quoteMint, baseTokenProgram: TOKEN_2022_PROGRAM, quoteTokenProgram: TOKEN_2022_PROGRAM,
      crossId, kind: CrossKind.Launch, supplyMode: s.mode === 'mint' ? SupplyMode.Mint : SupplyMode.Escrow, disclosure: Disclosure.Open,
      minPrice: GRID.min, tick: GRID.tick, ticks: GRID.ticks, priceScale: SCALE, openTs: now - 5n, closeTs, revealEndTs: closeTs,
      referencePrice: null, minMatched: 0n, maxImbalanceBps: null, integratorFeeBps: s.integratorBps, integrator: integrator!.address, gateMint: null,
      shards: 2, maxOrders: 16, proceedsTo: proceeds!.address, settler: null, settleDeadlineTs: 0n, oracle: null, calendar: null,
      schedule: s.mode === 'mint' ? [{ price: 1_000_000n, quantity: 1_000_000_000n }, { price: 1_200_000n, quantity: 1_000_000_000n }, { price: 1_500_000n, quantity: 1_000_000_000n }] : [],
    });
    await send([built.ensureCreatorQuote], operator!);
    const createIxs: Instruction[] = [built.create];
    if (referrer || s.noPrint) createIxs.push(getSetRulesInstruction({ creator: operator!, cross, ...completeRules({ ...(referrer ? { referral: { referrer: referrer.address, shareBps: s.referral!.shareBps } } : {}), ...(s.noPrint ? { guards: { minRaiseQuote: 1_000_000_000_000_000n } } : {}) }) }));
    await send(createIxs, operator!); // the rules are written in the slot the cross is created in
    for (const sh of built.shards) await send([sh], operator!);
    const raw = await accountData(cross);
    const view = { address: cross, data: getCrossDecoder().decode(raw), ext: readCrossExt(raw) };
    const place = async (owner: KeyPairSigner, nonce: bigint, side: OrderSide, price: bigint, quantity: bigint) => send([await buildPlaceOrder({ cross: view, owner, nonce, side, price, quantity, now: await chainTime() })], owner);
    if (s.noPrint) {
      await place(refundees[0]!, 1n, OrderSide.Buy, 1_500_000n, 1_500_000_000n);
      await place(refundees[1]!, 1n, OrderSide.Buy, 1_200_000n, 800_000_000n);
      await place(refundees[2]!, 1n, OrderSide.Buy, 1_100_000n, 500_000_000n);
    } else if (s.mode === 'mint') {
      await place(b1!, 1n, OrderSide.Buy, 1_500_000n, 1_500_000_000n);
      await place(b2!, 1n, OrderSide.Buy, 1_200_000n, 800_000_000n);
      await place(b3!, 1n, OrderSide.Buy, 1_100_000n, 500_000_000n);
    } else {
      await place(seller!, 1n, OrderSide.Sell, 1_000_000n, 2_000_000_000n);
      await place(b1!, 2n, OrderSide.Buy, 1_400_000n, 1_200_000_000n);
      await place(b2!, 2n, OrderSide.Buy, 1_200_000n, 900_000_000n);
    }
    made.push({ s, cross, referrer, closeTs });
    log('created', { scenario: s.name, cross, ext: view.ext ? { referrer: view.ext.referral.referrer, shareBps: view.ext.referral.shareBps } : null, protocolBps: view.data.protocolFeeBps, integratorBps: view.data.integratorFeeBps });
  }

  // ---- the keeper, real code, over real RPC
  const irpc = createIndexerRpc(RPC);
  const discovery = fromProgramAccounts(irpc, CROSS_CORE_PROGRAM_ADDRESS, { creators: [operator!.address] });
  const fetchAcc = async (a: Address) => {
    const x = await fetchEncodedAccount(irpc, a, { commitment: 'confirmed' });
    return x.exists ? x.data : null;
  };
  const clusterNow = async () => BigInt(await irpc.getBlockTime(await irpc.getSlot({ commitment: 'confirmed' }).send()).send());
  const real = pollingSender(irpc, keeperWallet!);
  const controlCross = made[0]!.cross;
  let holdControl = true;
  const sender = async (ixs: Instruction[]) => {
    if (holdControl && ixs.some((ix) => startsWith(ix, FINALIZE_DISCRIMINATOR) && ix.accounts?.some((a) => a.address === controlCross))) throw new Error('held back so that the control can show what finalize does without the keeper\'s extra account');
    return real(ixs);
  };
  const pass = () =>
    runOnce({ payer: keeperWallet!, ...discovery, duties: parseDuties('default'), now: clusterNow, fetch: fetchAcc, slot: async () => BigInt(await irpc.getSlot({ commitment: 'confirmed' }).send()), send: sender, accept: (c) => c.creator === operator!.address });

  await waitUntil(made[0]!.closeTs + 2n);
  const signatures = new Map<Address, string>();
  const sent: { kind: string; cross: Address | null; signature: string; orders?: number }[] = [];
  const harvest = (r: Awaited<ReturnType<typeof pass>>) => {
    for (const d of r.done) sent.push({ kind: d.action.kind, cross: 'cross' in d.action ? d.action.cross : null, signature: d.signature, ...(d.action.kind === 'push-refunds' ? { orders: d.action.orders.length } : {}) });
    for (const d of r.done) if (d.action.kind === 'finalize') signatures.set(d.action.cross, d.signature);
    for (const f of r.failed) log('keeper-failed', { action: f.action.kind, error: f.error });
  };
  for (let i = 0; i < 8; i++) {
    harvest(await pass());
    const states = await Promise.all(made.map(async (m) => getCrossDecoder().decode(await accountData(m.cross)).state));
    if (made.slice(1).every((_m, j) => states[j + 1] === CrossState.Finalized)) break;
  }

  // ---- control: the cross that names a referrer without a token account is cleared and claimed, and finalize without the keeper's extra account is refused
  const raw = await accountData(controlCross);
  const control = { address: controlCross, data: getCrossDecoder().decode(raw), ext: readCrossExt(raw) };
  if (control.data.state !== CrossState.Cleared) throw new Error(`the control cross should be waiting to finalize, not ${CrossState[control.data.state]}`);
  const refusal = await mustFail(await buildFinalizeWithAccounts(control, keeperWallet!), keeperWallet!, 'ReferralAccountMissing');
  log('control', { cross: controlCross, finalizeWithoutTheKeepersAccount: refusal });
  holdControl = false;
  harvest(await pass());

  // ---- the ledger, from the real transactions
  const SUPPLY: FeeSupplyMode[] = ['escrow', 'mint', 'deferred-mint'];
  const out: unknown[] = [];
  for (const m of made) {
    const sig = signatures.get(m.cross);
    if (!sig) throw new Error(`no finalize signature for ${m.cross}`);
    const res = (await (await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTransaction', params: [sig, { encoding: 'jsonParsed', commitment: 'confirmed', maxSupportedTransactionVersion: 0 }] }) })).json()) as { result: { blockTime: number; slot: number; meta: TransactionBalances & { logMessages: string[] } } };
    const { meta } = res.result;
    const event = decodeLogs(meta.logMessages).find((e) => e.name === 'CrossFinalized');
    if (!event || event.name !== 'CrossFinalized') throw new Error('no CrossFinalized event in the finalize transaction');
    const rawNow = await accountData(m.cross);
    const c = getCrossDecoder().decode(rawNow);
    const ext = readCrossExt(rawNow);
    const facts: CrossFeeFacts = {
      cross: m.cross, creator: c.creator, kind: KINDS[c.kind]!, supplyMode: SUPPLY[c.supplyMode]!, quoteMint: c.quoteMint, protocolBps: c.protocolFeeBps, integratorBps: c.integratorFeeBps,
      integrator: c.integrator, feeRecipient: c.feeRecipient, proceedsTo: c.proceedsTo, buyerPaid: c.buyerPaid, feesAccrued: c.feesAccrued,
      referrer: ext && ext.referral.shareBps > 0 ? ext.referral.referrer : undefined, referralShareBps: ext ? ext.referral.shareBps : undefined,
    };
    const entry = ledgerEntry(facts, { signature: sig, slot: res.result.slot, blockTime: res.result.blockTime, protocolFee: event.data.protocolFee, integratorFee: event.data.integratorFee, proceedsQuote: event.data.proceedsQuote }, { preTokenBalances: meta.preTokenBalances, postTokenBalances: meta.postTokenBalances, err: meta.err });
    // Independent of the ledger: what the referrer, fee recipient and integrator hold now, read from their token accounts.
    const held = async (w: Address) => tokenBalance(await t22Ata(w, quoteMint)).catch(() => null);
    const refHeld = m.referrer ? await held(m.referrer.address) : null;
    const feeHeld = await held(c.feeRecipient);
    log('ledger', {
      scenario: m.s.name, cross: m.cross, finalizeSignature: sig, state: CrossState[c.state], supplyMode: facts.supplyMode, protocolBps: facts.protocolBps, integratorBps: facts.integratorBps,
      eventProtocolFee: event.data.protocolFee, eventIntegratorFee: event.data.integratorFee, expected: entry.expected, referrer: entry.referrer, referral: entry.referral,
      verdict: entry.verdict, reasons: entry.reasons, referrerHolds: refHeld, feeRecipientHolds: feeHeld, ataOfReferrerCreatedBy: m.s.referral && !m.s.referral.referrerHasAccount ? 'the keeper, in the finalize transaction' : null,
    });
    if (entry.verdict !== 'MATCH') throw new Error(`ledger verdict ${entry.verdict} for ${m.s.name}: ${entry.reasons.join('; ')}`);
    if (!m.s.noPrint && (entry.expected.total === 0n || event.data.protocolFee === 0n)) throw new Error(`the proof is meaningless without non-zero fees: ${m.s.name}`);
    out.push({ scenario: m.s.name, verdict: entry.verdict, protocolFee: event.data.protocolFee, integratorFee: event.data.integratorFee, referral: entry.referral });
  }
  // ---- the cross that did not print: the keeper sent one push_refunds for all three orders, the buyers hold what they held, and the orders are closed
  const d = made.find((m) => m.s.noPrint)!;
  const pushed = sent.filter((x) => x.kind === 'push-refunds' && x.cross === d.cross);
  // The transaction's own top-level instruction, by the program's discriminator: one cross_core instruction, and it is push_refunds.
  const pushTx = pushed[0] ? ((await (await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTransaction', params: [pushed[0].signature, { encoding: 'jsonParsed', commitment: 'confirmed', maxSupportedTransactionVersion: 0 }] }) })).json()) as { result: { transaction: { message: { instructions: { programId: string; data?: string }[] } } } }).result.transaction.message.instructions : [];
  const coreIxs = pushTx.filter((ix) => ix.programId === CROSS_CORE_PROGRAM_ADDRESS);
  const isPush = coreIxs.length === 1 && Array.from(PUSH_REFUNDS_DISCRIMINATOR).every((b, i) => getBase58Encoder().encode(coreIxs[0]!.data ?? '')[i] === b);
  const dState = getCrossDecoder().decode(await accountData(d.cross));
  const refunded = await Promise.all(refundees.map(async (b) => tokenBalance(await t22Ata(b.address, quoteMint))));
  log('no-print', { cross: d.cross, state: CrossState[dState.state], ordersOpen: dState.ordersOpen, pushRefunds: pushed.map((x) => ({ signature: x.signature, orders: x.orders })), theTransactionsOnlyCrossCoreInstructionIsPushRefunds: isPush, buyersHoldAgain: refunded });
  if (pushed.length !== 1 || pushed[0]!.orders !== 3 || !isPush || dState.ordersOpen !== 0 || !refunded.every((x) => x === 50_000_000_000n)) throw new Error('the pushed refund was not what the proof expects');
  const referrers = made.filter((m) => m.referrer);
  const held = await Promise.all(referrers.map(async (m) => tokenBalance(await t22Ata(m.referrer!.address, quoteMint))));
  log('summary', { crosses: made.length, allMatch: true, referrerBalances: held, keeperSent: Object.fromEntries([...new Set(sent.map((x) => x.kind))].map((k) => [k, sent.filter((x) => x.kind === k).length])) });
  void chainTime;
}

main().then(() => process.exit(0), (e) => {
  console.error(e);
  process.exit(1);
});
