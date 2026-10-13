// A wallet that cannot fund an order is stopped with a sentence naming the shortfall, not with a failed simulation.
//   CROSS=<live open cross> WALLET_KEY=<keypair json of a wallet holding none of the quote token> BASE_URL=... node e2e/shortfall-check.mjs
import { readFileSync } from 'node:fs';
import { chromium } from '@playwright/test';
const BASE = process.env.BASE_URL ?? 'https://opening-bell-psi.vercel.app';
const key = JSON.parse(readFileSync(process.env.WALLET_KEY, 'utf8'));
const browser = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
await ctx.addInitScript(`window.__E2E_WALLET__ = ${JSON.stringify({ name: 'E2E Test Wallet', secret: key, chain: 'solana:devnet' })};`);
await ctx.addInitScript(readFileSync(new URL('./test-wallet.js', import.meta.url), 'utf8'));
const page = await ctx.newPage();
const problems = [];
page.on('console', (m) => m.type() === 'error' && problems.push(m.text()));
page.on('pageerror', (e) => problems.push(e.message));
await page.goto(`${BASE}/crosses/${process.env.CROSS}`, { waitUntil: 'domcontentloaded' });
const option = page.getByRole('button', { name: /E2E Test Wallet/ });
for (let i = 0; !(await option.isVisible()); i++) {
  if (i > 8) throw new Error('wallet list never opened');
  await page.getByRole('button', { name: 'Connect wallet' }).click();
  await option.waitFor({ timeout: 4000 }).catch(() => undefined);
}
await option.click();
await page.getByLabel(/per token/).waitFor({ timeout: 60_000 });
await page.getByLabel(/per token/).fill('1.30');
await page.getByLabel('Tokens').fill('600');
const note = await page.getByTestId('shortfall').waitFor({ timeout: 30_000 }).then(() => page.getByTestId('shortfall').innerText(), () => null);
const disabled = await page.getByRole('button', { name: /Place (sealed )?order/ }).isDisabled();
console.log(note ? `PASS shortfall shown: ${note}` : 'FAIL no shortfall message');
console.log(disabled ? 'PASS Place order is disabled' : 'FAIL Place order is enabled');
console.log(problems.length ? `FAIL console: ${problems.join(' | ').slice(0, 200)}` : 'PASS zero console errors');
await browser.close();
process.exit(note && disabled && !problems.length ? 0 : 1);
