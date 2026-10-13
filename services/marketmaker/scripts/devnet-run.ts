// A real run of the market-maker bot on devnet, through the deployed API.
//
//   tsx scripts/devnet-run.ts setup      create two test mints, a funded maker wallet and a funded taker wallet
//   tsx scripts/devnet-run.ts create     open a reopen-kind escrow cross for the pair (issuer key = the devnet operations key)
//   tsx scripts/devnet-run.ts bot        run the bot's passes until the cross has closed and its orders are claimed
//   tsx scripts/devnet-run.ts taker      place the outside buyer's (or seller's) order into the cross
//   tsx scripts/devnet-run.ts settle     clear, finalize and print the result
//
// State lives in `.keys/mm-run.json` (git-ignored). Keys are Solana CLI keypair files under `.keys`. Nothing here touches a
// wallet that holds real funds: the issuer is the devnet operations key and the other wallets are generated for this run.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type Address,
  type Instruction,
  type KeyPairSigner,
  appendTransactionMessageInstructions,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createTransactionMessage,
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
  TOKEN_2022_PROGRAM_ADDRESS,
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstruction,
  getInitializeMint2Instruction,
  getMintSize,
  getMintToInstruction,
} from '@solana-program/token-2022';
import { createApiClient, createRpcClient, signSendConfirm } from '@opening-cross/client';
import { loadKeypairSigner } from '@opening-cross/client/node';
import { MarketMaker } from '../src/bot.js';
import { fileStore, makeApi, makeChain, makeLog } from '../src/runtime.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../../..');
const KEYS = join(ROOT, '.keys');
const API = process.env.API_URL ?? 'https://98-87-59-136.sslip.io';
const RPC = process.env.RPC_URL ?? 'https://api.devnet.solana.com';
const ISSUER = join(KEYS, 'opening-bell-devnet.json');
const RUN = join(KEYS, 'mm-run.json');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const show = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));

type Run = { baseMint?: string; quoteMint?: string; maker?: string; taker?: string; cross?: string; closeTs?: number };
const load = (): Run => (existsSync(RUN) ? (JSON.parse(readFileSync(RUN, 'utf8')) as Run) : {});
const save = (r: Run) => writeFileSync(RUN, JSON.stringify(r, null, 2));

const rpc = createSolanaRpc(RPC);

async function send(ixs: Instruction[], payer: KeyPairSigner): Promise<string> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const { value: blockhash } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send();
    const tx = await signTransactionMessageWithSigners(
      pipe(
        createTransactionMessage({ version: 0 }),
        (m) => setTransactionMessageFeePayerSigner(payer, m),
        (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
        (m) => appendTransactionMessageInstructions(ixs, m),
      ),
    );
    const signature = getSignatureFromTransaction(tx);
    await rpc.sendTransaction(getBase64EncodedWireTransaction(tx), { encoding: 'base64', preflightCommitment: 'confirmed' }).send();
    for (let i = 0; i < 40; i++) {
      const st = (await rpc.getSignatureStatuses([signature]).send()).value[0];
      if (st?.err) throw new Error(`transaction ${signature} failed: ${show(st.err)}`);
      if (st && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) return signature;
      await sleep(1_500);
    }
  }
  throw new Error('not confirmed');
}

async function fileKey(path: string) {
  if (existsSync(path)) return createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(readFileSync(path, 'utf8')) as number[]));
  const pair = (await webcrypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])) as CryptoKeyPair;
  const secret = Buffer.from(await webcrypto.subtle.exportKey('pkcs8', pair.privateKey)).subarray(-32);
  const pub = Buffer.from(await webcrypto.subtle.exportKey('raw', pair.publicKey));
  const bytes = Uint8Array.from([...secret, ...pub]);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify([...bytes]));
  return createKeyPairSignerFromBytes(bytes);
}

const ata = async (owner: Address, mint: Address) => (await findAssociatedTokenPda({ owner, mint, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS }))[0];

async function setup() {
  const issuer = await fileKey(ISSUER);
  const maker = await fileKey(join(KEYS, 'mm-devnet.json'));
  const taker = await fileKey(join(KEYS, 'mm-taker-devnet.json'));
  const run = load();
  if (run.baseMint) throw new Error(`already set up: ${show(run)}`);
  const space = BigInt(getMintSize());
  const rent = await rpc.getMinimumBalanceForRentExemption(space).send();
  const base = await generateKeyPairSigner();
  const quote = await generateKeyPairSigner();
  for (const m of [base, quote]) {
    await send([
      getCreateAccountInstruction({ payer: issuer, newAccount: m, lamports: rent, space, programAddress: TOKEN_2022_PROGRAM_ADDRESS }),
      getInitializeMint2Instruction({ mint: m.address, decimals: 6, mintAuthority: issuer.address }),
    ], issuer);
  }
  const mk = async (owner: Address, mint: Address, amount: bigint) => {
    const to = await ata(owner, mint);
    return [getCreateAssociatedTokenIdempotentInstruction({ payer: issuer, ata: to, owner, mint, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS }), getMintToInstruction({ mint, token: to, mintAuthority: issuer, amount })];
  };
  // The maker holds both tokens; the taker holds quote to buy with and base to sell with; the issuer needs its own quote account for fees.
  await send([...(await mk(maker.address, base.address, 500_000_000n)), ...(await mk(maker.address, quote.address, 1_000_000_000n))], issuer);
  await send([...(await mk(taker.address, base.address, 100_000_000n)), ...(await mk(taker.address, quote.address, 500_000_000n))], issuer);
  const fund = (to: Address, lamports: bigint) => getTransferSolInstruction({ source: issuer, destination: to, amount: lamports });
  await send([fund(maker.address, 40_000_000n), fund(taker.address, 15_000_000n)], issuer);
  save({ baseMint: base.address, quoteMint: quote.address, maker: maker.address, taker: taker.address });
  console.log(show({ step: 'setup', baseMint: base.address, quoteMint: quote.address, maker: maker.address, taker: taker.address }));
}

function cli(args: string[]) {
  const bin = join(ROOT, 'packages/cli/src/bin.ts');
  const r = spawnSync(process.execPath, ['--import', 'tsx', bin, ...args], { encoding: 'utf8', cwd: join(ROOT, 'packages/cli') });
  process.stdout.write(r.stdout);
  process.stderr.write(r.stderr);
  if (r.status !== 0) throw new Error(`opening-cross ${args[0]} exited ${r.status}`);
  return r.stdout;
}

/** The create instruction takes the cross's dust bond (max orders x highest price, a few thousand atoms) from the issuer's quote account. */
async function fundIssuer() {
  const run = load();
  const issuer = await fileKey(ISSUER);
  const to = await ata(issuer.address, run.quoteMint as Address);
  const sig = await send([getCreateAssociatedTokenIdempotentInstruction({ payer: issuer, ata: to, owner: issuer.address, mint: run.quoteMint as Address, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS }), getMintToInstruction({ mint: run.quoteMint as Address, token: to, mintAuthority: issuer, amount: 10_000_000n })], issuer);
  console.log(show({ step: 'fund-issuer', signature: sig }));
}

async function create(minutes = 7) {
  const run = load();
  if (!run.baseMint || !run.quoteMint) throw new Error('run setup first');
  const file = join(KEYS, 'mm-cross.json');
  writeFileSync(file, JSON.stringify({
    baseMint: run.baseMint, quoteMint: run.quoteMint, kind: 'reopen', supplyMode: 'escrow', disclosure: 'open',
    grid: { min: '1.00', tick: '0.05', ticks: 41 }, window: { open: 'now', close: `+${minutes}m` }, shards: 2, maxOrders: 1000,
  }));
  const out = cli(['create', '--file', file, '--keypair', ISSUER, '--cluster', 'devnet', '--rpc', RPC, '--api', API, '--json']);
  const j = JSON.parse(out.slice(out.indexOf('{'))) as { cross: string };
  const rpcc = createRpcClient({ url: RPC });
  save({ ...run, cross: j.cross, closeTs: Number(await rpcc.unixTime()) + minutes * 60 });
  console.log(show({ step: 'create', cross: j.cross }));
}

async function bot(maxMs: number) {
  const run = load();
  if (!run.cross || !run.maker) throw new Error('run create first');
  const log = makeLog(join(KEYS, 'mm-run.log'));
  const cfg = {
    rpcUrl: RPC, keypairPath: join(KEYS, 'mm-devnet.json'), dryRun: process.env.MM_DRY_RUN === '1',
    strategy: { halfSpreadBps: 200, levels: 2, stepBps: 100, quoteBudget: 400_000_000n, baseBudget: 200_000_000n, minSecondsLeft: 45 },
    creators: new Set<string>(), kinds: new Set(['reopen', 'recurring', 'tender'] as const), fairValues: new Map([[run.baseMint!, '1.5']]), maxOpenCrosses: 3,
  };
  const { chain, owner } = await makeChain(cfg, log);
  if (owner !== run.maker) throw new Error('the maker key does not match the run state');
  // Other people's test crosses share this devnet: the run quotes into its own cross only.
  const real = makeApi(API);
  const api = { ...real, listCrosses: async (o: Parameters<typeof real.listCrosses>[0]) => (await real.listCrosses(o)).filter((c) => o.state !== 'Live' || c.address === run.cross) };
  const mm = new MarketMaker({ cfg, owner, api, chain, sealSecret: null, store: fileStore(join(KEYS, 'mm-run-state.json')), log });
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const r = await mm.pass();
    const done = r.claimed > 0 || (await createApiClient({ baseUrl: API }).getCross(run.cross!)).state === 'Finalized';
    if (done && Date.now() > (run.closeTs ?? 0) * 1000) break;
    await sleep(12_000);
  }
  const v = await mm.volume();
  console.log(show({ step: 'volume', ...v }));
}

async function takerOrder(side: 'buy' | 'sell', priceText: string, qtyText: string) {
  const run = load();
  if (!run.cross) throw new Error('run create first');
  const taker = await loadKeypairSigner(join(KEYS, 'mm-taker-devnet.json'));
  const api = createApiClient({ baseUrl: API });
  const d = await api.getCross(run.cross);
  const price = BigInt(Math.round(Number(priceText) * 1e6)) * BigInt(d.grid.priceScale) / 1_000_000n;
  const quantity = BigInt(Math.round(Number(qtyText) * 1e6));
  const built = await api.tx.placeOrder({ cross: run.cross, owner: taker.address, side, price: price.toString(), quantity: quantity.toString(), nonce: String(Date.now()) });
  const sigs = await signSendConfirm(built.transactions, { rpc: createRpcClient({ url: RPC }), sign: taker.sign });
  console.log(show({ step: 'taker', side, price, quantity, signatures: sigs }));
}

/** The outside buyer claims its own fill (anyone may send it; the proceeds always go to the order's owner). */
async function claimTaker() {
  const run = load();
  if (!run.cross) throw new Error('run create first');
  const taker = await loadKeypairSigner(join(KEYS, 'mm-taker-devnet.json'));
  const api = createApiClient({ baseUrl: API });
  const mine = await api.ownerOrders(taker.address);
  const lookups = await api.orders(mine.filter((o) => o.cross_address === run.cross && o.status !== 'claimed').map((o) => o.address));
  for (const l of lookups) {
    if (!l.found || !l.open) continue;
    const built = await api.tx.claim({ cross: run.cross, owner: taker.address, nonce: l.nonce });
    const sigs = await signSendConfirm(built.transactions, { rpc: createRpcClient({ url: RPC }), sign: taker.sign });
    console.log(show({ step: 'claim-taker', nonce: l.nonce, signatures: sigs }));
  }
}

async function settle() {
  const run = load();
  if (!run.cross) throw new Error('run create first');
  const out = cli(['settle', run.cross, '--keypair', ISSUER, '--cluster', 'devnet', '--rpc', RPC, '--api', API]);
  void out;
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'setup') await setup();
else if (cmd === 'fund-issuer') await fundIssuer();
else if (cmd === 'create') await create(Number(rest[0] ?? 7));
else if (cmd === 'bot') await bot(Number(rest[0] ?? 600_000));
else if (cmd === 'taker') await takerOrder(rest[0] === 'sell' ? 'sell' : 'buy', rest[1] ?? '1.60', rest[2] ?? '100');
else if (cmd === 'claim-taker') await claimTaker();
else if (cmd === 'settle') await settle();
else if (cmd === 'finalize') cli(['finalize', load().cross!, '--keypair', ISSUER, '--cluster', 'devnet', '--rpc', RPC, '--api', API]);
else {
  console.error('usage: tsx scripts/devnet-run.ts setup | create | bot [ms] | taker buy|sell <price> <quantity> | settle');
  process.exit(2);
}
