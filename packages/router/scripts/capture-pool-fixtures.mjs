// Captures the on-chain accounts the pool tests read, so the tests price real Meteora pool state rather than constructed state.
//
//   node scripts/capture-pool-fixtures.mjs [rpcUrl]
//
// The pools are the ones the devnet proofs opened through cross_settle (docs/evidence/A2-damm-v2-devnet.md, A3-dlmm-devnet.md,
// D5-dlmm-conviction-ladder-devnet.md). The script writes test/fixtures/devnet-pools.json: for each account its owner, the slot it was read
// at and its bytes in base64. It touches the network only to read; nothing is signed or sent.
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { address, getAddressEncoder, getProgramDerivedAddress } from '@solana/kit';

const RPC = process.argv[2] ?? 'https://api.devnet.solana.com';
const DLMM = address('LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo');
const PAIRS = { 'dlmm-proof': '9zCyWgZoDLutMeci2ntdfsYR4Dnu4TXi81RivPBY4125', 'dlmm-ladder': '9ND3Gwnt5v8HVduCNKBozEuXTKwpXjtV3TMQDY9GctYG' };
const DAMM_POOL = '5fDuBQZnim5qF8gJHQebPfqS1eLSEhHxo6hurXsmP8AU';

async function rpc(method, params) {
  const res = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const body = await res.json();
  if (body.error) throw new Error(`${method}: ${JSON.stringify(body.error)}`);
  return body.result;
}
async function read(a) {
  const r = await rpc('getAccountInfo', [a, { encoding: 'base64', commitment: 'finalized' }]);
  return r.value ? { owner: r.value.owner, slot: r.context.slot, data: r.value.data[0] } : null;
}
const enc = getAddressEncoder();
async function binArray(pair, index) {
  const seed = new Uint8Array(8);
  new DataView(seed.buffer).setBigInt64(0, BigInt(index), true);
  return (await getProgramDerivedAddress({ programAddress: DLMM, seeds: [new TextEncoder().encode('bin_array'), enc.encode(address(pair)), seed] }))[0];
}

const accounts = {};
const note = {};
for (const [name, pair] of Object.entries(PAIRS)) {
  const lb = await read(pair);
  if (!lb) throw new Error(`${name} ${pair} does not exist on ${RPC}`);
  accounts[pair] = lb;
  const raw = Buffer.from(lb.data, 'base64');
  const activeId = raw.readInt32LE(8 + 68);
  note[name] = { pair, activeId, binArrays: [] };
  const mid = Math.floor(activeId / 70);
  for (let index = mid - 1; index <= mid + 2; index++) {
    const a = await binArray(pair, index);
    const acct = await read(a);
    if (acct) {
      accounts[a] = acct;
      note[name].binArrays.push({ index, address: a });
    }
  }
}
const damm = await read(DAMM_POOL);
if (!damm) throw new Error(`${DAMM_POOL} does not exist on ${RPC}`);
accounts[DAMM_POOL] = damm;

// The mints of every pool (the pools price in atoms, and the API reads decimals, token program and extensions from the mint), and the Clock sysvar.
const MINTS = [
  'AypfHSmpMQ2C1zaGRHRyoYbQBjFA8Wphc7AQrkmCLZXN', 'HRYt8BVWnDkBNXJQ8CUpAkVEaQUgFeUAshGCRAk8JEGN', // dlmm-proof X, Y
  'BdbY4wWxCKv1CX9xY5XSbjexeZUFQimyhPp86jgmhakt', 'B8yoGNPDWTaWK86Po4V1nBGnqHTCvSKn839kAgrksQHJ', // dlmm-ladder X, Y
  'EkisVxYv7x5pJfXUM75WiQC9AgYKy2ps5R3pyTEeovCV', '7BavPghywmfMMvt7VctXpFvqKCB8kwnXDyA2iZUQzidy', // damm-proof A, B
  'SysvarC1ock11111111111111111111111111111111',
];
for (const m of MINTS) {
  const acct = await read(m);
  if (!acct) throw new Error(`${m} does not exist on ${RPC}`);
  accounts[m] = acct;
}

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures', 'devnet-pools.json');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify({ rpc: RPC, capturedAt: new Date().toISOString(), pools: { ...Object.fromEntries(Object.entries(note).map(([k, v]) => [k, { pair: v.pair, activeId: v.activeId, binArrays: v.binArrays }])), 'damm-proof': { pool: DAMM_POOL } }, accounts }, null, 1) + '\n');
console.log(`wrote ${out}: ${Object.keys(accounts).length} accounts`);
