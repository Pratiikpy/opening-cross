// Promiser process.
//   DATABASE_URL, RPC_URL, NETWORK             required (NETWORK names the cluster: devnet, mainnet-beta, localnet)
//   PROMISE_KEYPAIR                            Solana CLI JSON keypair that signs promises and pays anchor fees
//   ROUND_MS (10000), ANCHOR_EVERY_MS (600000) cadence
//   RECEIPT_URL (or WEB_URL)                   base URL of the web app. With it the promiser also signs and anchors the receipt of every cross that has settled for good
//                                              (ADR-0941); without it that part is off and says so. RECEIPT_PER_ROUND (20), RECEIPT_RECHECK_MS (21600000)
// The signing key is published by the API; promises signed by any other key are not ours.
import { readFileSync } from 'node:fs';
import {
  type Address,
  type Instruction,
  AccountRole,
  appendTransactionMessageInstructions,
  createKeyPairSignerFromBytes,
  createTransactionMessage,
  fetchEncodedAccount,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from '@solana/kit';
import pg from 'pg';
import { CROSS_CORE_PROGRAM_ADDRESS } from '@opening-cross/cross-core-client';
import { createIndexerRpc } from '@opening-cross/indexer';
import { MEMO_PROGRAM } from '@opening-cross/promises';
import { anchorReceiptsRound, attestRound, type ReceiptDeps } from './receipt-round.js';
import { anchorRound, gradeRound, issueRound, type Deps } from './service.js';

const { DATABASE_URL, RPC_URL, NETWORK, PROMISE_KEYPAIR } = process.env;
if (!DATABASE_URL || !RPC_URL || !NETWORK || !PROMISE_KEYPAIR) {
  console.error('DATABASE_URL, RPC_URL, NETWORK and PROMISE_KEYPAIR are required');
  process.exit(2);
}
const roundMs = Number(process.env.ROUND_MS ?? 10_000);
const anchorMs = Number(process.env.ANCHOR_EVERY_MS ?? 600_000);

const rpc = createIndexerRpc(RPC_URL);
const signer = await createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(readFileSync(PROMISE_KEYPAIR, 'utf8'))));
const deps: Deps = {
  db: new pg.Pool({ connectionString: DATABASE_URL }),
  cluster: NETWORK,
  program: CROSS_CORE_PROGRAM_ADDRESS,
  signer,
  read: async (a: Address) => {
    const x = await fetchEncodedAccount(rpc, a, { commitment: 'confirmed' });
    return x.exists ? { data: x.data, owner: x.programAddress } : null;
  },
  now: async () => Number(await rpc.getBlockTime(await rpc.getSlot({ commitment: 'confirmed' }).send()).send()),
};

const receiptBase = (process.env.RECEIPT_URL ?? process.env.WEB_URL ?? '').replace(/\/+$/, '');
const receipts: ReceiptDeps | null = receiptBase
  ? {
      db: deps.db,
      cluster: NETWORK,
      signer,
      read: deps.read,
      now: deps.now,
      perRound: Number(process.env.RECEIPT_PER_ROUND ?? 20),
      recheckAfterSeconds: Number(process.env.RECEIPT_RECHECK_MS ?? 21_600_000) / 1000,
      fetchReceipt: async (cross) => {
        const r = await fetch(`${receiptBase}/receipt/${cross}/json`, { signal: AbortSignal.timeout(30_000) });
        return { status: r.status, text: await r.text(), sha256: r.headers.get('x-receipt-sha256') };
      },
    }
  : null;

async function sendMemo(text: string) {
  const memo: Instruction = { programAddress: MEMO_PROGRAM as Address, accounts: [{ address: signer.address, role: AccountRole.READONLY_SIGNER, signer }], data: new TextEncoder().encode(text) } as unknown as Instruction;
  const { value: bh } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send();
  const tx = await signTransactionMessageWithSigners(pipe(createTransactionMessage({ version: 0 }), (m) => setTransactionMessageFeePayerSigner(signer, m), (m) => setTransactionMessageLifetimeUsingBlockhash(bh, m), (m) => appendTransactionMessageInstructions([memo], m)));
  const signature = getSignatureFromTransaction(tx);
  await rpc.sendTransaction(getBase64EncodedWireTransaction(tx), { encoding: 'base64', preflightCommitment: 'confirmed' }).send();
  for (let i = 0; i < 90; i++) {
    const st = (await rpc.getSignatureStatuses([signature]).send()).value[0];
    if (st?.err) throw new Error(`memo ${signature} failed: ${JSON.stringify(st.err)}`);
    if (st && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) {
      const t = await rpc.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0, encoding: 'json' }).send();
      return { signature, slot: t ? Number(t.slot) : null, blockTime: t?.blockTime == null ? null : Number(t.blockTime) };
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
  throw new Error(`memo ${signature} not confirmed within 90 s`);
}

const log = (o: unknown) => console.log(JSON.stringify({ at: new Date().toISOString(), ...(o as object) }));
log({ started: true, signer: signer.address, cluster: NETWORK, receipts: receipts ? receiptBase : 'off: set RECEIPT_URL or WEB_URL to sign receipts' });
let lastAnchor = 0;
for (;;) {
  try {
    const issued = await issueRound(deps);
    const graded = await gradeRound(deps);
    if (issued.issued.length || graded.graded) log({ issued: issued.issued.length, graded: graded.graded, pending: graded.stillPending });
    const att = receipts ? await attestRound(receipts) : null;
    if (att && (att.attested.length || att.changed.length || att.skipped.length)) log({ receipts: { attested: att.attested.length, changed: att.changed.length, unchanged: att.unchanged, skipped: att.skipped } });
    if (Date.now() - lastAnchor >= anchorMs) {
      const a = await anchorRound(deps, sendMemo);
      const r = receipts ? await anchorReceiptsRound(receipts, sendMemo) : null;
      lastAnchor = Date.now();
      if (a.anchored) log({ anchored: a.anchored, signature: a.signature });
      if (r?.anchored) log({ receiptsAnchored: r.anchored, signature: r.signature });
    }
  } catch (e) {
    log({ error: String(e) });
  }
  await new Promise((r) => setTimeout(r, roundMs));
}
