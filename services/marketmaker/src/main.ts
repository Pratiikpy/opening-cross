// Market-maker process. Required: API_URL, RPC_URL, MM_KEYPAIR, MM_QUOTE_BUDGET, MM_BASE_BUDGET. See docs/CONFIGURATION.md.
// The bot's address must be listed in OWN_WALLETS of the API so that its orders count as ours, not as outside users'.
import { MarketMaker } from './bot.js';
import { ConfigError, loadConfig } from './config.js';
import { fileStore, makeApi, makeChain, makeLog, readSealSecret } from './runtime.js';

let cfg;
try {
  cfg = loadConfig();
} catch (e) {
  console.error(e instanceof ConfigError ? e.message : String(e));
  process.exit(2);
}
const log = makeLog(cfg.logPath);
const { chain, owner } = await makeChain(cfg, log);
const bot = new MarketMaker({ cfg, owner, api: makeApi(cfg.apiUrl), chain, sealSecret: readSealSecret(cfg.sealSecretFile), store: fileStore(cfg.statePath), log });
log({ event: 'start', owner, cluster: cfg.cluster, dryRun: cfg.dryRun, strategy: { ...cfg.strategy, quoteBudget: cfg.strategy.quoteBudget.toString(), baseBudget: cfg.strategy.baseBudget.toString() }, kinds: [...cfg.kinds], note: 'add this address to OWN_WALLETS' });

let stop = false;
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => (stop = true));
let n = 0;
while (!stop) {
  try {
    await bot.pass();
    if (++n % 20 === 0) {
      const v = await bot.volume();
      log({ event: 'volume', orders: v.orders, filled: v.filled, quoteOut: v.quoteOut.toString(), baseOut: v.baseOut.toString(), fees: v.fees.toString() });
    }
  } catch (e) {
    log({ event: 'error', where: 'pass', message: e instanceof Error ? e.message : String(e) });
  }
  await new Promise((r) => setTimeout(r, cfg.passMs));
}
log({ event: 'stop' });
