// A small typed client: subscribe from a cursor and receive events as objects. The command line version is `src/cli.ts`.
import * as grpc from '@grpc/grpc-js';
import { eventStreamService } from './server.js';

export type WireCursor = { position: string };
export type WireEvent = {
  cursor: WireCursor;
  name: string;
  cross: string;
  slot: string;
  signature: string;
  seq: number;
  block_time: string;
  payload: string;
  [payloadMember: string]: unknown;
};
export type WireMessage = { body: 'event'; event: WireEvent; heartbeat?: undefined } | { body: 'heartbeat'; heartbeat: { head: WireCursor; at: string }; event?: undefined };

export type SubscribeOptions = { from?: string; fromHead?: boolean; crosses?: string[]; events?: string[]; token?: string };

export function createClient(address: string, credentials: grpc.ChannelCredentials = grpc.credentials.createInsecure()) {
  const Ctor = eventStreamService();
  const client = new Ctor(address, credentials) as unknown as grpc.Client & {
    Subscribe(req: unknown, md: grpc.Metadata): grpc.ClientReadableStream<WireMessage>;
    Head(req: unknown, md: grpc.Metadata, cb: (err: grpc.ServiceError | null, res: { head: WireCursor; events: string }) => void): void;
  };
  const meta = (token?: string) => {
    const md = new grpc.Metadata();
    if (token) md.set('authorization', `Bearer ${token}`);
    return md;
  };
  return {
    close: () => client.close(),
    head: (token?: string) => new Promise<{ head: WireCursor; events: string }>((resolve, reject) => client.Head({}, meta(token), (err, res) => (err ? reject(err) : resolve(res)))),
    /** An async iterable of messages that ends when the server closes the stream; break out of the loop to cancel. */
    subscribe(o: SubscribeOptions = {}): AsyncIterable<WireMessage> & { cancel: () => void } {
      const stream = client.Subscribe({ ...(o.from ? { from: { position: o.from } } : {}), from_head: o.fromHead ?? false, crosses: o.crosses ?? [], events: o.events ?? [] }, meta(o.token));
      const it = (async function* () {
        try {
          for await (const m of stream) yield m;
        } catch (e) {
          if ((e as { code?: number }).code === grpc.status.CANCELLED) return;
          throw e;
        }
      })();
      return Object.assign(it, { cancel: () => stream.cancel() });
    },
  };
}
