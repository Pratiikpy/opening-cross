// The gate keeper: closes the passes anyone may close (expired, attestation gone, no longer conforming, denied). See gate-sweep.ts.
//
//   RPC_URL           required
//   KEEPER_KEYPAIR    required: a Solana CLI JSON keypair that pays the fees (the rent of a closed pass goes to the pass owner, not to the keeper)
//   PASS_MS           milliseconds between two sweeps (default 60000)
//   KEEPER_DRY_RUN    1: plan everything, send nothing, and log what would have been closed
//
// A sweep reads every `Terms` account of `cross_gate` with getProgramAccounts, so on a public RPC that restricts that call point RPC_URL at an endpoint that allows it.
import { readFileSync } from 'node:fs';
import { type Address, createKeyPairSignerFromBytes, fetchEncodedAccount } from '@solana/kit';
import { CROSS_GATE_PROGRAM_ADDRESS } from '@opening-cross/cross-gate-client';
import { createIndexerRpc } from '@opening-cross/indexer';
import { runGateSweep } from './gate-sweep.js';
import { pollingSender } from './send.js';

const { RPC_URL, KEEPER_KEYPAIR } = process.env;
if (!RPC_URL || !KEEPER_KEYPAIR) {
  console.error('RPC_URL and KEEPER_KEYPAIR are required');
  process.exit(2);
}
const passMs = Number(process.env.PASS_MS?.trim() || 60_000);
if (!Number.isFinite(passMs) || passMs < 1_000) {
  console.error('PASS_MS must be a number of milliseconds, at least 1000');
  process.exit(2);
}
const dryRun = process.env.KEEPER_DRY_RUN?.trim() === '1';
const rpc = createIndexerRpc(RPC_URL);
const payer = await createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(readFileSync(KEEPER_KEYPAIR, 'utf8'))));
const send = pollingSender(rpc, payer);
const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));
console.log(json({ at: new Date().toISOString(), gateKeeper: { program: CROSS_GATE_PROGRAM_ADDRESS, passMs, dryRun } }));

for (;;) {
  try {
    const res = await runGateSweep({
      dryRun,
      now: async () => BigInt(await rpc.getBlockTime(await rpc.getSlot({ commitment: 'confirmed' }).send()).send()),
      program: async (dataSize) => {
        const accounts = await rpc.getProgramAccounts(CROSS_GATE_PROGRAM_ADDRESS, { commitment: 'confirmed', encoding: 'base64', filters: [{ dataSize: BigInt(dataSize) }] }).send();
        return (accounts as readonly { pubkey: Address; account: { data: readonly [string, string] } }[]).map((a) => ({ address: a.pubkey, data: Uint8Array.from(Buffer.from(a.account.data[0], 'base64')) }));
      },
      fetch: async (a) => {
        const x = await fetchEncodedAccount(rpc, a, { commitment: 'confirmed' });
        return x.exists ? { data: x.data, owner: x.programAddress } : null;
      },
      send,
    });
    if (res.closed.length || res.wouldClose.length || res.failed.length) console.log(json({ at: new Date().toISOString(), ...res }));
  } catch (e) {
    console.error(json({ at: new Date().toISOString(), error: String(e) }));
  }
  await new Promise((r) => setTimeout(r, passMs));
}
