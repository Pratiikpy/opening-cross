// The stream process. Required: DATABASE_URL (the indexer's database). Optional:
//   STREAM_PORT (default 50051)   STREAM_HOST (default 0.0.0.0)   STREAM_TOKEN (require "authorization: Bearer <token>")
//   STREAM_TLS_CERT and STREAM_TLS_KEY (PEM files) serve TLS; without them the server speaks plaintext, for use behind a proxy that terminates TLS.
import { readFileSync } from 'node:fs';
import * as grpc from '@grpc/grpc-js';
import pg from 'pg';
import { createStreamServer, listen } from './server.js';
import { PostgresEventSource } from './source.js';

const { DATABASE_URL, STREAM_TOKEN, STREAM_TLS_CERT, STREAM_TLS_KEY } = process.env;
if (!DATABASE_URL) {
  console.error('DATABASE_URL is required');
  process.exit(2);
}
if ((STREAM_TLS_CERT === undefined) !== (STREAM_TLS_KEY === undefined)) {
  console.error('STREAM_TLS_CERT and STREAM_TLS_KEY go together');
  process.exit(2);
}
const db = new pg.Pool({ connectionString: DATABASE_URL });
const server = createStreamServer({ source: new PostgresEventSource(db), ...(STREAM_TOKEN ? { token: STREAM_TOKEN } : {}) });
const creds = STREAM_TLS_CERT && STREAM_TLS_KEY ? grpc.ServerCredentials.createSsl(null, [{ cert_chain: readFileSync(STREAM_TLS_CERT), private_key: readFileSync(STREAM_TLS_KEY) }]) : grpc.ServerCredentials.createInsecure();
const port = await listen(server, `${process.env.STREAM_HOST ?? '0.0.0.0'}:${process.env.STREAM_PORT ?? '50051'}`, creds);
console.log(JSON.stringify({ at: new Date().toISOString(), msg: 'opening-cross event stream', port, tls: Boolean(STREAM_TLS_CERT), token: Boolean(STREAM_TOKEN) }));
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => server.tryShutdown(() => void db.end().then(() => process.exit(0))));
