// Prints the stream as JSON lines.
//   tsx src/cli.ts --address host:50051 [--from <cursor>] [--head] [--cross <address>]... [--event <Name>]... [--token <t>] [--tls]
import * as grpc from '@grpc/grpc-js';
import { createClient } from './client.js';

const args = process.argv.slice(2);
const flag = (n: string) => args.includes(`--${n}`);
const all = (n: string) => args.flatMap((a, i) => (a === `--${n}` && args[i + 1] ? [args[i + 1]!] : []));
const address = all('address')[0];
if (!address) {
  console.error('usage: cli.ts --address host:port [--from cursor] [--head] [--cross address] [--event name] [--token t] [--tls]');
  process.exit(2);
}
const client = createClient(address, flag('tls') ? grpc.credentials.createSsl() : grpc.credentials.createInsecure());
const from = all('from')[0];
const token = all('token')[0];
const stream = client.subscribe({ ...(from ? { from } : {}), fromHead: flag('head'), crosses: all('cross'), events: all('event'), ...(token ? { token } : {}) });
process.on('SIGINT', () => stream.cancel());
for await (const m of stream) console.log(JSON.stringify(m));
client.close();
