// Attester process. RPC_URL, ATTESTER_KEYPAIR (a Solana CLI JSON keypair: the key the policies name as their attester) and ATTESTER_CONFIG (the JSON file described in config.ts) are required.
//
//   PASS_MS             milliseconds between passes (default 30000)
//   ATTESTER_DRY_RUN    1: read every source and say what would be posted, post nothing
//
// The key is read once and never logged. Each pass prints one JSON line per asset that posted, planned or failed; an asset that is simply fresh is silent.
import { readFileSync } from 'node:fs';
import { type Address, createKeyPairSignerFromBytes, fetchEncodedAccount } from '@solana/kit';
import { createIndexerRpc } from '@opening-cross/indexer';
import { pollingSender } from '@opening-cross/keeper';
import { parseConfig } from './config.js';
import { attestOnce } from './run.js';

const { RPC_URL, ATTESTER_KEYPAIR, ATTESTER_CONFIG } = process.env;
if (!RPC_URL || !ATTESTER_KEYPAIR || !ATTESTER_CONFIG) {
  console.error('RPC_URL, ATTESTER_KEYPAIR and ATTESTER_CONFIG are required');
  process.exit(2);
}
const config = parseConfig(JSON.parse(readFileSync(ATTESTER_CONFIG, 'utf8')));
const signer = await createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(readFileSync(ATTESTER_KEYPAIR, 'utf8'))));
const rpc = createIndexerRpc(RPC_URL);
const send = pollingSender(rpc, signer);
const dryRun = process.env.ATTESTER_DRY_RUN === '1';
const passMs = Number(process.env.PASS_MS ?? 30_000);
console.log(JSON.stringify({ at: new Date().toISOString(), attester: { address: signer.address, assets: config.assets.map((a) => a.mint), dryRun } }));

const account = async (a: Address) => {
  const x = await fetchEncodedAccount(rpc, a, { commitment: 'confirmed' });
  return x.exists ? { data: x.data, owner: x.programAddress } : null;
};
const clusterNow = async () => BigInt(await rpc.getBlockTime(await rpc.getSlot({ commitment: 'confirmed' }).send()).send());

for (;;) {
  try {
    const now = await clusterNow();
    const outcomes = await attestOnce({ signer, config, send, account, now: () => now, dryRun });
    for (const o of outcomes) if (o.status !== 'skipped') console.log(JSON.stringify({ at: new Date().toISOString(), ...o }, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
  } catch (e) {
    console.error(JSON.stringify({ at: new Date().toISOString(), error: String(e) }));
  }
  await new Promise((r) => setTimeout(r, passMs));
}
