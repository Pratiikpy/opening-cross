// DP15 (pull model): fetch a fresh signed update from Hermes for a 24/7 equity feed, post it
// through the Pyth receiver on devnet, and check the posted account with the same parser the
// SDK and cross_core use — owner, feed id, full Wormhole verification, freshness, cross units.
import { existsSync, readFileSync } from 'node:fs';
import { Wallet } from '@coral-xyz/anchor';
import { HermesClient } from '@pythnetwork/hermes-client';
import { PythSolanaReceiver } from '@pythnetwork/pyth-solana-receiver';
import { fetchEncodedAccount, address } from '@solana/kit';
import { hexToBytes, isPythReceiver, oracleToCrossUnits, parsePriceUpdate } from '@opening-cross/sdk';
import { Evidence, ROOT, connection, operator, rpc } from './lib.js';

// Since the 26 Aug 2026 Pyth Core upgrade, Hermes requires an API key (HUMAN_TASKS H11). The key
// lives in .secrets/pyth.env as PYTH_API_KEY=... and is never committed.
function pythApiKey(): string {
  const file = `${ROOT}.secrets/pyth.env`;
  const fromFile = existsSync(file) ? /PYTH_API_KEY=(\S+)/.exec(readFileSync(file, 'utf8'))?.[1] : undefined;
  const key = process.env.PYTH_API_KEY ?? fromFile;
  if (!key) throw new Error('PYTH_API_KEY missing: see docs/HUMAN_TASKS.md H11');
  return key;
}

const FEED = 'a470c4ac46f44b547b2cba52338f311fb642b79375ce5f0cfd5cb5b99227b852'; // Equity.Index.NVDA/USD, 24/7
const ev = new Evidence('DP15-pyth-pull-devnet.md', 'DP15 — Pyth pull update posted on devnet (24/7 NVDA)', ['Script `tests/devnet/src/oracle-pull.ts`; Hermes https://hermes.pyth.network; receiver `rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ`']);

async function main() {
  // Upgraded Hermes endpoint per docs.pyth.network/price-feeds/core/upgrade/preparing.
  const hermes = new HermesClient('https://pyth.dourolabs.app/hermes', { headers: { Authorization: `Bearer ${pythApiKey()}` } });
  const update = await hermes.getLatestPriceUpdates([FEED], { encoding: 'base64' });
  const receiver = new PythSolanaReceiver({ connection, wallet: new Wallet(operator) });
  const builder = receiver.newTransactionBuilder({ closeUpdateAccounts: false });
  await builder.addPostPriceUpdates(update.binary.data);
  const account = builder.getPriceUpdateAccount(`0x${FEED}`);
  const sigs = await receiver.provider.sendAll(await builder.buildVersionedTransactions({ computeUnitPriceMicroLamports: 50_000 }), { skipPreflight: false });
  const a = await fetchEncodedAccount(rpc, address(account.toBase58()), { commitment: 'confirmed' });
  if (!a.exists) throw new Error('price update account not found');
  const o = parsePriceUpdate(a.data);
  const now = BigInt(Math.floor(Date.now() / 1000));
  const ok = isPythReceiver(a.programAddress) && !!o && Buffer.from(o.feedId).equals(Buffer.from(hexToBytes(FEED))) && o.fullyVerified && now - o.publishTime < 120n;
  const usd = o ? Number(o.price) * 10 ** o.exponent : NaN;
  ev.check('pull-post', 'fresh, fully verified 24/7 NVDA price posted and parsed exactly as cross_core will read it', ok, `account ${account.toBase58()}; $${usd.toFixed(4)}; age ${o ? now - o.publishTime : '?'}s; cross units (USDC 6dp, token 8dp, scale 1e8) ${o ? oracleToCrossUnits(o, 6, 8, 100_000_000n) : null}`, sigs[sigs.length - 1]);
}
main().then(() => ev.write(), (e) => { console.error(e); ev.write(e); });
