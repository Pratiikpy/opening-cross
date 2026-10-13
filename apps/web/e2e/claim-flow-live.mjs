// A real claim, end to end on devnet through the browser: a wallet opens an escrow cross from the issuer console (readiness checklist, preset), places a
// buy order after accepting the risks (and is not asked again after a reload), the call closes with no seller so the cross cannot print, the wallet settles
// it from the cross page, and the claim center on /orders lists the refundable order and claims it with Claim all. The refund is read from the chain.
//
//   BASE_URL=http://localhost:3400 API_URL=https://<api> KEY=.keys/live-buyer.json OUT=<dir> CHROME=<chrome.exe> node e2e/claim-flow-live.mjs
//
// Costs about 0.17 SOL of devnet rent for the cross (it is not reclaimed unless someone finalizes it). The key is a Solana CLI keypair file, read only here.
import { mkdirSync, readFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const BASE = process.env.BASE_URL ?? 'http://localhost:3400';
const API = process.env.API_URL ?? 'https://98-87-59-136.sslip.io';
const RPC = process.env.RPC_URL ?? 'https://api.devnet.solana.com';
const OUT = process.env.OUT ?? 'e2e/screens/claim-flow';
const BASE_MINT = process.env.BASE_MINT ?? 'HV2P22LJPewKomy7aN4CV1dTd2Dwpsi6Ta76fDAJFXQc';
const QUOTE_MINT = process.env.QUOTE_MINT ?? 'B78M2HhTHtR2wF3oxR4ikkBupc5TgtBbQbukYXwJEizm';
mkdirSync(OUT, { recursive: true });
const key = JSON.parse(readFileSync(process.env.KEY, 'utf8'));
const WALLET_JS = readFileSync(new URL('./test-wallet.js', import.meta.url), 'utf8');
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const b58 = (bytes) => {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let s = '';
  while (n > 0n) { s = ALPHABET[Number(n % 58n)] + s; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; s = '1' + s; }
  return s;
};
const owner = b58(Uint8Array.from(key.slice(32)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rpc = async (method, params) => {
  for (let i = 0; i < 8; i++) {
    const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    if (r.status === 429) { await sleep(1500 * (i + 1)); continue; }
    return (await r.json()).result;
  }
  throw new Error('rpc kept answering 429');
};
const quoteBalance = async () => ((await rpc('getTokenAccountsByOwner', [owner, { mint: QUOTE_MINT }, { encoding: 'jsonParsed', commitment: 'confirmed' }]))?.value ?? []).reduce((a, x) => a + BigInt(x.account.data.parsed.info.tokenAmount.amount), 0n);
const failures = [];
const log = (ok, what) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${what}`); if (!ok) failures.push(what); };
const minute = (t) => new Date(t).toISOString().slice(0, 16);

const browser = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light', timezoneId: 'UTC' });
await ctx.addInitScript(`window.__E2E_WALLET__ = ${JSON.stringify({ name: 'E2E Test Wallet', secret: key, chain: 'solana:devnet' })};`);
await ctx.addInitScript(WALLET_JS);
const page = await ctx.newPage();
const problems = [];
page.on('console', (m) => m.type() === 'error' && problems.push(`console: ${m.text()}`));
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
page.on('requestfailed', (r) => { if (r.failure()?.errorText !== 'net::ERR_ABORTED') problems.push(`requestfailed: ${r.url()} ${r.failure()?.errorText}`); });
const connect = async () => {
  const option = page.getByRole('button', { name: /E2E Test Wallet/ });
  for (let attempt = 1; !(await option.isVisible()); attempt++) {
    if (attempt > 8) throw new Error('the wallet list never opened');
    await page.getByRole('button', { name: 'Connect wallet' }).click();
    await option.waitFor({ timeout: 4000 }).catch(() => undefined);
  }
  await option.click();
  await page.getByLabel(`Connected as ${owner}`).waitFor();
};
const shot = (name) => page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });

try {
  // ---- 1. open an escrow cross from the console
  await page.goto(`${BASE}/issue`, { waitUntil: 'domcontentloaded' });
  await connect();
  await page.getByLabel('Token being sold (base mint)').fill(BASE_MINT);
  await page.getByRole('button', { name: 'Check mint' }).nth(0).click();
  await page.getByText('6 decimals').first().waitFor({ timeout: 30_000 });
  await page.getByLabel('Paid in (quote mint)').fill(QUOTE_MINT);
  await page.getByRole('button', { name: 'Check mint' }).nth(1).click();
  await page.getByTestId('preset-reopen').click();
  const openAt = Date.now() + 150_000;
  const closeAt = openAt + 150_000;
  await page.getByLabel('Orders open').fill(minute(openAt));
  await page.getByLabel('Orders close').fill(minute(closeAt));
  await page.waitForFunction(() => document.querySelector('[data-testid="readiness-summary"]')?.textContent?.includes('Everything is ready'), null, { timeout: 60_000 });
  log(true, 'the checklist reports everything ready for this wallet and these mints');
  await shot('01-issue-ready');
  await page.getByRole('button', { name: 'Create the cross' }).click();
  await page.getByText('Your cross is on chain.').waitFor({ timeout: 120_000 });
  const cross = (await page.getByTestId('created-cross').textContent()).trim();
  log(cross.length > 30, `cross created: ${cross}`);
  const detail = await (await fetch(`${API}/v1/crosses/${cross}`)).json();
  const openTs = Number(detail.window.openTs);
  const closeTs = Number(detail.window.closeTs);

  // ---- 2. place a buy order; the risk step appears once
  while (Date.now() / 1000 < openTs + 5) await sleep(3000);
  await page.goto(`${BASE}/crosses/${cross}`, { waitUntil: 'domcontentloaded' });
  await page.getByLabel(/per token/).waitFor({ timeout: 60_000 });
  await page.getByLabel(/per token/).fill('1.20');
  await page.getByLabel('Tokens').fill('3');
  log(await page.getByTestId('risk-ack').isVisible(), 'first order on this device: the risk acknowledgement is shown');
  log(await page.getByRole('button', { name: 'Place order' }).isDisabled(), 'Place order stays off until the risks are accepted');
  await shot('02-risk-ack');
  await page.getByRole('checkbox', { name: /understand the risks/ }).check();
  const before = await quoteBalance();
  await page.getByRole('button', { name: 'Place order' }).click();
  await page.getByText('Order placed.').waitFor({ timeout: 90_000 });
  log(before - (await quoteBalance()) === 3_600_000n, 'on chain: 3.6 quote moved into escrow');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByLabel(/per token/).waitFor();
  await sleep(1000);
  log((await page.getByTestId('risk-ack').count()) === 0, 'after a reload the same wallet is not asked again');

  // ---- 3. the call closes with no seller; settle it
  while (Date.now() / 1000 < closeTs + 5) await sleep(3000);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Settle this cross' }).waitFor({ timeout: 60_000 });
  await page.getByRole('button', { name: 'Settle this cross' }).click();
  await page.getByText(/did not print/i).first().waitFor({ timeout: 90_000 });
  log(true, 'the cross settled and did not print (no seller)');

  // ---- 4. claim it from the claim center
  const owed = await quoteBalance();
  await page.goto(`${BASE}/orders`, { waitUntil: 'domcontentloaded' });
  await page.getByTestId('claim-list').waitFor({ timeout: 120_000 });
  const rows = page.getByTestId('claim-row');
  log((await rows.count()) >= 1 && (await rows.first().innerText()).includes('refund due'), 'the claim center lists the order as a refund due');
  await shot('03-claim-center-before');
  await page.getByRole('button', { name: /Claim all/ }).click();
  await page.locator('[data-testid="claim-row"][data-phase="done"]').first().waitFor({ timeout: 120_000 });
  log(true, 'the row shows Claimed after its transaction confirmed');
  log((await quoteBalance()) - owed === 3_600_000n, 'on chain: the full 3.6 quote escrow came back');
  await shot('04-claim-center-after');
} catch (e) {
  failures.push(String(e));
  console.log('ERROR', e);
  await shot('error').catch(() => undefined);
}
for (const p of problems) console.log('  problem:', p);
log(problems.length === 0, 'no console errors, page errors or failed requests');
await browser.close();
console.log(failures.length ? `${failures.length} FAILED` : 'all passed');
process.exit(failures.length ? 1 : 0);
