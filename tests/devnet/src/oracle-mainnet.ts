// DP15: live Pyth reads on mainnet through the same parser the SDK and cross_core use, under both
// the pre-upgrade and the upgraded (26 Aug 2026) Pyth Core programs.
import { createSolanaRpc, fetchEncodedAccount } from '@solana/kit';
import { PYTH_PUSH_ORACLE, PYTH_PUSH_ORACLE_UPGRADED, hexToBytes, isPythReceiver, oracleToCrossUnits, parsePriceUpdate, pythFeedAccount } from '@opening-cross/sdk';
import { Evidence } from './lib.js';

const MAINNET_RPC = process.env.MAINNET_RPC ?? 'https://api.mainnet-beta.solana.com';
const rpc = createSolanaRpc(MAINNET_RPC);
const FEEDS: [string, string][] = [
  ['Crypto.SOL/USD (control, sponsored)', 'ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d'],
  ['Equity.US.NVDA/USD', 'b1073854ed24cbc755dc527418f52b7d271f6cc967bbf8d8129112b18860a593'],
  ['Equity.Index.NVDA/USD (24/7)', 'a470c4ac46f44b547b2cba52338f311fb642b79375ce5f0cfd5cb5b99227b852'],
  ['Equity.US.TSLA/USD', '16dad506d7db8da01c87581c87ca897a012a153557d4d578c3b9c9e1bc0632f1'],
  ['Equity.US.SPY/USD', '19e09bb805456ada3979a7d1cbb4b6d63babc3a0f8e8a9509f68afa5c4c11cd5'],
];
const ev = new Evidence('DP15-pyth-mainnet.md', 'DP15 — Pyth price accounts on mainnet', [
  'Script `tests/devnet/src/oracle-mainnet.ts`; feed ids from Hermes `/v2/price_feeds?asset_type=equity`',
  'Accounts = push-oracle PDA `[shard 0 (u16 LE), feed_id]` under the pre-upgrade (`pythWSn…`) and upgraded (`pyt2F4…`) programs; parsed with `@opening-cross/sdk`, same layout as `cross_core::oracle`',
  'A stale or missing push account is a finding, not a failure: crosses use the pull model (fresh update posted by the keeper), which needs a Pyth API key (HUMAN_TASKS H11).',
], new URL(MAINNET_RPC).origin);

async function main() {
  const now = BigInt(Math.floor(Date.now() / 1000));
  for (const [name, id] of FEEDS) {
    for (const [label, program] of [['pre-upgrade', PYTH_PUSH_ORACLE], ['upgraded', PYTH_PUSH_ORACLE_UPGRADED]] as const) {
      const account = await pythFeedAccount(id, 0, program);
      const a = await fetchEncodedAccount(rpc, account);
      if (!a.exists) { ev.check(`${name} / ${label}`, 'push account state recorded', true, `${account}: no sponsored push account`); continue; }
      const o = parsePriceUpdate(a.data);
      const feedOk = !!o && Buffer.from(o.feedId).equals(Buffer.from(hexToBytes(id)));
      const age = o ? now - o.publishTime : -1n;
      const usd = o ? Number(o.price) * 10 ** o.exponent : NaN;
      ev.check(`${name} / ${label}`, 'owned by a Pyth receiver, parses, feed id matches, fully verified', isPythReceiver(a.programAddress) && feedOk && !!o?.fullyVerified, `${account}: $${usd.toFixed(4)}, age ${age}s${age > 3600n ? ' (STALE — not usable by the guard)' : ''}, cross units (6dp quote, 8dp token, scale 1e8) ${o ? oracleToCrossUnits(o, 6, 8, 100_000_000n) : null}`);
    }
  }
}
main().then(() => ev.write(), (e) => { console.error(e); ev.write(e); });
