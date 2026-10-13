// The integrity routes against real devnet data: one finished cross is read into a scratch Postgres by the indexer's own ingestion path,
// and the routes then trace the real wallet histories of its bidders over RPC.
//   DATABASE_URL=postgres://... CROSS=<address> SIGNER_KEYPAIR=<creator keypair file> tsx scripts/integrity-devnet.ts
import { readFileSync } from 'node:fs';
import Fastify from 'fastify';
import pg from 'pg';
import { createKeyPairSignerFromBytes, createSolanaRpc, fetchEncodedAccount } from '@solana/kit';
import { keyPairFromSolanaFile, signDocument } from '@opening-cross/attest';
import { createIndexerRpc, migrate, pollOnce } from '@opening-cross/indexer';
import { FailoverRpc } from '@opening-cross/reliability';
import { SUPPLY_SCHEMA, TEAM_SCHEMA } from '@opening-cross/integrity';
import { registerIntegrity } from '../src/routes/integrity.js';

const RPCS = (process.env.RPC_URL ?? 'https://api.devnet.solana.com,https://solana-devnet.api.onfinality.io/public').split(',');
const CROSS = process.env.CROSS ?? 'DfggnrfMbn7J47R2HYuJ1enZYSMzHmsyPTgVzkgWpe9T';
const rpc = createSolanaRpc(RPCS[0]!);
const fail = new FailoverRpc(RPCS, { rounds: 3 });
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
await migrate(db);
for (const t of ['events', 'orders', 'crosses', 'cursors']) await db.query(`DELETE FROM ${t}`);
console.log(JSON.stringify({ step: 'ingested from devnet', cross: CROSS, events: await pollOnce(db, createIndexerRpc(RPCS[0]!), CROSS as never, `integrity-run:${CROSS}`) }));

const app = Fastify();
app.setErrorHandler((err, _req, reply) => reply.code((err as { status?: number; statusCode?: number }).status ?? (err as { statusCode?: number }).statusCode ?? 500).send({ error: String(err) }));
registerIntegrity(app, {
  db,
  network: 'devnet',
  account: async (a) => {
    const x = await fetchEncodedAccount(rpc, a, { commitment: 'confirmed' });
    return x.exists ? { data: x.data, owner: x.programAddress } : null;
  },
}, { rpc: fail, maxTrace: 40 });
await app.ready();
const get = async (url: string) => {
  const r = await app.inject({ method: 'GET', url });
  return { status: r.statusCode, ...r.json() };
};
const short = (o: unknown) => JSON.stringify(o, null, 1);

const conflicts = await get(`/v1/integrity/cross/${CROSS}/conflicts`);
console.log('--- conflicts', short({ status: conflicts.status, cross: conflicts.cross, flagged: conflicts.flagged, perOwner: conflicts.perOwner, funding: conflicts.funding }));
const organic = await get(`/v1/integrity/cross/${CROSS}/organic`);
console.log('--- organic', short({ status: organic.status, lowerBps: organic.lowerBps, upperBps: organic.upperBps, serviceFundedBps: organic.serviceFundedBps, volume: organic.volume, perOwner: organic.perOwner, clusters: organic.clusters, ignoredServices: organic.ignoredServices }));
const mint = conflicts.cross.baseMint as string;
const holders = await get(`/v1/integrity/mint/${mint}/holders`);
console.log('--- holders', short({ status: holders.status, supply: holders.supply, coveredBps: holders.coveredBps, byKind: holders.byKind, holders: holders.holders?.map((h: { owner: string; shareBps: number; label: { kind: string; basis: string } }) => [h.owner, h.shareBps, h.label.kind, h.label.basis]), clusters: holders.funding?.clusters }));

// Signed declarations by the creator: a team list and a supply declaration, then the supply reconciliation.
if (process.env.SIGNER_KEYPAIR) {
  const { keyPair, address } = await keyPairFromSolanaFile(readFileSync(process.env.SIGNER_KEYPAIR, 'utf8'));
  const signer = await createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(readFileSync(process.env.SIGNER_KEYPAIR, 'utf8')) as number[]));
  const now = Math.floor(Date.now() / 1000);
  const sup = BigInt(holders.supply);
  for (const doc of [
    await signDocument({ schema: TEAM_SCHEMA, mint, wallets: [address], asOf: now - 5 }, keyPair),
    await signDocument({ schema: SUPPLY_SCHEMA, mint, totalSupply: String(sup), asOf: now - 5, policy: 'mintable' }, keyPair),
  ]) {
    const r = await app.inject({ method: 'POST', url: '/v1/integrity/documents', payload: doc as never });
    console.log('--- document', doc.body.schema, r.statusCode, signer.address === address ? 'signed by the creator' : '');
  }
  const holders2 = await get(`/v1/integrity/mint/${mint}/holders`);
  console.log('--- holders after the team declaration', short({ byKind: holders2.byKind, labels: holders2.holders?.map((h: { owner: string; label: { kind: string } }) => [h.owner, h.label.kind]) }));
  const supply = await get(`/v1/integrity/mint/${mint}/supply`);
  console.log('--- supply', short({ status: supply.status, onchainSupply: supply.onchainSupply, declaredSupply: supply.declaredSupply, findings: supply.findings, circulating: supply.circulating, crossesCounted: supply.crossesCounted }));
}
const backing = await get(`/v1/integrity/mint/${mint}/backing`);
console.log('--- backing', short({ status: backing.status, reasons: backing.reasons }));
const rating = await get(`/v1/integrity/cross/${CROSS}/rating`);
console.log('--- rating', short({ status: rating.status, score: rating.score, coverage: rating.coverage, reason: rating.reason, components: rating.components }));
const brief = await get(`/v1/integrity/cross/${CROSS}/brief`);
console.log('--- brief', short({ statements: brief.statements?.map((s: { text: string }) => s.text), abstentions: brief.abstentions }));
const claims = await app.inject({ method: 'POST', url: '/v1/integrity/verify-claims', payload: { cross: CROSS, text: 'The cross cleared at 1550000. It had 2 orders. It had 40 orders. The token is going to the moon.' } as never });
console.log('--- claims', short(claims.json().results.map((r: { claim: { text: string }; verdict: string; actual?: string }) => [r.claim.text, r.verdict, r.actual])), short(claims.json().unparsed));
console.log('--- track record', short((await get('/v1/integrity/ratings/track-record')).statement));
await app.close();
await db.end();
