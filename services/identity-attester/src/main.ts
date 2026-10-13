// Starts the attester. Needs ATTESTER_KEYPAIR, ATTESTER_SECRET_FILE, SAS_CREDENTIAL and SAS_SCHEMA (run `pnpm --filter @opening-cross/identity-attester init`
// once to create the credential and schema and print the two addresses).
import { createChain, issueAttestation } from './chain.js';
import { loadSettings } from './config.js';
import { buildAttester } from './server.js';

const s = await loadSettings();
if (!s.credential || !s.schema) throw new Error('SAS_CREDENTIAL and SAS_SCHEMA are not set; run the init command first');
const chain = createChain(s.rpcUrl);
const credential = s.credential;
const schema = s.schema;
const app = await buildAttester({
  credential,
  schema,
  attester: s.signer.address,
  secret: s.secret,
  ttlSeconds: s.ttlSeconds,
  hourlyCap: s.hourlyCap,
  issue: (wallet) => issueAttestation({ chain, signer: s.signer, credential, schema, wallet, ttlSeconds: s.ttlSeconds }),
});
await app.listen({ port: s.port, host: '0.0.0.0' });
console.log(JSON.stringify({ listening: s.port, attester: s.signer.address, credential, schema, label: 'devnet test attester: no real identity verification' }));
