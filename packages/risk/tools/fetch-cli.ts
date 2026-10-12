// pnpm --filter @opening-cross/risk history -- AAPL TSLA NVDA        (default: the whole universe)
import { UNIVERSE, fetchBars } from './fetch-history.js';

const tickers = process.argv.slice(2).filter((a) => !a.startsWith('-'));
for (const t of tickers.length ? tickers : UNIVERSE) {
  const bars = await fetchBars(t, '10y', true);
  console.log(`${t}: ${bars.length} bars, ${bars[0]?.date} to ${bars.at(-1)?.date}`);
  await new Promise((r) => setTimeout(r, 400));
}
