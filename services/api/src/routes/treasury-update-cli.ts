// Owner CLI for treasury disclosure updates (PRODUCT_FEATURES E5). The key never leaves this process: it signs the update,
// signs and sends the Memo transaction that anchors it, and posts both to the API, which verifies them against the chain.
//
//   tsx src/routes/treasury-update-cli.ts --keypair <authority.json> --treasury <address> --title <text> --summary <text> \
//     --covered-from <unix> --covered-to <unix> [--declared-spent <quote atoms>] [--api <url>] [--rpc <url>]
//
// --api defaults to API_URL or http://localhost:8080; --rpc to RPC_URL or the public devnet endpoint. Prints the stored update as JSON.
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import {
  type Address,
  type Instruction,
  AccountRole,
  appendTransactionMessageInstructions,
  createKeyPairSignerFromBytes,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from '@solana/kit';
import type { KeyPairSigner } from '@solana/kit';
import { createIndexerRpc } from '@opening-cross/indexer';
import { MEMO_PROGRAM, type UpdateBody, UPDATE_SCHEMA, memoTextOf, signUpdate } from './treasury-updates.js';

/** The indexer's RPC client retries the 429s and dropped connections that the public cluster endpoints answer bursts with. */
type Rpc = ReturnType<typeof createIndexerRpc>;

/** Writes `text` as a Memo signed by `signer` and returns its signature once confirmed. */
export async function sendMemo(rpc: Rpc, signer: KeyPairSigner, text: string): Promise<string> {
  const memo: Instruction = { programAddress: MEMO_PROGRAM as Address, accounts: [{ address: signer.address, role: AccountRole.READONLY_SIGNER, signer }], data: new TextEncoder().encode(text) } as unknown as Instruction;
  const { value: blockhash } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send();
  const tx = await signTransactionMessageWithSigners(
    pipe(createTransactionMessage({ version: 0 }), (m) => setTransactionMessageFeePayerSigner(signer, m), (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m), (m) => appendTransactionMessageInstructions([memo], m)),
  );
  const signature = getSignatureFromTransaction(tx);
  await rpc.sendTransaction(getBase64EncodedWireTransaction(tx), { encoding: 'base64', preflightCommitment: 'confirmed' }).send();
  for (let i = 0; i < 90; i++) {
    const st = (await rpc.getSignatureStatuses([signature]).send()).value[0];
    if (st?.err) throw new Error(`memo ${signature} failed: ${JSON.stringify(st.err, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))}`);
    if (st && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) return signature;
    await new Promise((r) => setTimeout(r, 1_000));
  }
  throw new Error(`memo ${signature} was not confirmed within 90 s`);
}

/** The cluster's own time in unix seconds. */
export async function clusterTime(rpc: Rpc): Promise<number> {
  const slot = await rpc.getSlot({ commitment: 'confirmed' }).send();
  const t = await rpc.getBlockTime(slot).send();
  if (t === null) throw new Error('the cluster returned no block time for the current slot');
  return Number(t);
}

export type SubmitInput = {
  signer: KeyPairSigner;
  treasury: string;
  title: string;
  summary: string;
  coveredFrom: number;
  coveredTo: number;
  declaredSpentAtoms: string | null;
  api: string;
  rpc: Rpc;
  /** Unix seconds for `issuedAt`; defaults to the cluster's clock (the same clock that stamps the anchor), so the owner's own clock cannot put it ahead of the chain. */
  now?: number;
};

/** Reads the chain of earlier updates from the API, signs the next one, anchors it, posts it. */
export async function submitUpdate(i: SubmitInput) {
  const listed = await fetch(`${i.api}/v1/treasuries/${i.treasury}/updates`);
  const list = (await listed.json()) as { network?: string; updates?: { id: string; sequence: number }[]; error?: string };
  if (!listed.ok || !list.network || !list.updates) throw new Error(`could not read the treasury's updates from ${i.api}: ${list.error ?? listed.status}`);
  const last = list.updates[0];
  const body: UpdateBody = {
    schema: UPDATE_SCHEMA,
    cluster: list.network,
    treasury: i.treasury,
    authority: i.signer.address,
    sequence: (last?.sequence ?? 0) + 1,
    previousId: last?.id ?? null,
    issuedAt: i.now ?? (await clusterTime(i.rpc)),
    coveredFrom: i.coveredFrom,
    coveredTo: i.coveredTo,
    title: i.title,
    summary: i.summary,
    declaredSpentAtoms: i.declaredSpentAtoms,
  };
  const update = await signUpdate(body, i.signer);
  const memoSignature = await sendMemo(i.rpc, i.signer, memoTextOf(i.treasury, body.sequence, update.id));
  const res = await fetch(`${i.api}/v1/treasuries/${i.treasury}/updates`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ update, memoSignature }) });
  const out = (await res.json()) as { error?: string };
  if (!res.ok) throw new Error(`the API refused the update (${res.status}): ${out.error ?? JSON.stringify(out)}`);
  return out;
}

if (process.argv[1] && /treasury-update-cli\.[tj]s$/.test(process.argv[1])) {
  const { values: v } = parseArgs({
    options: {
      keypair: { type: 'string' },
      treasury: { type: 'string' },
      title: { type: 'string' },
      summary: { type: 'string' },
      'covered-from': { type: 'string' },
      'covered-to': { type: 'string' },
      'declared-spent': { type: 'string' },
      api: { type: 'string' },
      rpc: { type: 'string' },
    },
  });
  const missing = (['keypair', 'treasury', 'title', 'summary', 'covered-from', 'covered-to'] as const).filter((k) => !v[k]);
  if (missing.length) {
    console.error(`missing: ${missing.map((m) => `--${m}`).join(' ')}`);
    process.exit(2);
  }
  const signer = await createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(readFileSync(v.keypair!, 'utf8'))));
  const out = await submitUpdate({
    signer,
    treasury: v.treasury!,
    title: v.title!,
    summary: v.summary!,
    coveredFrom: Number(v['covered-from']),
    coveredTo: Number(v['covered-to']),
    declaredSpentAtoms: v['declared-spent'] ?? null,
    api: v.api ?? process.env.API_URL ?? 'http://localhost:8080',
    rpc: createIndexerRpc(v.rpc ?? process.env.RPC_URL ?? 'https://api.devnet.solana.com'),
  });
  console.log(JSON.stringify(out, null, 2));
}
