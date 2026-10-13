// The stream on real devnet data. The indexer's own ingestion path reads every transaction that touched one finished cross
// (getSignaturesForAddress on the cross account, then getTransaction at finalized, decoded by the same decoder the indexer
// uses) into a scratch Postgres; the gRPC server then serves that log and a client subscribes, resumes from a cursor, and
// filters by event name.
//   DATABASE_URL=postgres://... CROSS=<address> tsx scripts/devnet-run.ts
import pg from 'pg';
import { createIndexerRpc, migrate, pollOnce } from '@opening-cross/indexer';
import { createClient, createStreamServer, listen, PostgresEventSource } from '../src/index.js';

const RPC = process.env.RPC_URL ?? 'https://api.devnet.solana.com';
const CROSS = process.env.CROSS ?? 'DfggnrfMbn7J47R2HYuJ1enZYSMzHmsyPTgVzkgWpe9T';
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
await migrate(db);
// A scratch database: start from nothing, so the log is exactly what this run ingests.
for (const t of ['events', 'orders', 'crosses', 'cursors']) await db.query(`DELETE FROM ${t}`);
const applied = await pollOnce(db, createIndexerRpc(RPC), CROSS as never, `stream-run:${CROSS}`);
console.log(JSON.stringify({ step: 'ingested from devnet', cross: CROSS, events: applied }));

const server = createStreamServer({ source: new PostgresEventSource(db), pollMs: 200, heartbeatMs: 1_000 });
const port = await listen(server, '127.0.0.1:0');
const client = createClient(`127.0.0.1:${port}`);
console.log(JSON.stringify({ step: 'head', ...(await client.head()) }));

const seen: { cursor: string; name: string; summary: unknown }[] = [];
for await (const m of client.subscribe()) {
  if (m.body === 'heartbeat') {
    if (seen.length > 0) break; // the log is drained: the stream is now quiet
    continue;
  }
  const e = m.event!;
  const detail = (e as Record<string, unknown>)[e.payload as string];
  seen.push({ cursor: e.cursor.position, name: e.name, summary: detail });
  console.log(JSON.stringify({ cursor: e.cursor.position, slot: e.slot, name: e.name, signature: e.signature.slice(0, 16) + '...', [e.payload]: detail }));
}
const resumeAfter = seen[3]!.cursor;
const resumed: string[] = [];
let beats = 0;
for await (const m of client.subscribe({ from: resumeAfter })) {
  if (m.body === 'heartbeat') {
    if (++beats > 1) break; // the first heartbeat opens the stream; the second says it is quiet
    continue;
  }
  resumed.push(m.event!.cursor.position);
}
console.log(JSON.stringify({ step: 'resume', after: resumeAfter, got: resumed, expected: seen.slice(4).map((s) => s.cursor) }));
const claims: string[] = [];
beats = 0;
for await (const m of client.subscribe({ events: ['OrderClaimed', 'CrossCleared'] })) {
  if (m.body === 'heartbeat') {
    if (++beats > 1) break;
    continue;
  }
  claims.push(m.event!.name);
}
console.log(JSON.stringify({ step: 'filter', names: claims }));
client.close();
server.forceShutdown();
await db.end();
