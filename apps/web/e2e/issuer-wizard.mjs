// The issuer wizard as a person uses it, on Solana devnet: explore without a wallet, choose a listing type, read a real token,
// set guards and the float and value rules, run the simulator, connect a wallet, create the cross, and read the result back from
// the chain and the API. Also checks 390 px for horizontal overflow.
//
//   SEED=seed.json ISSUER_KEY=issuer.json BASE_URL=http://localhost:3210 API_URL=http://127.0.0.1:8090 OUT=../../docs/evidence/screens/w2b \
//   CHROME=... node e2e/issuer-wizard.mjs
//
// SEED holds { base, quote }: a 6-decimal base mint whose mint authority is the issuer and which has 9,000 tokens minted, and a
// 6-decimal quote mint of which the issuer holds at least 100. ISSUER_KEY is a Solana CLI keypair file with about 0.2 devnet SOL.
import { mkdirSync, readFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const seed = JSON.parse(readFileSync(process.env.SEED, 'utf8'));
const key = JSON.parse(readFileSync(process.env.ISSUER_KEY, 'utf8'));
const BASE = process.env.BASE_URL ?? 'http://localhost:3210';
const API = process.env.API_URL ?? 'http://127.0.0.1:8090';
const RPC = process.env.RPC_URL ?? 'https://api.devnet.solana.com';
const OUT = process.env.OUT ?? 'e2e/screens/w2b';
mkdirSync(OUT, { recursive: true });
const WALLET_JS = readFileSync(new URL('./test-wallet.js', import.meta.url), 'utf8');
const failures = [];
const log = (ok, what) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${what}`);
  if (!ok) failures.push(what);
};
const rpc = async (method, params) => {
  for (let i = 0; i < 8; i++) {
    const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    if (r.status === 429) {
      await new Promise((s) => setTimeout(s, 1500 * (i + 1)));
      continue;
    }
    return (await r.json()).result;
  }
  throw new Error('rpc kept answering 429');
};
const visible = (loc, ms = 8000) => loc.waitFor({ state: 'visible', timeout: ms }).then(() => true, () => false);

const browser = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, timezoneId: 'UTC' });
await ctx.addInitScript(`window.__E2E_WALLET__ = ${JSON.stringify({ name: 'E2E Test Wallet', secret: key, chain: 'solana:devnet' })};`);
await ctx.addInitScript(WALLET_JS);
const page = await ctx.newPage();
const problems = [];
page.on('console', (m) => m.type() === 'error' && problems.push(`console: ${m.text()}`));
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
page.on('response', (r) => {
  if (r.status() >= 400 && !/[?&]_rsc=/.test(r.url()) && !/\/v1\/tokens\/.*\/authenticity/.test(r.url())) problems.push(`http ${r.status()}: ${r.request().method()} ${r.url().slice(0, 100)}`);
});

try {
  await page.goto(`${BASE}/issue`, { waitUntil: 'networkidle' });
  const t0 = Date.now();

  // ---- explore: nothing needs a wallet
  log(await visible(page.getByTestId('explore-note')), 'without a wallet the page says it can be explored and asks for no identity check');
  log((await page.getByRole('radiogroup', { name: 'Listing type' }).getByRole('radio').count()) === 8, 'eight listing types are offered');
  await page.getByTestId('listing-pre-ipo').click();
  log(await visible(page.getByTestId('listing-blocker')), 'a type that needs a licensed partner says what is missing');
  log(/licen|SPV|partner/i.test((await page.getByTestId('listing-blocker').textContent()) ?? ''), 'and does not pretend it can be created');
  await page.getByTestId('listing-ownership-coin').click();
  log(await visible(page.getByTestId('preset-note')), 'an available type applies its format and says what it left alone');
  log((await page.getByLabel('Bids').inputValue()) === 'sealed', 'the ownership coin starts sealed');
  log(await page.getByTestId('step-type').getAttribute('data-status') === 'done', 'the checklist marks the type done');

  // ---- read the real token
  await page.getByLabel('Token being sold (base mint)').fill(seed.base);
  await page.getByLabel('Paid in (quote mint)').fill(seed.quote);
  await page.getByRole('button', { name: 'Check mint' }).first().click();
  await page.getByRole('button', { name: 'Check mint' }).nth(1).click();
  log(await visible(page.getByTestId('autofill'), 20_000), 'the token is read from the chain');
  const facts = (await page.getByTestId('autofill').textContent()) ?? '';
  log(/6 decimals/.test(facts) && /supply already minted/.test(facts), 'its decimals and its existing supply are shown');
  log(/Connect the wallet that holds it/.test(facts), 'with no wallet, the page does not claim the wallet is wrong');
  await page.screenshot({ path: `${OUT}/wizard-01-explore.png`, fullPage: false });

  // ---- the grid and the supply
  await page.getByLabel('Bids').selectOption('open');
  await page.getByLabel('Step 1: price').fill('1.20');
  await page.getByLabel('Tokens offered').fill('1000');

  // ---- guards: a raise target becomes a minimum volume
  await page.getByLabel('Raise target, in quote tokens (optional)').fill('360');
  await page.getByTestId('use-raise').click();
  const min = await page.getByLabel('Minimum tokens traded to print (optional)').inputValue();
  log(min === '360', `a 360 raise target at the lowest price 1.00 sets the minimum volume to 360 tokens (got ${min})`);
  log(await visible(page.getByTestId('raise-range')), 'the accepted range is stated');
  await page.getByLabel('Minimum tokens traded to print (optional)').fill('1500');
  log((await page.getByTestId('check-guard-volume').getAttribute('data-status')) === 'fail', 'a minimum above the supply you list fails readiness (it could never print)');
  await page.getByLabel('Minimum tokens traded to print (optional)').fill('360');
  await page.getByLabel('Maximum imbalance, % (optional)').fill('50');
  log((await page.getByTestId('guard-imbalance').getAttribute('data-severity')) === 'warn', 'a tight imbalance limit is warned about');

  // ---- float and value rules
  await page.getByLabel('Minimum float, % (optional)').fill('5');
  log(/473\.684211/.test((await page.getByTestId('float-translation').textContent()) ?? ''), 'a 5% float becomes a minimum volume of 473.684211 tokens (9,000 minted)');
  await page.getByLabel(/Highest fully diluted value/).fill('20000');
  log((await page.getByTestId('check-rule-fdv').getAttribute('data-status')) === 'fail', 'a value ceiling the grid exceeds fails readiness');
  await page.getByTestId('fit-grid').click();
  log((await page.getByTestId('check-rule-fdv').getAttribute('data-status')) === 'pass', 'shortening the grid to fit makes it pass');

  // ---- the simulator
  await page.getByLabel('Limit price 1', { exact: true }).fill('1.50');
  await page.getByLabel('Tokens wanted 1', { exact: true }).fill('800');
  log(await visible(page.getByTestId('scenario-base')), 'the simulator shows scenarios');
  const base = (await page.getByTestId('scenario-base').textContent()) ?? '';
  log(/1\.2 quote/.test(base) && /800/.test(base), 'at 800 tokens of demand the cross clears at 1.2 for 800 tokens');
  log((await page.getByTestId('scenario-low').getAttribute('data-printed')) === 'false', 'at half the demand it does not print, because 400 is below the 473.684211 float minimum');
  log((await page.getByTestId('scenario-high').getAttribute('data-printed')) === 'false', 'at double the demand the 50% imbalance limit stops it (the footgun is visible)');
  await page.getByLabel('Maximum imbalance, % (optional)').fill('');
  log((await page.getByTestId('scenario-high').getAttribute('data-printed')) === 'true', 'clearing the imbalance limit lets the oversubscribed case print');
  log(await visible(page.getByTestId('ladder')), 'the demand and supply ladder is drawn');
  await page.screenshot({ path: `${OUT}/wizard-02-simulator.png`, fullPage: false });

  // ---- connect and create
  await page.getByRole('button', { name: 'Connect wallet' }).click();
  await page.getByRole('button', { name: /E2E Test Wallet/ }).click();
  await page.getByLabel(/Connected as /).waitFor();
  log(await visible(page.getByTestId('autofill-apply'), 20_000), 'once connected, the token reads as the wallet’s own and suggestions appear');
  await page.getByTestId('autofill-apply').click();
  await page.waitForFunction(() => document.querySelector('[data-testid="readiness-summary"]')?.textContent !== 'Reading the chain…', null, { timeout: 30_000 });
  await page.waitForTimeout(1500);
  const states = await page.locator('[data-testid^="check-"]').evaluateAll((els) => els.map((e) => `${e.getAttribute('data-testid')}=${e.getAttribute('data-status')}`));
  console.log(states.join(' '));
  log(states.every((s) => !/=fail|=wait/.test(s)), 'every readiness item passes or warns');
  await page.screenshot({ path: `${OUT}/wizard-03-ready.png`, fullPage: false });
  const elapsedMin = ((Date.now() - t0) / 60000).toFixed(1);
  console.log(`draft complete in ${elapsedMin} minutes of scripted work (not a user study)`);

  await page.getByRole('button', { name: 'Create the cross' }).click();
  await page.getByText('Your cross is on chain.').waitFor({ timeout: 120_000 });
  const cross = ((await page.getByTestId('created-cross').textContent()) ?? '').trim();
  log(cross.length > 30, `cross created: ${cross}`);

  const mint = await rpc('getAccountInfo', [seed.base, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
  log(mint.value.data.parsed.info.mintAuthority === cross, 'on chain: the mint authority moved to the cross');
  const api = await (await fetch(`${API}/v1/crosses/${cross}`)).json();
  log(api.supplyMode === 'mint' && api.disclosure === 'open' && api.kind === 'launch', 'on chain: the format matches the form');
  await page.screenshot({ path: `${OUT}/wizard-04-created.png`, fullPage: false });
  process.env.CROSS = cross;
} catch (e) {
  log(false, `flow stopped: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
  await page.screenshot({ path: `${OUT}/wizard-failure.png`, fullPage: true }).catch(() => undefined);
}
log(problems.length === 0, `zero console and page errors${problems.length ? ` (${problems.slice(0, 4).join(' | ')})` : ''}`);

// ---- 390 px: no horizontal overflow on the wizard
const m = await browser.newContext({ viewport: { width: 390, height: 844 }, timezoneId: 'UTC' });
const mp = await m.newPage();
await mp.goto(`${BASE}/issue`, { waitUntil: 'networkidle' });
const overflow = await mp.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
log(overflow <= 0, `390 px: no horizontal overflow (${overflow}px)`);
await mp.screenshot({ path: `${OUT}/wizard-05-mobile.png`, fullPage: false });
await browser.close();
console.log(failures.length ? `${failures.length} FAILED` : 'ALL PASSED');
process.exit(failures.length ? 1 : 0);
