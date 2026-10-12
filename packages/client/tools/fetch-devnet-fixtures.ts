// Saves real devnet accounts (crosses, orders, a merged book and shards) as test fixtures, so the Rust and TypeScript decoders are
// tested against bytes the program itself wrote and not only against bytes another codec wrote. Reads devnet; sends nothing.
//   pnpm --filter @opening-cross/client exec tsx tools/fetch-devnet-fixtures.ts
// The crosses are chosen from the indexed devnet history (database oc_devnet, read-only): one of each state and disclosure.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { address } from '@solana/kit';
import { bookAddress, shardAddress } from '@opening-cross/sdk';
import { createRpcClient } from '../src/rpc.js';

const RPC = process.env.DEVNET_RPC_URL ?? 'https://api.devnet.solana.com';
const rpc = createRpcClient({ url: RPC });

const psql = (sql: string) =>
  execFileSync('docker', ['exec', 'ocpg', 'psql', '-U', 'postgres', '-d', 'oc_devnet', '-At', '-F', '|', '-c', sql], { encoding: 'utf8' })
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => l.split('|'));

// One cross per (state, sealed or open) that exists, preferring crosses with several orders.
const wanted = psql(`
  SELECT DISTINCT ON (c.state, c.disclosure) c.address, c.state, c.disclosure
  FROM crosses c ORDER BY c.state, c.disclosure, c.orders_committed DESC, c.created_slot DESC`);

type Row = { address: string; kind: 'cross' | 'order' | 'book' | 'shard'; owner: string; hex: string; lamports: string };
const rows: Row[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchMany(kind: Row['kind'], addresses: string[]) {
  for (let i = 0; i < addresses.length; i += 20) {
    const chunk = addresses.slice(i, i + 20);
    const accts = await rpc.getAccounts(chunk);
    chunk.forEach((a, j) => {
      const acct = accts[j];
      if (acct) rows.push({ address: a, kind, owner: acct.owner, hex: Buffer.from(acct.data).toString('hex'), lamports: acct.lamports.toString() });
    });
    await sleep(600);
  }
}

// Orders that are still open on chain (closed orders are deleted by claim and cancel): sealed ones and revealed ones.
const openOrders = psql(`
  (SELECT o.address, o.cross_address FROM orders o WHERE o.status = 'committed' AND o.sealed ORDER BY o.created_slot DESC LIMIT 3)
  UNION ALL
  (SELECT o.address, o.cross_address FROM orders o WHERE o.status = 'revealed' ORDER BY o.created_slot DESC LIMIT 5)`);
const crossSet = [...new Set([...wanted.map((w) => w[0]!), ...openOrders.map((o) => o[1]!)])];
await fetchMany('cross', crossSet);
await fetchMany('order', openOrders.map((o) => o[0]!));
const live = [...new Set([...wanted.filter((w) => w[1] === 'Live').map((w) => w[0]!), ...openOrders.map((o) => o[1]!)])].slice(0, 3);
const books: string[] = [];
const shards: string[] = [];
for (const c of [...live, ...wanted.filter((w) => w[1] !== 'Live').slice(0, 1).map((w) => w[0]!)]) {
  books.push(await bookAddress(address(c)));
  for (let i = 0; i < 2; i++) shards.push(await shardAddress(address(c), i));
}
await fetchMany('book', books);
await fetchMany('shard', shards);

const out = fileURLToPath(new URL('../../../crates/opening-cross-sdk/tests/fixtures/devnet-accounts.json', import.meta.url));
writeFileSync(out, `${JSON.stringify({ schema: 'opening-cross/devnet-account-fixtures/v1', source: RPC, fetchedAt: new Date().toISOString(), accounts: rows }, null, 1)}\n`);
const count = (k: string) => rows.filter((r) => r.kind === k).length;
console.log(`wrote ${out}: ${count('cross')} crosses, ${count('order')} orders, ${count('book')} books, ${count('shard')} shards`);
