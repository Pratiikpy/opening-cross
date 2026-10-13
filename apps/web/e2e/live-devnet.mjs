// A real user's whole path on a deployed stack over Solana devnet: an issuer opens a cross from the console, a buyer places an
// order from the cross page, the promiser signs a band while the call is open, and after the close the keeper settles, claims
// and finalizes it with nobody pressing anything. Every transaction is built by the API, signed by a Wallet Standard wallet
// in the page and sent to devnet; outcomes are read from chain and from the API, not only from the screen.
//
//   SEED=seed.json ISSUER_KEY=issuer.json BUYER_KEY=buyer.json API_URL=https://<api> BASE_URL=https://<web> \
//   OUT=../../docs/evidence/screens/w2-live node e2e/live-devnet.mjs
//
// SEED holds { base, quote }: a 6-decimal base mint whose mint authority is the issuer, and a 6-decimal quote mint of which the
// buyer holds at least 780. The two keys are Solana CLI keypair files funded with devnet SOL. The keeper deployed with the
// stack must be scoped to include the issuer's address (KEEPER_CREATORS).
import { mkdirSync, readFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const seed = JSON.parse(readFileSync(process.env.SEED, 'utf8'));
const issuer = JSON.parse(readFileSync(process.env.ISSUER_KEY, 'utf8'));
const buyer = JSON.parse(readFileSync(process.env.BUYER_KEY, 'utf8'));
const API = process.env.API_URL;
const BASE = process.env.BASE_URL;
const RPC = process.env.RPC_URL ?? 'https://api.devnet.solana.com';
const OUT = process.env.OUT ?? 'e2e/screens/live';
const OPEN_IN_MIN = Number(process.env.OPEN_IN_MIN ?? 2);
const OPEN_FOR_MIN = Number(process.env.OPEN_FOR_MIN ?? 12);
if (!API || !BASE || !process.env.SEED || !process.env.ISSUER_KEY || !process.env.BUYER_KEY) throw new Error('set SEED, ISSUER_KEY, BUYER_KEY, API_URL and BASE_URL');
mkdirSync(OUT, { recursive: true });
const WALLET_JS = readFileSync(new URL('./test-wallet.js', import.meta.url), 'utf8');

const failures = [];
const log = (ok, what) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${what}`);
  if (!ok) failures.push(what);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rpc = async (method, params) => {
  for (let i = 0; i < 8; i++) {
    const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    if (r.status === 429) { await sleep(1500 * (i + 1)); continue; }
    return (await r.json()).result;
  }
  throw new Error('rpc kept answering 429');
};
const api = async (path) => {
  const r = await fetch(API + path);
  return { status: r.status, body: await r.json().catch(() => null) };
};
const tokenBalance = async (owner, mint) => ((await rpc('getTokenAccountsByOwner', [owner, { mint }, { encoding: 'jsonParsed', commitment: 'confirmed' }]))?.value ?? []).reduce((a, x) => a + BigInt(x.account.data.parsed.info.tokenAmount.amount), 0n);
async function until(what, fn, ms, every = 5000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(every);
  }
}
const local = (t) => new Date(t).toISOString().slice(0, 16); // the browser runs in UTC

// Base58 of a keypair's public half, the way the wallet derives it.
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const b58 = (bytes) => {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let s = '';
  while (n > 0n) { s = ALPHABET[Number(n % 58n)] + s; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; s = '1' + s; }
  return s;
};
const issuerAddr = b58(Uint8Array.from(issuer.slice(32)));
const buyerAddr = b58(Uint8Array.from(buyer.slice(32)));

const browser = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
async function user(name, key, theme, viewport) {
  const ctx = await browser.newContext({ viewport, colorScheme: theme, timezoneId: 'UTC', deviceScaleFactor: 1 });
  await ctx.addInitScript(`window.__E2E_WALLET__ = ${JSON.stringify({ name: 'E2E Test Wallet', secret: key, chain: 'solana:devnet' })};`);
  await ctx.addInitScript(WALLET_JS);
  const page = await ctx.newPage();
  const problems = [];
  page.on('console', (m) => m.type() === 'error' && problems.push(`console: ${m.text()}`));
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('response', (r) => { if (r.status() >= 400 && !/[?&]_rsc=/.test(r.url())) problems.push(`http ${r.status()}: ${r.request().method()} ${r.url().slice(0, 90)} ${String(r.request().postData() ?? '').slice(0, 80)}`); });
  page.on('requestfailed', (r) => {
    // A reload cancels the page's in-flight fetches (and the router its prefetches): a cancellation is not a failure.
    if (r.failure()?.errorText === 'net::ERR_ABORTED') return;
    problems.push(`requestfailed: ${r.url()} ${r.failure()?.errorText}`);
  });
  return { name, page, problems };
}
const connect = async (u, address) => {
  // A click that lands before the page has hydrated does nothing, as for a person: click again until the wallet list opens.
  const option = u.page.getByRole('button', { name: /E2E Test Wallet/ });
  for (let attempt = 1; !(await option.isVisible()); attempt++) {
    if (attempt > 8) throw new Error('the wallet list never opened');
    await u.page.getByRole('button', { name: 'Connect wallet' }).click();
    await option.waitFor({ timeout: 4000 }).catch(() => undefined);
  }
  await option.click();
  await u.page.getByLabel(`Connected as ${address}`).waitFor();
};
// The public devnet endpoint answers bursts with 429; a person clicks the button again, so the script does too.
async function checkMint(page, nth) {
  for (let attempt = 1; ; attempt++) {
    await page.getByRole('button', { name: 'Check mint' }).nth(nth).click();
    if (await page.getByText('6 decimals').nth(nth).waitFor({ timeout: 15_000 }).then(() => true, () => false)) return;
    if (attempt >= 6) throw new Error('the mint never resolved after 6 clicks');
  }
}
const shot = (u, name) => u.page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });

const I = await user('issuer', issuer, 'light', { width: 1440, height: 900 });
const B = await user('buyer', buyer, 'dark', { width: 390, height: 844 });
let cross;
try {
  // ---- the issuer opens a cross
  await I.page.goto(`${BASE}/issue`, { waitUntil: 'domcontentloaded' });
  await connect(I, issuerAddr);
  await I.page.getByLabel('Token being sold (base mint)').fill(seed.base);
  await checkMint(I.page, 0);
  await I.page.getByLabel('Paid in (quote mint)').fill(seed.quote);
  await checkMint(I.page, 1);
  log(true, 'both mints are read from devnet through the deployed app');
  await I.page.getByLabel('Bids').selectOption('open');
  await I.page.getByLabel('Step between prices').fill('0.05');
  await I.page.getByLabel('Step 1: price').fill('1.20');
  await I.page.getByLabel('Tokens offered').fill('1000');
  await I.page.getByLabel('Orders open').fill(local(Date.now() + OPEN_IN_MIN * 60_000));
  await I.page.getByLabel('Orders close').fill(local(Date.now() + OPEN_FOR_MIN * 60_000));
  await shot(I, '01-issuer-form');
  await I.page.getByRole('button', { name: 'Create the cross' }).click();
  await I.page.getByText('Your cross is on chain.').waitFor({ timeout: 120_000 });
  cross = (await I.page.getByTestId('created-cross').textContent()).trim();
  log(cross.length > 30, `cross created from the console: ${cross}`);
  const mint = await rpc('getAccountInfo', [seed.base, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
  log(mint.value.data.parsed.info.mintAuthority === cross, 'on chain: the base mint authority moved to the cross');
  await until('the indexer to see the cross', async () => (await api(`/v1/crosses/${cross}`)).status === 200, 600_000);
  const c = (await api(`/v1/crosses/${cross}`)).body;
  log(c.creator === issuerAddr && c.disclosure === 'open' && c.supplyMode === 'mint', 'the API serves the new cross with the form parameters');

  // ---- the buyer orders once it is open
  await B.page.goto(`${BASE}/crosses/${cross}`, { waitUntil: 'domcontentloaded' });
  await B.page.getByRole('heading', { level: 1 }).waitFor();
  await connect(B, buyerAddr);
  await until('the call to open', async () => Date.now() / 1000 >= Number(c.window.openTs) + 5, 600_000, 3000);
  await B.page.reload({ waitUntil: 'domcontentloaded' });
  await B.page.getByLabel(/per token/).waitFor({ timeout: 60_000 });
  const quoteBefore = await tokenBalance(buyerAddr, seed.quote);
  await B.page.getByLabel(/per token/).fill('1.30');
  await B.page.getByLabel('Tokens').fill('600');
  await B.page.getByRole('button', { name: /Place (sealed )?order/ }).click();
  await B.page.getByText('Order placed.').waitFor({ timeout: 120_000 });
  const quoteAfter = await tokenBalance(buyerAddr, seed.quote);
  log(quoteBefore - quoteAfter === 780_000_000n, `on chain: 780 quote moved into escrow (${quoteBefore - quoteAfter} base units)`);
  await shot(B, '02-buyer-order-placed');

  // ---- the promiser signs a band while the call is open
  const promise = await until('a signed band for the cross', async () => {
    const r = await api(`/v1/crosses/${cross}/promise`);
    return r.status === 200 ? r.body : null;
  }, 900_000, 10_000);
  log(typeof promise.promise?.id === 'string' && promise.signature !== undefined, `the promiser signed a band (id ${promise.promise?.id?.slice(0, 16)}…, point tick ${promise.promise?.point?.tick ?? promise.promise?.pointTick})`);
  await B.page.reload({ waitUntil: 'domcontentloaded' });
  const band = await B.page.getByTestId('signed-band').waitFor({ timeout: 60_000 }).then(() => true, () => false);
  log(band, 'the cross page shows the signed band');
  await shot(B, '03-cross-page-with-signed-band');

  // ---- close, then the keeper does the rest
  await until('the call to close', async () => Date.now() / 1000 >= Number(c.window.closeTs) + 5, 1_200_000, 5000);
  const done = await until('the keeper to finalize the cross', async () => {
    const r = (await api(`/v1/crosses/${cross}`)).body;
    return r?.state === 'Finalized' ? r : null;
  }, 1_500_000, 15_000);
  log(done.state === 'Finalized' && done.clearing !== null, `the keeper cleared and finalized the cross at ${done.clearing?.price}, matched ${done.clearing?.matched}`);
  const baseGot = await tokenBalance(buyerAddr, seed.base);
  log(baseGot > 0n, `on chain: the buyer received ${baseGot} base units without doing anything after ordering`);
  const grade = await until('the promiser to grade the band', async () => {
    const r = await api(`/v1/crosses/${cross}/promise`);
    return r.status === 200 && r.body.grade ? r.body.grade : null;
  }, 600_000, 10_000).catch(() => null);
  log(Boolean(grade), `the band was graded against the cleared price: ${JSON.stringify(grade)}`);
  await B.page.reload({ waitUntil: 'domcontentloaded' });
  await B.page.getByRole('heading', { level: 1 }).waitFor();
  await shot(B, '04-cross-page-after-settlement');
} catch (e) {
  log(false, `flow stopped: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
  for (const u of [I, B]) await shot(u, `failure-${u.name}`).catch(() => undefined);
}
for (const u of [I, B]) log(u.problems.length === 0, `${u.name}: zero console errors, page errors and failed requests${u.problems.length ? ` (${u.problems.slice(0, 3).join(' | ')})` : ''}`);
await browser.close();
console.log(failures.length ? `${failures.length} FAILED` : 'ALL PASSED');
process.exit(failures.length ? 1 : 0);
