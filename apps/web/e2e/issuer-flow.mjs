// ROADMAP W4: an issuer opens a cross from the console, as a person would, on a local validator.
// Checks careless inputs, the one-signature mint handover, and the result on chain.
//   SEED=/tmp/oc-e2e.json BASE_URL=http://localhost:3000 OUT=../../docs/evidence/screens/w4 node e2e/issuer-flow.mjs
import { mkdirSync, readFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const seed = JSON.parse(readFileSync(process.env.SEED ?? '/tmp/oc-e2e.json', 'utf8'));
const BASE = process.env.BASE_URL ?? 'http://localhost:3000';
const OUT = process.env.OUT ?? 'e2e/screens/w4';
mkdirSync(OUT, { recursive: true });
const WALLET_JS = readFileSync(new URL('./test-wallet.js', import.meta.url), 'utf8');
const failures = [];
const log = (ok, what) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${what}`);
  if (!ok) failures.push(what);
};
const rpc = async (method, params) => (await (await fetch(seed.rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json()).result;

const browser = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: Number(process.env.DSF ?? 1) });
await ctx.addInitScript(`window.__E2E_WALLET__ = ${JSON.stringify({ name: 'E2E Test Wallet', secret: seed.wallets.issuer.secret, chain: 'solana:localnet' })};`);
await ctx.addInitScript(WALLET_JS);
const page = await ctx.newPage();
const problems = [];
page.on('console', (m) => m.type() === 'error' && problems.push(m.text()));
page.on('pageerror', (e) => problems.push(e.message));

try {
  await page.goto(`${BASE}/issue`, { waitUntil: 'domcontentloaded' });
  log(await page.getByText('Connect the wallet that will own this cross').isVisible(), 'the console asks for a wallet first');
  await page.getByRole('button', { name: 'Connect wallet' }).click();
  await page.getByRole('button', { name: /E2E Test Wallet/ }).click();
  await page.getByLabel(`Connected as ${seed.wallets.issuer.address}`).waitFor();

  // Careless inputs.
  await page.getByLabel('Token being sold (base mint)').fill(seed.wallets.buyer.address);
  await page.getByRole('button', { name: 'Check mint' }).first().click();
  await page.getByText('This address is not a token mint.').waitFor();
  log(true, 'a wallet address entered as a mint is refused');
  await page.getByLabel('Token being sold (base mint)').fill(seed.issuerBaseMint);
  await page.getByRole('button', { name: 'Check mint' }).first().click();
  await page.getByText('6 decimals').first().waitFor();
  await page.getByLabel('Paid in (quote mint)').fill(seed.quoteMint);
  await page.getByRole('button', { name: 'Check mint' }).nth(1).click();
  await page.getByText('6 decimals').nth(1).waitFor();
  log(true, 'both real mints are read from chain (6 decimals)');
  await page.getByLabel('Bids').selectOption('open');
  await page.getByLabel('Step between prices').fill('0');
  log(await page.getByText(/Enter a step above zero/).waitFor({ timeout: 5000 }).then(() => true, () => false), 'a zero price step is refused');
  await page.getByLabel('Step between prices').fill('0.05');
  await page.getByLabel('Step 1: price').fill('1.23');
  log(await page.getByText('This price is not on the grid.').waitFor({ timeout: 5000 }).then(() => true, () => false), 'an off-grid supply step is refused');
  log(await page.getByRole('button', { name: 'Create the cross' }).isDisabled(), 'create stays disabled while anything is invalid');
  await page.getByLabel('Step 1: price').fill('1.20');
  await page.getByLabel('Tokens offered').fill('1000');
  await page.screenshot({ path: `${OUT}/01-issuer-form.png`, fullPage: true });

  await page.getByRole('button', { name: 'Create the cross' }).click();
  await page.getByText('Your cross is on chain.').waitFor({ timeout: 90_000 });
  const cross = (await page.getByTestId('created-cross').textContent()).trim();
  log(cross.length > 30, `cross created: ${cross}`);

  // On chain: the cross exists and now holds the token's mint authority (one signature did both).
  const mint = await rpc('getAccountInfo', [seed.issuerBaseMint, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
  log(mint.value.data.parsed.info.mintAuthority === cross, 'on chain: the mint authority moved to the cross in the same transaction');
  const api = await (await fetch(`http://localhost:8080/v1/crosses/${cross}`)).json();
  log(api.supplyMode === 'mint' && api.disclosure === 'open' && api.grid.tick === '50000', 'on chain: parameters match the form (mint, open, tick 0.05)');

  await page.getByRole('link', { name: 'Open the cross page' }).click();
  await page.getByRole('heading', { level: 1 }).waitFor();
  log(await page.getByText('Opens in').waitFor({ timeout: 15000 }).then(() => true, () => false), 'the new cross page counts down to its opening');
  await page.screenshot({ path: `${OUT}/02-created-cross.png`, fullPage: true });
} catch (e) {
  log(false, `flow stopped: ${e instanceof Error ? e.message.split(String.fromCharCode(10))[0] : String(e)}`);
  await page.screenshot({ path: `${OUT}/failure.png`, fullPage: true }).catch(() => undefined);
}
log(problems.length === 0, `zero console and page errors${problems.length ? ` (${problems.slice(0, 3).join(' | ')})` : ''}`);
await browser.close();
console.log(failures.length ? `${failures.length} FAILED` : 'ALL PASSED');
process.exit(failures.length ? 1 : 0);
