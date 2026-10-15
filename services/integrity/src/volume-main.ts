// Organic-volume attester process. RPC_URL, ATTESTER_KEYPAIR (a Solana CLI JSON keypair: the key the charters name as their volume attester) and VOLUME_ATTESTER_CONFIG
// (the JSON file described in config.ts) are required.
//
//   RPC_ENDPOINTS       comma-separated RPC URLs for the analysis reads (funding history, order placement); default RPC_URL. A paid endpoint first.
//   RPC_INTERVAL_MS     least milliseconds between those reads (default 300; a public mainnet endpoint wants 1200 or more)
//   PASS_MS             milliseconds between passes (default 60000)
//   ATTESTER_DRY_RUN    1: analyse every cross and say what would be posted, post nothing
//
// The key is read once and never logged. Each pass prints one JSON line per cross that posted, planned, failed, or was held with a reason.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Address, createKeyPairSignerFromBytes, fetchEncodedAccount } from '@solana/kit';
import { createIndexerRpc } from '@opening-cross/indexer';
import { FileFundingCache, FilePlacementStore, pacedRpc } from '@opening-cross/integrity';
import { pollingSender } from '@opening-cross/keeper';
import { FailoverRpc } from '@opening-cross/reliability';
import { parseConfig } from './config.js';
import { volumeOnce } from './run.js';

const { RPC_URL, ATTESTER_KEYPAIR, VOLUME_ATTESTER_CONFIG } = process.env;
if (!RPC_URL || !ATTESTER_KEYPAIR || !VOLUME_ATTESTER_CONFIG) {
  console.error('RPC_URL, ATTESTER_KEYPAIR and VOLUME_ATTESTER_CONFIG are required');
  process.exit(2);
}
const config = parseConfig(JSON.parse(readFileSync(VOLUME_ATTESTER_CONFIG, 'utf8')));
const signer = await createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(readFileSync(ATTESTER_KEYPAIR, 'utf8'))));
const rpc = createIndexerRpc(RPC_URL);
const send = pollingSender(rpc, signer);
const dryRun = process.env.ATTESTER_DRY_RUN === '1';
const passMs = Number(process.env.PASS_MS ?? 60_000);
const endpoints = (process.env.RPC_ENDPOINTS ?? RPC_URL).split(',').map((s) => s.trim()).filter(Boolean);
const analysisRpc = pacedRpc(new FailoverRpc(endpoints, { rounds: 3 }), { minIntervalMs: Number(process.env.RPC_INTERVAL_MS ?? 300), retries: 6 });
const cache = new FileFundingCache(join(config.stateDir, 'funding.jsonl'));
const placements = new FilePlacementStore(join(config.stateDir, 'placements.jsonl'));
console.log(JSON.stringify({ at: new Date().toISOString(), volumeAttester: { address: signer.address, crosses: config.crosses, dryRun, policy: config.policy.version, bundles: config.bundles } }));

const account = async (a: Address) => {
  const x = await fetchEncodedAccount(rpc, a, { commitment: 'confirmed' });
  return x.exists ? { data: x.data, owner: x.programAddress } : null;
};
const fetchJson = async (url: string) => {
  const res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`${url} answered HTTP ${res.status}`);
  return res.json();
};

for (;;) {
  try {
    const outcomes = await volumeOnce({ signer, config, rpc: analysisRpc, cache, placements, account, fetchJson, send, dryRun });
    for (const o of outcomes) console.log(JSON.stringify({ at: new Date().toISOString(), ...o }, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
  } catch (e) {
    console.error(JSON.stringify({ at: new Date().toISOString(), error: String(e) }));
  }
  await new Promise((r) => setTimeout(r, passMs));
}
