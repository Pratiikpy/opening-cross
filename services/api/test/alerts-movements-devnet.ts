// Insider alerts against real devnet (row F5, ADR-0940): the scan reads a real token's balances over RPC, a real transfer moves part of the creator's holding out, and the next scan
// records the fall and writes the alert. Nothing on chain is faked; the database is PGlite seeded with the cross the live index lists for the token.
//
//   pnpm --filter @opening-cross/api exec tsx test/alerts-movements-devnet.ts
// Environment: RPC_URL (devnet), LIVE_API, HOLDER_KEYPAIR (the Solana CLI keypair file of the cross creator that holds the token), CROSS (the cross address), PERCENT (default 3).
// The tokens go to a fresh wallet and come back at the end. With TRANSFER_ONLY=1 the script only makes the transfer, waits HOLD_SECONDS (default 90) and returns the tokens, so a browser
// run can watch the alert appear (apps/web/e2e/w5-1e-alerts-movements.mjs).
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import {
  type Address,
  type Instruction,
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
import { TOKEN_2022_PROGRAM_ADDRESS, findAssociatedTokenPda, getCreateAssociatedTokenIdempotentInstructionAsync, getTransferCheckedInstruction } from '@solana-program/token-2022';
import { describeMovement, itemsFor } from '../src/routes/holder-alerts-core.js';
import { alertStore } from '../src/routes/holder-alerts-store.js';
import { balanceOfWallet, envRpc, insidersOf, readMint, scanMint } from '../src/routes/holder-alerts-watch.js';

const LIVE = process.env.LIVE_API ?? 'https://98-87-59-136.sslip.io';
const RPC_URL = (process.env.RPC_URL ?? 'https://api.devnet.solana.com').split(',')[0]!;
process.env.RPC_URL = RPC_URL;
const CROSS = process.env.CROSS ?? '2VpFruARynmeEmaxDSh253TB1aLP2nA3945Yzz5hK29H';
const PERCENT = BigInt(process.env.PERCENT ?? '3');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const patient = async <T>(f: () => Promise<T>): Promise<T> => {
  for (let i = 0; ; i++) {
    try {
      return await f();
    } catch (e) {
      if (!String(e).includes('429') || i >= 8) throw e;
      await sleep(1500 * (i + 1));
    }
  }
};

const rpc = createSolanaRpc(RPC_URL);
const chain = envRpc()!;
const holder = await createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(readFileSync(process.env.HOLDER_KEYPAIR ?? 'C:/Users/prate/col/.keys/opening-bell-devnet.json', 'utf8'))));

async function send(payer: typeof holder, instructions: Instruction[]): Promise<string> {
  const { value: bh } = await patient(() => rpc.getLatestBlockhash({ commitment: 'confirmed' }).send());
  const tx = await signTransactionMessageWithSigners(pipe(createTransactionMessage({ version: 0 }), (m) => setTransactionMessageFeePayerSigner(payer, m), (m) => setTransactionMessageLifetimeUsingBlockhash(bh, m), (m) => appendTransactionMessageInstructions(instructions, m)));
  const signature = getSignatureFromTransaction(tx);
  await patient(() => rpc.sendTransaction(getBase64EncodedWireTransaction(tx), { encoding: 'base64', preflightCommitment: 'confirmed' }).send());
  for (let i = 0; i < 90; i++) {
    const st = (await patient(() => rpc.getSignatureStatuses([signature]).send())).value[0];
    if (st?.err) throw new Error(`transaction ${signature} failed`);
    if (st && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) return signature;
    await sleep(1000);
  }
  throw new Error(`transaction ${signature} not confirmed`);
}

// ---- the cross the live index lists, so the alert can link to it and the creator is a known insider
const cross = (await (await fetch(`${LIVE}/v1/crosses/${CROSS}`)).json()) as { address: string; creator: string; base_mint?: string; baseMint?: string; state: string; quote_mint?: string; quoteMint?: string };
const mint = (cross.base_mint ?? cross.baseMint)!;
console.log(`cross ${CROSS} sells token ${mint}, created by ${cross.creator}; the holder key is ${holder.address}`);
if (cross.creator !== holder.address) throw new Error('the holder key is not the creator of this cross');

const db = new PGlite();
const migration = (n: string) => readFileSync(new URL(`../../indexer/migrations/${n}`, import.meta.url), 'utf8');
await db.exec(migration('001_init.sql'));
await db.exec(migration('006_calendar.sql'));
await db.query(
  `INSERT INTO crosses (address, creator, kind, supply_mode, disclosure, base_mint, quote_mint, open_ts, close_ts, reveal_end_ts, protocol_fee_bps, integrator_fee_bps, state, created_slot, updated_slot)
   VALUES ($1, $2, 0, 0, 1, $3, $4, 0, 1, 1, 0, 0, $5, 1, 1)`,
  [CROSS, cross.creator, mint, (cross.quote_mint ?? cross.quoteMint) ?? 'Quote', cross.state],
);
const store = alertStore(db);

const info = (await readMint(chain, mint))!;
console.log(`supply ${info.supply} (${info.decimals} decimals), mint authority ${info.mintAuthority}`);
const insiders = await insidersOf(store, chain, mint, info.mintAuthority);
console.log('insiders', JSON.stringify(insiders, null, 1));

const amount = (info.supply * PERCENT) / 100n;
const recipient = await generateKeyPairSigner();
const tokenProgram = TOKEN_2022_PROGRAM_ADDRESS;
const [fromAta] = await findAssociatedTokenPda({ owner: holder.address, mint: mint as Address, tokenProgram });
const [toAta] = await findAssociatedTokenPda({ owner: recipient.address, mint: mint as Address, tokenProgram });
/** A real transfer out of the creator's holding to a fresh wallet. */
const moveOut = async () =>
  send(holder, [
    await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: holder, owner: recipient.address, mint: mint as Address, tokenProgram }),
    getTransferCheckedInstruction({ source: fromAta, mint: mint as Address, destination: toAta, authority: holder, amount, decimals: info.decimals }, { programAddress: tokenProgram }),
  ]);
/** The creator pays the fee; the fresh wallet signs as the owner of the tokens. */
const moveBack = () => send(holder, [getTransferCheckedInstruction({ source: toAta, mint: mint as Address, destination: fromAta, authority: recipient, amount, decimals: info.decimals }, { programAddress: tokenProgram })]);

if (process.env.TRANSFER_ONLY === '1') {
  const tx = await moveOut();
  console.log(`TRANSFERRED ${amount} (${PERCENT}%) of ${mint} out of ${holder.address}: ${tx}`);
  await sleep(Number(process.env.HOLD_SECONDS ?? 90) * 1000);
  console.log('RETURNED', await moveBack());
  process.exit(0);
}

const t0 = Math.floor(Date.now() / 1000);
const first = await scanMint(store, chain, mint, { now: t0 });
console.log('first scan', JSON.stringify({ ...first, recorded: first.recorded.length }));

// ---- a real transfer out of the creator's holding
const out = await moveOut();
console.log(`moved ${amount} (${PERCENT}%) to ${recipient.address}: ${out}`);
console.log('creator balance now', (await patient(() => balanceOfWallet(chain, holder.address, mint))).toString());

const second = await scanMint(store, chain, mint, { now: t0 + 61 });
console.log('second scan', JSON.stringify(second, null, 1));
const m = second.recorded[0];
if (!m) throw new Error('the scan recorded no movement');
const items = itemsFor({ wallet: null, topics: ['insider'], watch: [CROSS], since: t0 }, { crosses: new Map(), orders: [], calendars: [], movements: await store.walletMovements([mint], 0), scope: await store.scopes([CROSS]) }, t0 + 62);
console.log('alert item', JSON.stringify(items, null, 1));
console.log(describeMovement(m).title);
console.log('transfer signature', out, 'newest transaction recorded', m.latestTx);

// ---- put the tokens back
console.log('returned', await moveBack(), 'creator balance', (await patient(() => balanceOfWallet(chain, holder.address, mint))).toString());

// ---- treasury payouts: the real events of a real devnet treasury, turned into movements by the indexer's own function, read by the alert layer
{
  const TREASURY = process.env.TREASURY ?? '3SeQFrJ9X3NzNeJzzPFBTGeaE9qvxcsGrNxy4Hidavsw';
  const { recordMovement } = await import('../../indexer/src/treasury-movements.js');
  for (const n of ['006_treasury.sql', '017_treasury_ext.sql', '020_settle_markets_and_movements.sql']) await db.exec(migration(n));
  const t = (await (await fetch(`${LIVE}/v1/treasuries/${TREASURY}`)).json()) as { terms: { authority: string; coinMint: string }; events: { signature: string; slot: string; time: number; name: string; details: Record<string, unknown> }[] };
  await db.query(`INSERT INTO treasuries (address, coin_mint, authority, allowance, period_secs, created_signature, created_slot, state, updated_slot) VALUES ($1, $2, $3, 1, 1, 'x', 1, 'Active', 1)`, [TREASURY, t.terms.coinMint, t.terms.authority]);
  let seq = 0;
  let written = 0;
  for (const e of [...t.events].reverse()) if (await recordMovement(db as never, { signature: e.signature, seq: seq++, slot: e.slot, blockTime: String(e.time), treasury: TREASURY, name: e.name, payload: e.details })) written += 1;
  console.log(`treasury ${TREASURY}: ${t.events.length} events, ${written} move value`);
  const rows = await store.treasuryOutflows([TREASURY], 0);
  for (const r of rows) console.log(`  ${new Date(r.at * 1000).toISOString()}  ${describeMovement(r).title}: ${describeMovement(r).body}`);
  const newest = Math.max(...rows.map((r) => r.at));
  const feed = itemsFor({ wallet: null, topics: ['treasury'], watch: [TREASURY] }, { crosses: new Map(), orders: [], calendars: [], movements: rows, scope: await store.scopes([TREASURY]) }, newest + 600, 86_400, 86_400);
  console.log(`as of ${new Date((newest + 600) * 1000).toISOString()} the feed holds ${feed.length} treasury items`);
}
