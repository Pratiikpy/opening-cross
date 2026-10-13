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

const NVDA_FEED = 'a470c4ac46f44b547b2cba52338f311fb642b79375ce5f0cfd5cb5b99227b852'; // Equity.Index.NVDA/USD, 24/7
// The mechanism is feed-independent. When the API key is not entitled to the equity feed (Hermes answers 403 "Not entitled"), the
// same pull path is proved on a feed the key can read, and the equity step is recorded as the failure it is.
const FALLBACK_FEED = 'e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43'; // Crypto.BTC/USD
const ev = new Evidence('DP15-pyth-pull-devnet.md', 'DP15 — Pyth pull update posted on devnet', ['Script `tests/devnet/src/oracle-pull.ts`; Hermes https://pyth.dourolabs.app/hermes (API key); receiver `rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ`']);

async function post(hermes: HermesClient, feed: string, id: string, label: string, decimalsOut: { quote: number; token: number }) {
  const update = await hermes.getLatestPriceUpdates([feed], { encoding: 'base64' });
  const receiver = new PythSolanaReceiver({ connection, wallet: new Wallet(operator) });
  const builder = receiver.newTransactionBuilder({ closeUpdateAccounts: false });
  await builder.addPostPriceUpdates(update.binary.data);
  const account = builder.getPriceUpdateAccount(`0x${feed}`);
  const sigs = await receiver.provider.sendAll(await builder.buildVersionedTransactions({ computeUnitPriceMicroLamports: 50_000 }), { skipPreflight: false });
  const a = await fetchEncodedAccount(rpc, address(account.toBase58()), { commitment: 'confirmed' });
  if (!a.exists) throw new Error('price update account not found');
  const o = parsePriceUpdate(a.data);
  const now = BigInt(Math.floor(Date.now() / 1000));
  const ok = isPythReceiver(a.programAddress) && !!o && Buffer.from(o.feedId).equals(Buffer.from(hexToBytes(feed))) && o.fullyVerified && now - o.publishTime < 120n;
  const usd = o ? Number(o.price) * 10 ** o.exponent : NaN;
  ev.check(id, `fresh, fully verified ${label} price posted and parsed exactly as cross_core will read it`, ok, `account ${account.toBase58()}; $${usd.toFixed(4)}; age ${o ? now - o.publishTime : '?'}s; cross units (quote ${decimalsOut.quote}dp, token ${decimalsOut.token}dp, scale 1e8) ${o ? oracleToCrossUnits(o, decimalsOut.quote, decimalsOut.token, 100_000_000n) : null}`, sigs[sigs.length - 1]);
}

async function main() {
  // Upgraded Hermes endpoint per docs.pyth.network/price-feeds/core/upgrade/preparing.
  const hermes = new HermesClient('https://pyth.dourolabs.app/hermes', { headers: { Authorization: `Bearer ${pythApiKey()}` } });
  try {
    await post(hermes, NVDA_FEED, 'pull-post-nvda', '24/7 NVDA', { quote: 6, token: 8 });
  } catch (e) {
    ev.check('pull-post-nvda', 'fresh, fully verified 24/7 NVDA price posted and parsed exactly as cross_core will read it', false, `Hermes refused the equity feed: ${e instanceof Error ? e.message : String(e)}`);
  }
  await post(hermes, FALLBACK_FEED, 'pull-post-btc', 'BTC/USD (a feed the key is entitled to; proves the pull path itself)', { quote: 6, token: 8 });
}
main().then(() => ev.write(), (e) => { console.error(e); ev.write(e); });
