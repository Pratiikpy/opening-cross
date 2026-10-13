// The preset registry on real devnet. A preset is published (signed by the ops key), a real cross is created on devnet with the
// preset's memo in its creation transaction, the indexer reads the cross into a scratch database, and the registry attributes the cross
// to the preset by reading the memo back from the chain. A second cross, created without the memo, must not be attributed.
//
//   DATABASE_URL=postgres://... OPS_KEYPAIR=<ops key> BASE_MINT=<mint> QUOTE_MINT=<mint> tsx scripts/presets-devnet.ts
import { readFileSync } from 'node:fs';
import Fastify from 'fastify';
import pg from 'pg';
import {
  type Address,
  type Instruction,
  address,
  appendTransactionMessageInstructions,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  signature as toSignature,
} from '@solana/kit';
import { getAddMemoInstruction } from '@solana-program/memo';
import { TOKEN_2022_PROGRAM_ADDRESS } from '@solana-program/token-2022';
import { CrossKind, Disclosure, SupplyMode, buildCreateCross } from '@opening-cross/sdk';
import { keyPairFromSolanaFile, signDocument } from '@opening-cross/attest';
import { createIndexerRpc, migrate, pollOnce } from '@opening-cross/indexer';
import { PRESET_SCHEMA, presetMemo } from '@opening-cross/preset-registry';
import { registerPresets } from '../src/routes/presets.js';

const RPC = process.env.RPC_URL ?? 'https://api.devnet.solana.com';
process.env.RPC_URL = RPC;
const BASE = address(process.env.BASE_MINT ?? '9YqqWubArnofUWPP5GsXYGrofeHXjQPHm7kL513gHKv7');
const QUOTE = address(process.env.QUOTE_MINT ?? '3p4zaqbp7EgV1pc1wf9aw7YseY5UrvibpmpX7n7AFXZE');
const rpc = createSolanaRpc(RPC);
const raw = readFileSync(process.env.OPS_KEYPAIR ?? '', 'utf8');
const ops = await createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(raw) as number[]));
const { keyPair } = await keyPairFromSolanaFile(raw);

/** The public devnet endpoint answers bursts with 429: wait and ask again. */
async function retry<T>(fn: () => Promise<T>): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= 8 || !/429|Too Many/.test(String(e))) throw e;
      await new Promise((r) => setTimeout(r, 1_500 * (i + 1)));
    }
  }
}

async function send(ixs: Instruction[]): Promise<string> {
  const { value: bh } = await retry(() => rpc.getLatestBlockhash({ commitment: 'confirmed' }).send());
  const tx = await signTransactionMessageWithSigners(pipe(createTransactionMessage({ version: 0 }), (m) => setTransactionMessageFeePayerSigner(ops, m), (m) => setTransactionMessageLifetimeUsingBlockhash(bh, m), (m) => appendTransactionMessageInstructions(ixs, m)));
  await retry(() => rpc.sendTransaction(getBase64EncodedWireTransaction(tx), { encoding: 'base64', preflightCommitment: 'confirmed' }).send());
  const sig = getSignatureFromTransaction(tx);
  for (let i = 0; i < 90; i++) {
    const st = (await retry(() => rpc.getSignatureStatuses([toSignature(sig)]).send())).value[0];
    if (st?.err) throw new Error(`${sig} failed: ${JSON.stringify(st.err, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))}`);
    if (st?.confirmationStatus === 'confirmed' || st?.confirmationStatus === 'finalized') return sig;
    await new Promise((r) => setTimeout(r, 1_000));
  }
  throw new Error(`${sig} not confirmed`);
}

const fields = { kind: 'reopen', disclosure: 'open', supplyMode: 'escrow', ticks: 41, stepBps: 500, openInMinutes: 0, callMinutes: 5, revealMinutes: 0, maxOrders: 1000 } as const;
const preset = await signDocument({ schema: PRESET_SCHEMA, id: 'open-reopen-5m', version: 1, author: ops.address, name: 'Open reopen, five minutes', summary: 'An open reopen with forty-one price levels and a five minute call.', fields, royaltyBps: 0, tags: ['reopen'], createdAt: Math.floor(Date.now() / 1000) }, keyPair);

async function createCross(memo: string | null): Promise<{ cross: Address; signature: string }> {
  const now = BigInt((await retry(async () => rpc.getBlockTime(await rpc.getSlot({ commitment: 'confirmed' }).send()).send())) as bigint | number);
  const built = await buildCreateCross({
    creator: ops,
    baseMint: BASE,
    quoteMint: QUOTE,
    baseTokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
    quoteTokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
    crossId: BigInt(Date.now()),
    kind: CrossKind.Reopen,
    supplyMode: SupplyMode.Escrow,
    disclosure: Disclosure.Open,
    minPrice: 1_000_000n,
    tick: 50_000n,
    ticks: fields.ticks,
    priceScale: 1_000_000n,
    openTs: now,
    closeTs: now + BigInt(fields.callMinutes * 60),
    revealEndTs: now + BigInt(fields.callMinutes * 60),
    referencePrice: 1_550_000n,
    minMatched: 1n,
    maxImbalanceBps: null,
    integratorFeeBps: 0,
    integrator: ops.address,
    gateMint: null,
    shards: 2,
    maxOrders: fields.maxOrders,
    proceedsTo: ops.address,
    schedule: [],
    oracle: null,
    calendar: null,
    settler: null,
    settleDeadlineTs: 0n,
  });
  const signature = await send([built.create, ...(memo ? [getAddMemoInstruction({ memo })] : [])]);
  for (const s of built.shards) await send([s]);
  return { cross: built.cross, signature };
}

const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
await migrate(db);
for (const t of ['preset_uses', 'presets', 'events', 'orders', 'crosses', 'cursors']) await db.query(`DELETE FROM ${t}`);
const app = Fastify();
registerPresets(app, { db, network: 'devnet' }, { minimumSample: 1 });
await app.ready();
const call = async (method: 'GET' | 'POST', url: string, payload?: unknown) => {
  const r = await app.inject({ method, url, ...(payload === undefined ? {} : { payload: payload as never }) });
  return { status: r.statusCode, body: r.json() };
};

console.log(JSON.stringify({ step: 'publish', ...(await call('POST', '/v1/presets', preset)) }));
const memo = presetMemo(ops.address, 'open-reopen-5m', 1);
const withMemo = await createCross(memo);
const without = await createCross(null);
console.log(JSON.stringify({ step: 'crosses created on devnet', withMemo, withoutMemo: without, memo }));
for (const c of [withMemo.cross, without.cross]) await pollOnce(db, createIndexerRpc(RPC), c, `preset-run:${c}`);

const perf = await call('GET', `/v1/presets/${ops.address}/open-reopen-5m/performance`);
console.log(JSON.stringify({ step: 'performance', status: perf.status, crosses: perf.body.crosses, finished: perf.body.finished, headline: perf.body.headline, attribution: perf.body.attribution }));
const uses = (await db.query('SELECT cross_address, preset_id, version, signature FROM preset_uses ORDER BY cross_address')).rows;
console.log(JSON.stringify({ step: 'what was attributed', attributed: uses.filter((u) => u.preset_id).map((u) => u.cross_address), notAttributed: uses.filter((u) => !u.preset_id).map((u) => u.cross_address), rows: uses.length }));
const ok = perf.body.crosses === 1 && uses.find((u) => u.cross_address === withMemo.cross)?.preset_id === 'open-reopen-5m' && uses.find((u) => u.cross_address === without.cross)?.preset_id === null;
console.log(JSON.stringify({ verdict: ok ? 'PASS: the cross with the memo is attributed from the chain, the one without is not' : 'FAIL' }));
await app.close();
await db.end();
process.exit(ok ? 0 : 1);
