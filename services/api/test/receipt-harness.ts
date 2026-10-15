// A local API for the signed-receipt runs (row S2, ADR-0941): the live devnet API for everything it already serves, plus the receipt attestation route over a database the promiser's receipt
// rounds write. The rounds run for real: receipts are fetched from the web app, checked against the cross accounts on a devnet RPC, signed with a key made for the run, and anchored by a real
// Memo transaction. Nothing here is a stand-in for the thing being tested; the database is PGlite only because no Postgres runs on this machine.
//
//   pnpm --filter @opening-cross/api exec tsx test/receipt-harness.ts
//
// Environment: LIVE_API (default the public deployment), RPC_URL (devnet), WEB_URL (the web app whose /receipt/<cross>/json is attested, default http://localhost:3412),
// PORT (8083), SIGNER_KEYPAIR (a Solana CLI keypair file that signs and pays; a fresh key made for the run when unset, which FUNDER_KEYPAIR then funds),
// FUNDER_KEYPAIR (a devnet keypair file that sends the generated signer 0.05 SOL).
// ALERTS=1 also serves the holder alert routes over the same database (row F5, ADR-0940), with the indexer's treasury tables seeded from the live index's real treasuries and a push key made
// for the run, so apps/web/e2e/w5-1e-alerts-movements.mjs can drive the Alerts page. Insider scans read real balances over RPC_URL.
//
//   POST /__harness/attest   one attestRound            POST /__harness/anchor   one anchorReceiptsRound (writes a Memo transaction)
//   POST /__harness/sql      { sql }                    POST /__harness/exit
import { readFileSync } from 'node:fs';
import cors from '@fastify/cors';
import { PGlite } from '@electric-sql/pglite';
import Fastify from 'fastify';
import {
  type Address,
  type Instruction,
  AccountRole,
  appendTransactionMessageInstructions,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
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
import webpush from 'web-push';
import { MEMO_PROGRAM } from '@opening-cross/promises';
import { registerHolderAlerts } from '../src/routes/holder-alerts.js';
import { loadAlertConfig } from '../src/routes/holder-alerts-channels.js';
import { envRpc } from '../src/routes/holder-alerts-watch.js';
import { type ReceiptDeps, anchorReceiptsRound, attestRound, receiptAttestationAnswer } from '@opening-cross/promiser';

const LIVE = process.env.LIVE_API ?? 'https://98-87-59-136.sslip.io';
const RPC = (process.env.RPC_URL ?? 'https://api.devnet.solana.com').split(',')[0]!;
const WEB = (process.env.WEB_URL ?? 'http://localhost:3412').replace(/\/+$/, '');
const PORT = Number(process.env.PORT ?? 8083);
const CLUSTER = process.env.NETWORK ?? 'devnet';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The public devnet endpoint answers 429 under load; wait it out. */
async function patient<T>(f: () => Promise<T>): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await f();
    } catch (e) {
      const busy = String((e as { context?: { statusCode?: number } }).context?.statusCode ?? e).includes('429') || String(e).includes('429');
      if (!busy || i >= 8) throw e;
      await sleep(1500 * (i + 1));
    }
  }
}

async function live<T>(path: string): Promise<T | null> {
  for (let i = 0; i < 6; i++) {
    const r = await fetch(`${LIVE}${path}`).catch(() => null);
    if (r?.status === 429) {
      await sleep(2500);
      continue;
    }
    return r?.ok ? ((await r.json()) as T) : null;
  }
  return null;
}

// ---- the database: the indexer's own schema, seeded with the settled crosses the live index lists
const migration = (name: string) => readFileSync(new URL(`../../indexer/migrations/${name}`, import.meta.url), 'utf8');
const db = new PGlite();
await db.exec(migration('001_init.sql'));
if (process.env.ALERTS === '1') for (const m of ['006_calendar.sql', '006_treasury.sql', '012_integrity.sql', '017_treasury_ext.sql', '020_settle_markets_and_movements.sql']) await db.exec(migration(m));
type Summary = { address: string; state: string; creator: string; base_mint: string; quote_mint: string; open_ts: string; close_ts: string; reveal_end_ts: string; clearing_price: string | null; matched: string | null; orders_committed: number; created_slot?: string };
const list = await live<{ crosses: Summary[] }>('/v1/crosses?limit=200');
let seeded = 0;
let slot = 0;
for (const c of list?.crosses ?? []) {
  if (c.state !== 'Finalized' && c.state !== 'NoPrint') continue;
  await db.query(
    `INSERT INTO crosses (address, creator, kind, supply_mode, disclosure, base_mint, quote_mint, open_ts, close_ts, reveal_end_ts, protocol_fee_bps, integrator_fee_bps, state, clearing_price, matched, orders_committed, created_slot, updated_slot)
     VALUES ($1, $2, 0, 0, 1, $3, $4, $5, $6, $7, 0, 0, $8, $9, $10, $11, $12, $12) ON CONFLICT DO NOTHING`,
    [c.address, c.creator, c.base_mint, c.quote_mint, c.open_ts, c.close_ts, c.reveal_end_ts, c.state, c.clearing_price, c.matched, c.orders_committed, c.created_slot ?? String(++slot)],
  );
  seeded += 1;
}

// ---- the key that signs and pays
const rpc = createSolanaRpc(RPC);
let signer;
if (process.env.SIGNER_KEYPAIR) signer = await createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(readFileSync(process.env.SIGNER_KEYPAIR, 'utf8'))));
else {
  signer = await generateKeyPairSigner();
  if (!process.env.FUNDER_KEYPAIR) throw new Error('a generated signer has no SOL: set FUNDER_KEYPAIR (a devnet keypair file) or SIGNER_KEYPAIR');
  const funder = await createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(readFileSync(process.env.FUNDER_KEYPAIR, 'utf8'))));
  // A System Program transfer: instruction 2, then the amount in lamports.
  const data = new Uint8Array(12);
  new DataView(data.buffer).setUint32(0, 2, true);
  new DataView(data.buffer).setBigUint64(4, 50_000_000n, true);
  const transfer = { programAddress: '11111111111111111111111111111111' as Address, accounts: [{ address: funder.address, role: AccountRole.WRITABLE_SIGNER, signer: funder }, { address: signer.address, role: AccountRole.WRITABLE }], data } as unknown as Instruction;
  await send(funder, [transfer]);
}
console.log(`receipt signer ${signer.address}`);

async function send(payer: typeof signer, instructions: Instruction[]): Promise<{ signature: string; slot: number | null; blockTime: number | null }> {
  const { value: bh } = await patient(() => rpc.getLatestBlockhash({ commitment: 'confirmed' }).send());
  const tx = await signTransactionMessageWithSigners(pipe(createTransactionMessage({ version: 0 }), (m) => setTransactionMessageFeePayerSigner(payer, m), (m) => setTransactionMessageLifetimeUsingBlockhash(bh, m), (m) => appendTransactionMessageInstructions(instructions, m)));
  const signature = getSignatureFromTransaction(tx);
  await patient(() => rpc.sendTransaction(getBase64EncodedWireTransaction(tx), { encoding: 'base64', preflightCommitment: 'confirmed' }).send());
  for (let i = 0; i < 90; i++) {
    const st = (await patient(() => rpc.getSignatureStatuses([signature]).send())).value[0];
    if (st?.err) throw new Error(`transaction ${signature} failed: ${JSON.stringify(st.err, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))}`);
    if (st && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) {
      const t = await patient(() => rpc.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0, encoding: 'json' }).send());
      return { signature, slot: t ? Number(t.slot) : null, blockTime: t?.blockTime == null ? null : Number(t.blockTime) };
    }
    await sleep(1000);
  }
  throw new Error(`transaction ${signature} not confirmed within 90 s`);
}

// The same transaction the promiser process writes (services/promiser/src/main.ts sendMemo).
async function sendMemo(text: string) {
  const memo: Instruction = { programAddress: MEMO_PROGRAM as Address, accounts: [{ address: signer.address, role: AccountRole.READONLY_SIGNER, signer }], data: new TextEncoder().encode(text) } as unknown as Instruction;
  return send(signer, [memo]);
}

const deps: ReceiptDeps = {
  db,
  cluster: CLUSTER,
  signer,
  read: async (a: Address) => {
    const x = await patient(() => fetchEncodedAccount(rpc, a, { commitment: 'confirmed' }));
    return x.exists ? { data: x.data, owner: x.programAddress } : null;
  },
  now: async () => Number(await patient(async () => rpc.getBlockTime(await rpc.getSlot({ commitment: 'confirmed' }).send()).send())),
  fetchReceipt: async (cross) => {
    const r = await fetch(`${WEB}/receipt/${cross}/json`, { signal: AbortSignal.timeout(60_000) });
    return { status: r.status, text: await r.text(), sha256: r.headers.get('x-receipt-sha256') };
  },
};

// ---- the server
const app = Fastify();
await app.register(cors, { origin: '*', methods: ['GET', 'POST'] });
const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));

// The route as services/api/src/server.ts needs it (ADR-0941): the answer is the promiser package's.
app.get('/v1/crosses/:address/receipt-attestation', async (req, reply) => {
  const a = await receiptAttestationAnswer(db, { cluster: CLUSTER, publishedSigner: signer.address }, (req.params as { address: string }).address, (req.query as { optional?: string }).optional === '1');
  return reply.code(a.status).type('application/json').send(json(a.body));
});
app.get('/v1/promises/signer', async (_req, reply) => reply.type('application/json').send({ schema: 'opening-cross/promise/v1', cluster: CLUSTER, signer: signer.address }));
if (process.env.ALERTS === '1') {
  // The live index's real treasuries, with each one's real events turned into movements by the indexer's own function.
  const { recordMovement } = await import('../../indexer/src/treasury-movements.js');
  const trs = (await live<{ treasuries: { address: string; coinMint: string; authority: string }[] }>('/v1/treasuries'))?.treasuries ?? [];
  for (const t of trs) {
    await db.query(`INSERT INTO treasuries (address, coin_mint, authority, allowance, period_secs, created_signature, created_slot, state, updated_slot) VALUES ($1, $2, $3, 1, 1, 'x', 1, 'Active', 1) ON CONFLICT DO NOTHING`, [t.address, t.coinMint, t.authority]);
    const d = await live<{ events: { signature: string; slot: string; time: number; name: string; details: Record<string, unknown> }[] }>(`/v1/treasuries/${t.address}`);
    let seq = 0;
    for (const e of [...(d?.events ?? [])].reverse()) await recordMovement(db as never, { signature: e.signature, seq: seq++, slot: e.slot, blockTime: String(e.time), treasury: t.address, name: e.name, payload: e.details });
  }
  const keys = webpush.generateVAPIDKeys();
  const env = { ...process.env, VAPID_PUBLIC_KEY: keys.publicKey, VAPID_PRIVATE_KEY: keys.privateKey, VAPID_SUBJECT: 'mailto:alerts@opening-bell.invalid', WEB_URL: WEB, RPC_URL: RPC } as NodeJS.ProcessEnv;
  registerHolderAlerts(app, { db: db as never, config: loadAlertConfig(env), rpc: envRpc(env), run: true, intervalMs: 3000 });
  console.log(`alerts on: ${trs.length} live treasuries seeded`);
}
app.post('/__harness/attest', async () => attestRound(deps));
app.post('/__harness/anchor', async () => anchorReceiptsRound(deps, sendMemo));
app.post('/__harness/sql', async (req) => (await db.query((req.body as { sql: string }).sql)).rows);
app.post('/__harness/exit', async (_req, reply) => {
  setTimeout(() => process.exit(0), 50);
  return reply.send({ exiting: true });
});

// Everything else is the live API.
app.setNotFoundHandler(async (req, reply) => {
  const r = await fetch(`${LIVE}${req.url}`).catch(() => null);
  if (!r) return reply.code(502).send({ error: 'the live API could not be reached' });
  reply.code(r.status).type(r.headers.get('content-type') ?? 'application/json');
  const retry = r.headers.get('retry-after');
  if (retry) reply.header('retry-after', retry);
  return reply.send(Buffer.from(await r.arrayBuffer()));
});

await app.listen({ port: PORT, host: '127.0.0.1' });
console.log(`receipt harness on http://127.0.0.1:${PORT} (web ${WEB}, live ${LIVE}, ${seeded} settled crosses seeded, RPC ${RPC})`);
