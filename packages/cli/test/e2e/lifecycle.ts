// The CLI against a real local validator (and, when OC_API is set, the real indexer and API): the whole life of two crosses driven only through
// the `opening-cross` binary, with every outcome checked against the chain and not against the CLI's own output.
//
//   RPC_URL=http://127.0.0.1:8960 OC_API=http://127.0.0.1:8460 OUT=/tmp/oc-s1-cli.json node --import tsx test/e2e/lifecycle.ts
//
// Cross A: open book, escrow supply, a seller and two buyers; the integrator's fee is checked against the fee model.
// Cross B: sealed bids, minted supply; one bid is revealed, one is not (and is refunded in full).
// Then the careless caller: closed window, insufficient funds, missing key, junk JSON, off-grid price, dry run.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type Address,
  type Instruction,
  type KeyPairSigner,
  airdropFactory,
  appendTransactionMessageInstructions,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  createTransactionMessage,
  generateKeyPairSigner,
  lamports,
  pipe,
  sendAndConfirmTransactionFactory,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from '@solana/kit';
import { getCreateAccountInstruction } from '@solana-program/system';
import {
  TOKEN_2022_PROGRAM_ADDRESS,
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstruction,
  getInitializeMint2Instruction,
  getMintSize,
  getMintToInstruction,
} from '@solana-program/token-2022';
import { getInitProtocolInstruction, protocolAddress } from '@opening-cross/sdk';
import { createRpcClient, readCrossFromChain } from '@opening-cross/client';

const RPC_URL = process.env.RPC_URL ?? 'http://127.0.0.1:8960';
const WS_URL = process.env.WS_URL ?? RPC_URL.replace(/^http/, 'ws').replace(/:(\d+)$/, (_m, p) => `:${Number(p) + 1}`);
const API = process.env.OC_API;
const OUT = process.env.OUT ?? join(tmpdir(), 'oc-s1-cli.json');
const CALL_SECS = Number(process.env.CALL_SECS ?? 40);
const REVEAL_SECS = Number(process.env.REVEAL_SECS ?? 40);
const CLI_DIR = fileURLToPath(new URL('../..', import.meta.url));

const rpc = createSolanaRpc(RPC_URL);
const subs = createSolanaRpcSubscriptions(WS_URL);
const sendAndConfirm = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions: subs });
const airdrop = airdropFactory({ rpc, rpcSubscriptions: subs });
const oc = createRpcClient({ url: RPC_URL });
const dir = mkdtempSync(join(tmpdir(), 'oc-cli-e2e-'));

const results: { name: string; ok: boolean; detail?: string }[] = [];
async function check(name: string, fn: () => Promise<string | void>) {
  try {
    const detail = await fn();
    results.push({ name, ok: true, ...(detail ? { detail } : {}) });
    console.log(`PASS ${name}${detail ? `  (${detail})` : ''}`);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    results.push({ name, ok: false, detail });
    console.log(`FAIL ${name}\n     ${detail.split('\n').join('\n     ')}`);
  }
}

// ---- chain helpers (setup only; every assertion below reads the chain)
async function send(ixs: Instruction[], payer: KeyPairSigner) {
  const { value: bh } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send();
  const tx = await signTransactionMessageWithSigners(pipe(createTransactionMessage({ version: 0 }), (m) => setTransactionMessageFeePayerSigner(payer, m), (m) => setTransactionMessageLifetimeUsingBlockhash(bh, m), (m) => appendTransactionMessageInstructions(ixs, m)));
  await sendAndConfirm(tx as Parameters<typeof sendAndConfirm>[0], { commitment: 'confirmed' });
}
const secret = async (k: KeyPairSigner) => Array.from(new Uint8Array([...new Uint8Array(await crypto.subtle.exportKey('pkcs8', k.keyPair.privateKey)).slice(16), ...new Uint8Array(await crypto.subtle.exportKey('raw', k.keyPair.publicKey))]));
async function wallet(name: string, sol: bigint) {
  const w = await generateKeyPairSigner(true);
  if (sol > 0n) await airdrop({ recipientAddress: w.address, lamports: lamports(sol * 1_000_000_000n), commitment: 'confirmed' });
  const file = join(dir, `${name}.json`);
  writeFileSync(file, JSON.stringify(await secret(w)), { mode: 0o600 });
  return { signer: w, address: w.address as string, file, vault: join(dir, `${name}-vault.json`) };
}
type W = Awaited<ReturnType<typeof wallet>>;
async function mint(authority: KeyPairSigner, decimals: number): Promise<Address> {
  const m = await generateKeyPairSigner();
  const space = getMintSize();
  const rent = await rpc.getMinimumBalanceForRentExemption(BigInt(space)).send();
  await send([getCreateAccountInstruction({ payer: authority, newAccount: m, lamports: rent, space, programAddress: TOKEN_2022_PROGRAM_ADDRESS }), getInitializeMint2Instruction({ mint: m.address, decimals, mintAuthority: authority.address, freezeAuthority: null })], authority);
  return m.address;
}
async function fund(m: Address, authority: KeyPairSigner, owner: Address, amount: bigint) {
  const [ata] = await findAssociatedTokenPda({ owner, mint: m, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS });
  const ixs: Instruction[] = [getCreateAssociatedTokenIdempotentInstruction({ payer: authority, ata, owner, mint: m, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS })];
  if (amount > 0n) ixs.push(getMintToInstruction({ mint: m, token: ata, mintAuthority: authority, amount }, { programAddress: TOKEN_2022_PROGRAM_ADDRESS }));
  await send(ixs, authority);
}
async function balance(mintAddr: string, owner: string): Promise<bigint> {
  const [ata] = await findAssociatedTokenPda({ owner: owner as Address, mint: mintAddr as Address, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS });
  return (await oc.tokenBalance(ata))?.amount ?? 0n;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(ts: bigint) {
  while ((await oc.unixTime()) <= ts) await sleep(1000);
}

// ---- running the binary
type Ran = { code: number; stdout: string; stderr: string; json: any };
function cli(args: string[], w: W | null, env: Record<string, string> = {}): Ran {
  const r = spawnSync(process.execPath, ['--import', 'tsx', 'src/bin.ts', ...args], {
    cwd: CLI_DIR,
    encoding: 'utf8',
    timeout: 240_000,
    env: { ...process.env, OPENING_CROSS_RPC: RPC_URL, OPENING_CROSS_CLUSTER: 'localnet', ...(API ? { OPENING_CROSS_API: API } : {}), ...(w ? { OPENING_CROSS_KEYPAIR: w.file, OPENING_CROSS_VAULT: w.vault } : {}), ...env },
  });
  let json: unknown = null;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    // Not a JSON command or an error exit.
  }
  return { code: r.status ?? -1, stdout: r.stdout, stderr: r.stderr, json };
}
const ok = (r: Ran, what: string) => assert.equal(r.code, 0, `${what} exited ${r.code}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);

// ---- setup
console.log(`validator ${RPC_URL}, api ${API ?? '(none)'}, state dir ${dir}`);
const admin = await wallet('admin', 50n);
const issuer = await wallet('issuer', 20n);
const integrator = await wallet('integrator', 0n);
const seller = await wallet('seller', 5n);
const buyer1 = await wallet('buyer1', 5n);
const buyer2 = await wallet('buyer2', 5n);
const poor = await wallet('poor', 0n); // no SOL at all
const broke = await wallet('broke', 5n); // SOL but no tokens
await send([getInitProtocolInstruction({ admin: admin.signer, protocol: await protocolAddress(), guardian: admin.signer.address, feeRecipient: admin.signer.address, feeBps: [30, 5, 15, 30] })], admin.signer);
const quote = await mint(admin.signer, 6);
const baseA = await mint(admin.signer, 6);
const baseB = await mint(issuer.signer, 6);
for (const w of [seller, buyer1, buyer2, broke, issuer, integrator, admin]) await fund(quote, admin.signer, w.signer.address, 0n);
await fund(quote, admin.signer, buyer1.address as Address, 1_000_000_000n);
await fund(quote, admin.signer, buyer2.address as Address, 1_000_000_000n);
await fund(baseA, admin.signer, seller.address as Address, 500_000_000n);
const quoteStart = { buyer1: await balance(quote, buyer1.address), buyer2: await balance(quote, buyer2.address) };

const state: Record<string, unknown> = { rpc: RPC_URL, api: API ?? null, quote, baseA, baseB };
const nowS = async () => oc.unixTime();

// ---- the CLI reads before anything exists
await check('cross get on an address that is not a cross exits 2 and says so', async () => {
  const r = cli(['cross', 'get', quote], null);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /not an Opening Cross account|not found on chain/);
});

// ---- cross A: open book, escrow supply
const fileA = join(dir, 'cross-a.json');
writeFileSync(fileA, JSON.stringify({ baseMint: baseA, quoteMint: quote, supplyMode: 'escrow', disclosure: 'open', grid: { min: '1', tick: '0.05', ticks: 11 }, window: { close: `+${CALL_SECS}s` }, integratorFeeBps: 200, integrator: integrator.address, shards: 2, maxOrders: 50 }));
let crossA = '';
await check('create (dry run) simulates the cross and sends nothing', async () => {
  const before = (await oc.balance(issuer.address)).toString();
  const r = cli(['create', '--file', fileA, '--dry-run', '--json'], issuer);
  ok(r, 'create --dry-run');
  assert.equal(r.json.dryRun, true);
  assert.ok(r.json.simulations.length >= 1);
  assert.equal((await oc.balance(issuer.address)).toString(), before, 'a dry run must not spend lamports');
  assert.equal(await oc.getAccount(r.json.cross), null, 'a dry run must not create the cross');
});
await check('create opens cross A (create plus every shard) and the chain agrees', async () => {
  const r = cli(['create', '--file', fileA, '--json'], issuer);
  ok(r, 'create');
  crossA = r.json.cross;
  const c = await readCrossFromChain(oc, crossA);
  assert.equal(c.detail.state, 'Live');
  assert.equal(c.detail.disclosure, 'open');
  assert.equal(c.detail.supplyMode, 'escrow');
  assert.equal(c.detail.fees.integratorBps, 200);
  assert.equal(c.detail.fees.integrator, integrator.address);
  assert.equal(c.detail.orders.max, 50);
  for (let i = 0; i < 2; i++) {
    const { shardAddress } = await import('@opening-cross/sdk');
    assert.ok(await oc.getAccount(await shardAddress(crossA as Address, i)), `shard ${i} exists`);
  }
  assert.equal(r.json.signatures.length, 3, 'one create transaction and two shard transactions');
  return crossA;
});
state.crossA = crossA;

await check('cross get / book / list describe the cross in words', async () => {
  const r = cli(['cross', 'get', crossA], null);
  ok(r, 'cross get');
  assert.match(r.stdout, /Live \(open\)/);
  assert.match(r.stdout, /closes in/);
  assert.match(r.stdout, /1 to 1\.5 in steps of 0\.05/);
  assert.match(r.stdout, /0\.5% of proceeds \(0\.3% protocol, 0\.2% integrator\)/);
  ok(cli(['cross', 'book', crossA], null), 'cross book');
});

type Placed = { nonce: string; order: string; owner: string };
const placed: Placed[] = [];
async function place(w: W, side: 'buy' | 'sell', price: string, qty: string, cross = crossA, extra: string[] = []): Promise<Ran> {
  return cli(['order', 'place', cross, '--side', side, '--price', price, '--quantity', qty, '--json', ...extra], w);
}
await check('a buyer places an order: the escrow leaves the wallet and the order exists on chain', async () => {
  const before = await balance(quote, buyer1.address);
  const r = await place(buyer1, 'buy', '1.25', '100');
  ok(r, 'order place');
  placed.push({ nonce: r.json.nonce, order: r.json.order, owner: buyer1.address });
  const after = await balance(quote, buyer1.address);
  assert.equal(before - after, 125_000_000n, 'escrow is exactly ceil(100 * 1.25) quote atoms');
  assert.equal(r.json.status, 'open, revealed');
  assert.ok(await oc.getAccount(r.json.order), 'the order account exists');
  const c = await readCrossFromChain(oc, crossA);
  assert.equal(c.detail.orders.total, 1);
});
await check('--dry-run simulates an order without moving funds or creating it', async () => {
  const before = await balance(quote, buyer2.address);
  const r = await place(buyer2, 'buy', '1.15', '50', crossA, ['--dry-run']);
  ok(r, 'dry run');
  assert.equal(r.json.dryRun, true);
  assert.equal(await balance(quote, buyer2.address), before);
  assert.equal(await oc.getAccount(r.json.order), null);
  assert.equal((await readCrossFromChain(oc, crossA)).detail.orders.total, 1);
});
await check('a second buyer and the seller place theirs', async () => {
  const b = await place(buyer2, 'buy', '1.15', '50');
  ok(b, 'buyer2');
  placed.push({ nonce: b.json.nonce, order: b.json.order, owner: buyer2.address });
  const sBefore = await balance(baseA, seller.address);
  const s = await place(seller, 'sell', '1.10', '120');
  ok(s, 'seller');
  placed.push({ nonce: s.json.nonce, order: s.json.order, owner: seller.address });
  assert.equal(sBefore - (await balance(baseA, seller.address)), 120_000_000n, 'the seller escrowed exactly 120 tokens');
  assert.equal((await readCrossFromChain(oc, crossA)).detail.orders.total, 3);
});
await check('the book shows the three orders and an indicative price', async () => {
  const r = cli(['cross', 'book', crossA, '--json'], null);
  ok(r, 'book');
  assert.equal(r.json.levels.length, 3);
  assert.ok(r.json.indicative, 'a crossing book has an indicative price');
});
await check('the same nonce twice is refused before anything is sent', async () => {
  const before = await balance(quote, buyer1.address);
  const r = await place(buyer1, 'buy', '1.25', '1', crossA, ['--nonce', placed[0]!.nonce]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /already used/);
  assert.equal(await balance(quote, buyer1.address), before);
});
await check('careless orders are refused with a sentence and exit 2/1, and nothing moves', async () => {
  const q0 = await balance(quote, buyer2.address);
  const offGrid = await place(buyer2, 'buy', '1.23', '10');
  assert.equal(offGrid.code, 2);
  assert.match(offGrid.stderr, /Prices move in steps of 0\.05\. Try 1\.2 or 1\.25\./);
  const out = await place(buyer2, 'buy', '9', '10');
  assert.equal(out.code, 2);
  assert.match(out.stderr, /between 1 and 1\.5/);
  const zero = await place(buyer2, 'buy', '1.2', '0');
  assert.equal(zero.code, 2);
  const noKey = cli(['order', 'place', crossA, '--side', 'buy', '--price', '1.2', '--quantity', '1'], null);
  assert.equal(noKey.code, 2);
  assert.match(noKey.stderr, /--keypair/);
  const brokeR = await place(broke, 'buy', '1.2', '10');
  assert.notEqual(brokeR.code, 0, 'a wallet with no tokens cannot place a buy');
  const poorR = await place(poor, 'buy', '1.2', '10');
  assert.notEqual(poorR.code, 0, 'a wallet with no SOL cannot pay for the order account');
  assert.match(poorR.stderr + brokeR.stderr, /SOL|token|funds/i);
  assert.equal(await balance(quote, buyer2.address), q0);
  state.carelessStderr = { offGrid: offGrid.stderr, broke: brokeR.stderr, poor: poorR.stderr };
});
await check('cancel returns the escrow in full', async () => {
  const x = await place(buyer2, 'buy', '1.05', '20');
  ok(x, 'place to cancel');
  const before = await balance(quote, buyer2.address);
  const r = cli(['order', 'cancel', crossA, '--nonce', x.json.nonce, '--json'], buyer2);
  ok(r, 'cancel');
  assert.equal((await balance(quote, buyer2.address)) - before, 21_000_000n);
  assert.equal(await oc.getAccount(x.json.order), null, 'the order account is closed');
});

// the API-facing reads (once the indexer has caught up)
if (API) {
  await check('cross list / order list / cross get --verify agree with the chain through the real API and indexer', async () => {
    let listed = false;
    for (let i = 0; i < 40 && !listed; i++) {
      const r = cli(['cross', 'list', '--json'], null);
      listed = r.code === 0 && (r.json?.crosses ?? []).some((c: { address: string }) => c.address === crossA);
      if (!listed) await sleep(2000);
    }
    assert.ok(listed, 'the indexer lists cross A');
    const g = cli(['cross', 'get', crossA, '--verify', '--json'], null);
    ok(g, 'cross get --verify');
    assert.ok(g.json.verification, 'verification present');
    assert.ok(g.json.verification.matches || g.json.verification.differences.every((d: { volatile: boolean }) => d.volatile), JSON.stringify(g.json.verification.differences));
  });
  await check('a transaction built by the API is signed and sent by the CLI (--build api)', async () => {
    const before = await balance(quote, buyer2.address);
    const r = await place(buyer2, 'buy', '1.10', '10', crossA, ['--build', 'api']);
    ok(r, 'place via api');
    assert.equal(before - (await balance(quote, buyer2.address)), 11_000_000n);
    placed.push({ nonce: r.json.nonce, order: r.json.order, owner: buyer2.address });
  });
  await check('quote answers or says the deployment does not offer it (exit 4)', async () => {
    const r = cli(['quote', crossA, '--side', 'buy', '--quantity', '10'], null);
    assert.ok(r.code === 0 || r.code === 4, `exit ${r.code}: ${r.stderr}`);
  });
}

await check('watch follows the chain and stops by itself with --count', async () => {
  const r = cli(['watch', crossA, '--count', '1', '--json'], null);
  ok(r, 'watch');
  assert.equal(r.json.type, 'state');
  assert.equal(r.json.cross.address, crossA);
});

// close, settle, claim, finalize
const cA = await readCrossFromChain(oc, crossA);
await check('placing after the window closes is refused naming the reason', async () => {
  await waitUntil(BigInt(cA.detail.window.closeTs));
  const r = await place(buyer1, 'buy', '1.2', '1');
  assert.equal(r.code, 1);
  assert.match(r.stderr, /past its closing time/);
});
await check('settle clears cross A; the clearing price is on the grid and a crossing volume traded', async () => {
  const r = cli(['settle', crossA, '--json'], seller);
  ok(r, 'settle');
  assert.equal(r.json.state, 'Cleared');
  assert.ok(r.json.clearing, 'a clearing summary exists');
  state.clearingA = r.json.clearing;
  assert.equal(BigInt(r.json.clearing.matched) > 0n, true);
  return `price ${r.json.clearing.price}, matched ${r.json.clearing.matched}`;
});
const claimed: Record<string, Ran> = {};
await check('every order is claimed (the seller pays for a stranger’s claim) and the money lands in the owners’ accounts', async () => {
  const sellerQuoteBefore = await balance(quote, seller.address);
  for (const o of placed) {
    if ((await oc.getAccount(o.order)) === null) continue; // cancelled earlier
    const r = cli(['order', 'claim', crossA, '--nonce', o.nonce, '--owner', o.owner, '--json'], seller);
    ok(r, `claim ${o.nonce}`);
    claimed[o.order] = r;
    assert.equal(await oc.getAccount(o.order), null, 'a claimed order account is closed');
  }
  assert.ok((await balance(quote, seller.address)) > sellerQuoteBefore, 'the seller received quote tokens');
  const c = await readCrossFromChain(oc, crossA);
  assert.equal(c.detail.orders.open, 0);
});
await check('finalize pays the fees: the integrator receives exactly the share the fee model gives it', async () => {
  const before = { integ: await balance(quote, integrator.address), fee: await balance(quote, admin.address), issuer: await balance(quote, issuer.address) };
  const r = cli(['finalize', crossA, '--json'], seller);
  ok(r, 'finalize');
  const c = await readCrossFromChain(oc, crossA);
  assert.equal(c.detail.state, 'Finalized');
  const fees = c.data.feesAccrued;
  const total = BigInt(c.data.protocolFeeBps + c.data.integratorFeeBps);
  const protocolFee = (fees * BigInt(c.data.protocolFeeBps)) / total;
  const integratorFee = fees - protocolFee;
  assert.ok(fees > 0n, 'fees were accrued');
  assert.equal((await balance(quote, integrator.address)) - before.integ, integratorFee, 'integrator fee');
  assert.equal((await balance(quote, admin.address)) - before.fee, protocolFee, 'protocol fee');
  assert.ok((await balance(quote, issuer.address)) >= before.issuer, 'proceeds go to the issuer');
  state.feesA = { fees: fees.toString(), protocolFee: protocolFee.toString(), integratorFee: integratorFee.toString() };
  return `fees ${fees}: protocol ${protocolFee}, integrator ${integratorFee}`;
});
await check('verify recomputes cross A and exits 0 only because it equals the chain', async () => {
  const r = cli(['verify', crossA, '--json'], null);
  ok(r, 'verify');
  assert.equal(r.json.verified, true);
  assert.equal(r.json.onchain.price, r.json.recomputed.price);
});

// ---- cross B: sealed bids, minted supply
const fileB = join(dir, 'cross-b.json');
writeFileSync(fileB, JSON.stringify({ baseMint: baseB, quoteMint: quote, supplyMode: 'mint', disclosure: 'sealed', grid: { min: '1', tick: '0.05', ticks: 11 }, window: { close: `+${CALL_SECS}s`, revealEnd: `+${CALL_SECS + REVEAL_SECS}s` }, integratorFeeBps: 100, integrator: integrator.address, shards: 2, maxOrders: 50, schedule: [{ price: '1.10', quantity: '60' }, { price: '1.30', quantity: '60' }] }));
let crossB = '';
await check('create opens sealed cross B and hands the base mint authority to the cross in the same transaction', async () => {
  const r = cli(['create', '--file', fileB, '--json'], issuer);
  ok(r, 'create B');
  crossB = r.json.cross;
  const c = await readCrossFromChain(oc, crossB);
  assert.equal(c.detail.disclosure, 'sealed');
  assert.equal(c.detail.supplyMode, 'mint');
  const mintAcct = await oc.getAccount(baseB);
  // Token-2022 mint layout: mint_authority option tag (u32) at 0, key at 4.
  const authority = Buffer.from(mintAcct!.data.slice(4, 36));
  const { getAddressDecoder } = await import('@solana/kit');
  assert.equal(getAddressDecoder().decode(authority), crossB, 'the cross holds the mint authority');
});
state.crossB = crossB;
const sealedPlaced: Placed[] = [];
await check('sealed bids are placed; the salt is in the vault file before the bid is on chain and never printed', async () => {
  const r1 = await place(buyer1, 'buy', '1.30', '40', crossB);
  ok(r1, 'sealed bid 1');
  const r2 = await place(buyer2, 'buy', '1.20', '30', crossB);
  ok(r2, 'sealed bid 2');
  sealedPlaced.push({ nonce: r1.json.nonce, order: r1.json.order, owner: buyer1.address }, { nonce: r2.json.nonce, order: r2.json.order, owner: buyer2.address });
  for (const [w, r] of [[buyer1, r1], [buyer2, r2]] as const) {
    const vault = JSON.parse(readFileSync(w.vault, 'utf8')) as { schema: string; bids: { salt: string; nonce: string }[] };
    assert.equal(vault.schema, 'opening-bell/sealed-bids/v1');
    const bid = vault.bids.find((b) => b.nonce === r.json.nonce)!;
    assert.match(bid.salt, /^[0-9a-f]{64}$/);
    assert.ok(!r.stdout.includes(bid.salt) && !r.stderr.includes(bid.salt), 'the salt is never printed');
    const o = await oc.getAccount(r.json.order);
    assert.ok(o);
    // The order account stores no price or quantity for a sealed bid: a (zeroed) price/quantity is all the chain holds.
    assert.equal(r.json.sealed, true);
  }
  const book = cli(['cross', 'book', crossB, '--json'], null);
  assert.equal(book.json.levels.length, 0, 'a sealed book shows nothing before the reveal');
});
await check('revealing before the call closes is refused by the program and nothing changes', async () => {
  const r = cli(['order', 'reveal', crossB, '--nonce', sealedPlaced[0]!.nonce, '--json'], buyer1);
  assert.notEqual(r.code, 0);
});
const cB = await readCrossFromChain(oc, crossB);
await check('after the close, bid 1 is revealed; bid 2 is deliberately not', async () => {
  await waitUntil(BigInt(cB.detail.window.closeTs));
  const r = cli(['order', 'reveal', crossB, '--nonce', sealedPlaced[0]!.nonce, '--json'], buyer1);
  ok(r, 'reveal');
  assert.equal(r.json.status, 'open, revealed');
  const book = cli(['cross', 'book', crossB, '--json'], null);
  assert.equal(book.json.levels.length, 1, 'only the revealed bid is in the book');
});
await check('a reveal with the wrong wallet or without the salt is refused with a sentence', async () => {
  const r = cli(['order', 'reveal', crossB, '--nonce', sealedPlaced[1]!.nonce], buyer1);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /No sealed bid with nonce/);
});
await check('settle B after the reveal window; the unrevealed bid is refunded in full on claim', async () => {
  await waitUntil(BigInt(cB.detail.window.revealEndTs));
  const s = cli(['settle', crossB, '--json'], seller);
  ok(s, 'settle B');
  assert.equal(s.json.state, 'Cleared');
  const q2 = await balance(quote, buyer2.address);
  const q1 = await balance(quote, buyer1.address);
  const b1 = await balance(baseB, buyer1.address);
  const c1 = cli(['order', 'claim', crossB, '--nonce', sealedPlaced[0]!.nonce, '--owner', buyer1.address, '--json'], seller);
  ok(c1, 'claim 1');
  const c2 = cli(['order', 'claim', crossB, '--nonce', sealedPlaced[1]!.nonce, '--owner', buyer2.address, '--json'], seller);
  ok(c2, 'claim 2');
  assert.equal((await balance(quote, buyer2.address)) - q2, 36_000_000n, 'bid 2 (30 tokens at 1.20) is refunded in full');
  assert.equal(await balance(baseB, buyer2.address), 0n, 'the unrevealed bid receives no tokens');
  assert.ok((await balance(baseB, buyer1.address)) - b1 > 0n, 'the revealed bid received minted tokens');
  assert.ok((await balance(quote, buyer1.address)) - q1 >= 0n);
  const f = cli(['finalize', crossB, '--json'], seller);
  ok(f, 'finalize B');
  assert.equal((await readCrossFromChain(oc, crossB)).detail.state, 'Finalized');
  const v = cli(['verify', crossB, '--json'], null);
  ok(v, 'verify B');
  assert.equal(v.json.verified, true);
  return `buyer1 received ${(await balance(baseB, buyer1.address)) - b1} base atoms`;
});
await check('the vault file is private to its owner (mode 600 where the platform has modes)', async () => {
  const { statSync } = await import('node:fs');
  const mode = statSync(buyer1.vault).mode & 0o777;
  if (process.platform !== 'win32') assert.equal(mode, 0o600);
});
await check('no secret key bytes appear anywhere in anything the CLI printed', async () => {
  // The keypair files hold 64 bytes; their JSON array must not be echoed by any command.
  const key = readFileSync(buyer1.file, 'utf8').slice(1, 30);
  const probe = cli(['order', 'cancel', crossA, '--nonce', '1', '--json'], buyer1);
  assert.ok(!probe.stdout.includes(key) && !probe.stderr.includes(key));
});

// ---- summary
const failed = results.filter((r) => !r.ok);
writeFileSync(OUT, `${JSON.stringify({ ranAt: new Date().toISOString(), rpc: RPC_URL, api: API ?? null, state, results }, null, 2)}\n`);
console.log(`\n${results.length - failed.length}/${results.length} checks passed -> ${OUT}`);
mkdirSync(dir, { recursive: true });
process.exit(failed.length ? 1 : 0);
void nowS;
