// Browser run of the pool screens against the real network (ROADMAP D9, A10, X8, K5; docs/evidence/W5-1C.md).
//
// It drives the pages the way a person does, in a real Chromium with a Wallet Standard wallet injected the way a wallet extension registers (the shared
// e2e wallet signs with a disposable devnet key through WebCrypto, so every signature is one the cluster verifies):
//
//   MODE=look  every pool page in light and dark, on a desktop and a phone viewport: screenshots, zero console errors, an axe scan against WCAG 2.2 AA
//   MODE=trade connects the wallet on a pool page, prices a buy and a sell, sends both, and compares the quote on screen with the tokens that arrived
//
//   BASE_URL=http://127.0.0.1:3471 API_URL=http://127.0.0.1:8097 OUT=<dir> MODE=look node packages/router/scripts/pools-web-e2e.mjs
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { check, connect, launch, person, report, results, shot, axe, keyFile } from '../../../apps/web/e2e/holder-lib.mjs';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3471';
const API = process.env.API_URL ?? 'http://127.0.0.1:8097';
const RPC = process.env.RPC_URL ?? 'https://api.devnet.solana.com';
const MODE = process.env.MODE ?? 'look';
const POOLS = {
  damm: '5fDuBQZnim5qF8gJHQebPfqS1eLSEhHxo6hurXsmP8AU',
  one: '9zCyWgZoDLutMeci2ntdfsYR4Dnu4TXi81RivPBY4125',
  ladder: '9ND3Gwnt5v8HVduCNKBozEuXTKwpXjtV3TMQDY9GctYG',
};
const CROSS_LADDER = '8fE1rFQ4a6HZtevFKsc2SaeGei1SYLWtiX7LNAnUQNES';
const LIVE_CROSS = process.env.LIVE_CROSS ?? '';

/** The newest throwaway key the pool proof funded (git-ignored). */
function traderKey() {
  const dir = 'C:/Users/prate/col/.keys';
  const files = readdirSync(dir).filter((f) => f.startsWith('devnet-proof-funder-')).map((f) => ({ f, t: statSync(`${dir}/${f}`).mtimeMs })).sort((a, b) => b.t - a.t);
  return keyFile(files[0].f);
}

async function rpc(method, params) {
  // The public devnet endpoint answers a burst with HTTP 429: back off and ask again.
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    const body = await r.json().catch(() => ({}));
    if (body.result !== undefined) return body.result;
    if (attempt >= 8) throw new Error(`${method}: ${JSON.stringify(body).slice(0, 200)}`);
    await new Promise((x) => setTimeout(x, 800 * 2 ** Math.min(attempt, 4)));
  }
}
async function held(owner, mint) {
  const r = await rpc('getTokenAccountsByOwner', [owner, { mint }, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
  return BigInt(r.value[0]?.account.data.parsed.info.tokenAmount.amount ?? '0');
}

async function look() {
  const browser = await launch();
  const pages = [
    ['pools', '/pools', 'Pools'],
    ['pool-damm', `/pools/${POOLS.damm}`, 'Pool'],
    ['pool-dlmm', `/pools/${POOLS.one}`, 'Pool'],
    ['pool-ladder', `/pools/${POOLS.ladder}`, 'Pool'],
    ['issuer', `/pools/issuer/${CROSS_LADDER}`, 'Liquidity health'],
    ['depth-finished', `/pools/depth/${CROSS_LADDER}`, 'Depth and price impact'],
    ...(LIVE_CROSS ? [['depth-live', `/pools/depth/${LIVE_CROSS}`, 'Depth and price impact']] : []),
    ['dashboard', '/dashboard', 'Dashboard'],
  ];
  for (const theme of ['light', 'dark']) {
    for (const [vname, viewport] of [['desktop', { width: 1440, height: 900 }], ['phone', { width: 390, height: 844 }]]) {
      const u = await person(browser, { name: `${vname}-${theme}`, theme, viewport, ignore: ['Failed to load resource'] });
      for (const [name, path, h1] of pages) {
        await u.page.goto(`${BASE}${path}`, { waitUntil: 'load', timeout: 180000 });
        await u.page.getByRole('heading', { level: 1, name: h1 }).waitFor({ timeout: 60000 });
        // Wait until the figures have been read: no "Reading …" status left on the page.
        await u.page.waitForFunction(() => !document.querySelector('[data-testid="loading"]'), null, { timeout: 90000 }).catch(() => undefined);
        await u.page.waitForTimeout(800);
        await shot(u, `${name}-${vname}-${theme}`);
        const noOverflow = await u.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
        check(noOverflow, `${vname}-${theme} ${name}: no horizontal scroll of the page`);
        if (vname === 'desktop' || theme === 'light') {
          const v = await axe(u);
          check(v.length === 0, `${vname}-${theme} ${name}: axe WCAG 2.2 AA${v.length ? ` ${JSON.stringify(v).slice(0, 600)}` : ''}`);
        }
      }
      report(u);
      await u.context.close();
    }
  }
  await browser.close();
}

async function trade() {
  const secret = traderKey();
  const browser = await launch();
  const u = await person(browser, { name: 'trader', secret, theme: 'light', viewport: { width: 1440, height: 900 }, ignore: ['Failed to load resource'] });
  const base = 'BdbY4wWxCKv1CX9xY5XSbjexeZUFQimyhPp86jgmhakt';
  const quote = 'B8yoGNPDWTaWK86Po4V1nBGnqHTCvSKn839kAgrksQHJ';
  await u.page.goto(`${BASE}/pools/${POOLS.ladder}`, { waitUntil: 'load', timeout: 180000 });
  await u.page.getByTestId('pool-view').waitFor({ timeout: 240000 });
  await connect(u);
  await shot(u, 'trade-1-connected');

  const read = async (id) => (await u.page.getByTestId(id).textContent())?.trim();
  const parse = (t) => BigInt(Math.round(Number(t.replace(/,/g, '').split(' ')[0]) * 1e6));

  // Buy 5 base tokens.
  await u.page.getByTestId('side-buy').click();
  await u.page.getByTestId('trade-amount').fill('5');
  await u.page.getByTestId('route-quote').waitFor({ timeout: 150000 });
  const payText = await read('quote-in');
  const outText = await read('quote-out');
  const minText = await read('quote-min');
  await shot(u, 'trade-2-buy-quote');
  check(/^[\d.,]+ /.test(payText ?? '') && /^[\d.,]+ /.test(outText ?? ''), `buy quote on screen: pay ${payText}, receive about ${outText}, at least ${minText}`);
  const baseBefore = await held(u.address, base);
  const quoteBefore = await held(u.address, quote);
  await u.page.getByTestId('swap').click();
  await u.page.getByTestId('swap-confirmed').waitFor({ timeout: 120000 });
  await shot(u, 'trade-3-buy-confirmed');
  const baseAfter = await held(u.address, base);
  const quoteAfter = await held(u.address, quote);
  const gotBase = baseAfter - baseBefore;
  const spentQuote = quoteBefore - quoteAfter;
  check(gotBase >= 5_000_000n, `buy: received ${gotBase} base atoms on chain, at least the 5,000,000 asked for`);
  check(parse(payText) === spentQuote || Math.abs(Number(parse(payText) - spentQuote)) <= 1, `buy: the quote paid on screen (${payText}) equals what left the wallet on chain (${spentQuote} atoms)`);
  check(Math.abs(Number(parse(outText) - gotBase)) <= 1 || parse(minText) <= gotBase, `buy: tokens received on chain (${gotBase}) at or above the minimum shown (${minText})`);

  // Sell back 2 base tokens.
  await u.page.getByTestId('side-sell').click();
  await u.page.getByTestId('trade-amount').fill('2');
  await u.page.getByTestId('route-quote').waitFor({ timeout: 150000 }).catch(async (e) => {
    await shot(u, 'trade-4-fail');
    console.log('panel text:', (await u.page.getByTestId('trade-panel').innerText()).slice(0, 600));
    throw e;
  });
  const sellOut = await read('quote-out');
  const sellMin = await read('quote-min');
  await shot(u, 'trade-4-sell-quote');
  const b2 = await held(u.address, base);
  const q2 = await held(u.address, quote);
  await u.page.getByTestId('swap').click();
  await u.page.getByTestId('swap-confirmed').waitFor({ timeout: 120000 });
  await shot(u, 'trade-5-sell-confirmed');
  const b3 = await held(u.address, base);
  const q3 = await held(u.address, quote);
  check(b2 - b3 === 2_000_000n, `sell: exactly 2,000,000 base atoms left the wallet (${b2 - b3})`);
  check(q3 - q2 >= parse(sellMin), `sell: received ${q3 - q2} quote atoms on chain, at least the minimum shown (${sellMin}); quote said about ${sellOut}`);

  // A trade the wallet cannot afford is refused on the page, before anything is signed.
  await u.page.getByTestId('side-buy').click();
  await u.page.getByTestId('trade-amount').fill('300');
  await u.page.getByTestId('route-quote').waitFor({ timeout: 150000 }).catch(() => undefined);
  await shot(u, 'trade-6-too-large');
  const state = await u.page.getByTestId('swap').isDisabled().catch(() => null);
  check(state === true || (await u.page.getByTestId('quote-partial').isVisible().catch(() => false)) || (await u.page.getByTestId('route-pool-excluded').isVisible().catch(() => false)), 'buy of 300 base tokens: the pool cannot supply it, the page says so and does not offer a swap that would fail');
  report(u);
  await browser.close();
}

try {
  if (MODE === 'trade') await trade();
  else await look();
} finally {
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) process.exitCode = 1;
}
void API;
