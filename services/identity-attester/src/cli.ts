// `init`: creates the credential and schema on chain (idempotent) and prints the addresses to put in SAS_CREDENTIAL and SAS_SCHEMA.
import { createChain } from './chain.js';
import { loadSettings } from './config.js';

const cmd = process.argv[2];
if (cmd !== 'init') {
  console.error('usage: cli init');
  process.exit(2);
}
const s = await loadSettings();
const chain = createChain(s.rpcUrl);
const r = await chain.init(s.signer);
console.log(JSON.stringify({ attester: s.signer.address, SAS_CREDENTIAL: r.credential, SAS_SCHEMA: r.schema, transactions: r.signatures }, null, 2));
