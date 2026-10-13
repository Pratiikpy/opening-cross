// The gRPC server. `Subscribe` replays the log from a cursor and then follows it; `Head` says where the log ends.
//
// Delivery is at-least-once in order: a client that keeps the cursor of the last event it handled and resumes from it sees every
// later event exactly once in ingestion order (the log is append-only and positions never repeat). The server never skips an
// event it cannot convert: it ends that stream with INTERNAL naming the position, so a build that lags the program is noticed.
// A slow client is not allowed to make the server buffer without bound: writes honour backpressure, and a client that does not
// drain within `stallMs` is disconnected with RESOURCE_EXHAUSTED and can resume from its cursor.
import { fileURLToPath } from 'node:url';
import * as grpc from '@grpc/grpc-js';
import * as loader from '@grpc/proto-loader';
import { UnknownEvent, toWire } from './convert.js';
import type { EventFilter, EventSource } from './source.js';

export const PROTO_PATH = fileURLToPath(new URL('../proto/opening_cross/v1/stream.proto', import.meta.url));

export const LOADER_OPTIONS: loader.Options = { longs: String, enums: String, defaults: true, oneofs: true, keepCase: true };

export function loadPackage(): grpc.GrpcObject {
  return grpc.loadPackageDefinition(loader.loadSync(PROTO_PATH, LOADER_OPTIONS));
}

export type ServiceConstructor = grpc.ServiceClientConstructor;
export function eventStreamService(): ServiceConstructor {
  const pkg = loadPackage() as unknown as { opening_cross: { v1: { EventStream: ServiceConstructor } } };
  return pkg.opening_cross.v1.EventStream;
}

export type StreamOptions = {
  source: EventSource;
  /** Time between polls of the source while following the log. */
  pollMs?: number;
  /** Time between heartbeats on a quiet stream. */
  heartbeatMs?: number;
  /** Events fetched per read. */
  batch?: number;
  /** A client that has not drained a write in this long is disconnected. */
  stallMs?: number;
  /** When set, calls must carry `authorization: Bearer <token>` metadata. The stream carries public data; this is for rate control. */
  token?: string;
  /** Wall clock in unix seconds, for heartbeats. */
  clock?: () => number;
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function filterOf(req: { crosses?: string[]; events?: string[] }): EventFilter {
  return { crosses: new Set(req.crosses ?? []), events: new Set(req.events ?? []) };
}

export function createStreamServer(o: StreamOptions): grpc.Server {
  const pollMs = o.pollMs ?? 500;
  const heartbeatMs = o.heartbeatMs ?? 15_000;
  const batch = o.batch ?? 500;
  const stallMs = o.stallMs ?? 30_000;
  const clock = o.clock ?? (() => Math.floor(Date.now() / 1000));

  const authorized = (md: grpc.Metadata): boolean => !o.token || md.get('authorization').some((v) => String(v) === `Bearer ${o.token}`);

  async function subscribe(call: grpc.ServerWritableStream<{ from?: { position: string } | null; from_head: boolean; crosses: string[]; events: string[] }, unknown>) {
    if (!authorized(call.metadata)) return void call.emit('error', { code: grpc.status.UNAUTHENTICATED, details: 'missing or wrong bearer token' });
    const req = call.request;
    const state = { cancelled: false };
    call.on('cancelled', () => (state.cancelled = true));
    call.on('close', () => (state.cancelled = true));
    let position: bigint;
    try {
      if (req.from && req.from.position !== '0') position = BigInt(req.from.position);
      else if (req.from_head) position = (await o.source.head()).position;
      else position = 0n;
    } catch (e) {
      return void call.emit('error', { code: grpc.status.UNAVAILABLE, details: `could not read the log: ${String(e).slice(0, 200)}` });
    }
    const filter = filterOf(req);

    /** Writes with backpressure; false when the client is gone or stalled. */
    const write = async (msg: unknown): Promise<boolean> => {
      if (state.cancelled) return false;
      if (call.write(msg)) return true;
      return await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => {
          cleanup();
          resolve(false);
        }, stallMs);
        const onDrain = () => {
          cleanup();
          resolve(true);
        };
        const onClose = () => {
          cleanup();
          resolve(false);
        };
        const cleanup = () => {
          clearTimeout(timer);
          call.off('drain', onDrain);
          call.off('close', onClose);
        };
        call.once('drain', onDrain);
        call.once('close', onClose);
      });
    };

    const heartbeat = async () => (await write({ heartbeat: { head: { position: (await o.source.head()).position.toString() }, at: clock().toString() } }));
    try {
      if (!(await heartbeat())) return finish(call, state, grpc.status.RESOURCE_EXHAUSTED, 'the client did not keep up');
      let lastBeat = Date.now();
      while (!state.cancelled) {
        const rows = await o.source.next(position, batch, filter);
        // Positions the filter skipped still advance the cursor, so a resume does not re-scan them.
        for (const r of rows) {
          let wire;
          try {
            wire = toWire(r);
          } catch (e) {
            if (e instanceof UnknownEvent) return finish(call, state, grpc.status.INTERNAL, `position ${r.position}: ${e.message}`);
            throw e;
          }
          if (!(await write({ event: wire }))) return finish(call, state, grpc.status.RESOURCE_EXHAUSTED, 'the client did not keep up');
          position = r.position;
          lastBeat = Date.now();
        }
        if (rows.length < batch) {
          if (Date.now() - lastBeat >= heartbeatMs) {
            if (!(await heartbeat())) return finish(call, state, grpc.status.RESOURCE_EXHAUSTED, 'the client did not keep up');
            lastBeat = Date.now();
          }
          await sleep(pollMs);
        }
      }
    } catch (e) {
      if (!state.cancelled) finish(call, state, grpc.status.UNAVAILABLE, `the log could not be read: ${String(e).slice(0, 200)}`);
    }
  }

  async function head(call: grpc.ServerUnaryCall<unknown, unknown>, cb: grpc.sendUnaryData<unknown>) {
    if (!authorized(call.metadata)) return cb({ code: grpc.status.UNAUTHENTICATED, message: 'missing or wrong bearer token' });
    try {
      const h = await o.source.head();
      cb(null, { head: { position: h.position.toString() }, events: h.events.toString() });
    } catch (e) {
      cb({ code: grpc.status.UNAVAILABLE, message: `could not read the log: ${String(e).slice(0, 200)}` });
    }
  }

  const server = new grpc.Server({ 'grpc.max_send_message_length': 1 << 20 });
  server.addService(eventStreamService().service, { Subscribe: subscribe as never, Head: head as never });
  return server;
}

function finish(call: grpc.ServerWritableStream<any, unknown>, state: { cancelled: boolean }, code: grpc.status, message: string) {
  state.cancelled = true;
  call.emit('error', { code, details: message });
}

export function listen(server: grpc.Server, address: string, credentials: grpc.ServerCredentials = grpc.ServerCredentials.createInsecure()): Promise<number> {
  return new Promise((resolve, reject) => server.bindAsync(address, credentials, (err, port) => (err ? reject(err) : resolve(port))));
}
