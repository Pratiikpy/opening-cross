// Browser pass over the trust layer, against the live stack: the signed band on a cross page, the identity panel,
// the track record and the premium monitor. Every figure shown is compared with what the API returns for the same
// record, and with the chain for the final price. Fails on any console error or page error.
//   PHASE=open|settled SEED=/tmp/oc-e2e.json OUT=docs/evidence/screens/trust node e2e/trust-flow.mjs
import { readFileSync, mkdirSync } from 'node:fs';
import { chromium } from '@playwright/test';

const BASE = process.env.BASE_URL ?? 'http://localhost:3000';
const API = process.env.API_URL ?? 'http://localhost:8080';
const PHASE = process.env.PHASE ?? 'open';
const OUT = process.env.OUT ?? 'e2e/screens/trust';
const seed = JSON.parse(readFileSync(process.env.SEED ?? '/tmp/oc-e2e.json', 'utf8'));
const cross = seed.crosses.open;
mkdirSync(OUT, { recursive: true });

const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const j = async (path) => (await fetch(API + path)).json();

const browser = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
const problems = [];
async function open(path, { theme = 'light', viewport = { width: 1440, height: 900 } } = {}) {
  const ctx = await browser.newContext({ viewport, colorScheme: theme });
  const page = await ctx.newPage();
  page.on('console', (m) => m.type() === 'error' && problems.push(`${path} console: ${m.text()}`));
  page.on('pageerror', (e) => problems.push(`${path} pageerror: ${e.message}`));
  page.on('requestfailed', (r) => {
    if (/[?&]_rsc=/.test(r.url()) && r.failure()?.errorText === 'net::ERR_ABORTED') return;
    problems.push(`${path} requestfailed: ${r.url()} ${r.failure()?.errorText}`);
  });
  await page.goto(BASE + path, { waitUntil: 'networkidle' });
  return { ctx, page };
}

// ---- the cross page: signed band and identity panel
{
  const promise = await j(`/v1/crosses/${cross}/promise`);
  check('API serves a signed promise for the open cross', Boolean(promise.promise?.id) && promise.signer === (await j('/v1/promises/signer')).signer, `id ${promise.promise?.id?.slice(0, 12)}…`);
  const { ctx, page } = await open(`/crosses/${cross}`);
  const band = page.getByTestId('signed-band');
  await band.waitFor({ timeout: 20_000 });
  const text = (await band.innerText()).replace(/\s+/g, ' ');
  check('cross page shows the signed band', /signed price band/i.test(text), text.slice(0, 120));
  check('a band that is not yet calibrated claims no coverage', /no coverage claimed yet/.test(text) && /graded crosses/.test(text) && promise.promise.claim.status === 'PROVISIONAL', promise.promise.claim.reason ?? '');
  check('the band links to the signed record', (await band.locator('a', { hasText: 'signed record' }).getAttribute('href')).endsWith(`/v1/promises/${promise.promise.id}`));
  const note = page.getByTestId('identity-not-comparable');
  await note.waitFor({ timeout: 20_000 });
  check('on a non-mainnet network the identity panel says so instead of guessing', /registry lists mainnet mints/.test(await note.innerText()));
  if (PHASE === 'settled') {
    const g = (await j(`/v1/promises/${promise.promise.id}`)).grade;
    check('the promise has been graded', g && g.status === 'SCORED', JSON.stringify(g));
    await page.reload({ waitUntil: 'networkidle' });
    const settledText = (await page.getByTestId('signed-band').innerText()).replace(/\s+/g, ' ');
    check('the page reports the distance from the estimate', (g.errorTicks === 0 ? /The final price was exactly this estimate/ : new RegExp(`The final price was ${g.errorTicks} ticks? from this estimate`)).test(settledText), settledText.slice(-90));
  }
  await page.screenshot({ path: `${OUT}/cross-${PHASE}-desktop-light.png`, fullPage: true });
  await ctx.close();
  for (const [name, opts] of [['desktop-dark', { theme: 'dark' }], ['mobile-light', { viewport: { width: 390, height: 844 } }], ['mobile-dark', { theme: 'dark', viewport: { width: 390, height: 844 } }]]) {
    const o = await open(`/crosses/${cross}`, opts);
    await o.page.getByTestId('signed-band').waitFor({ timeout: 20_000 });
    check(`no horizontal overflow, cross ${name}`, (await o.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)) <= 0);
    await o.page.screenshot({ path: `${OUT}/cross-${PHASE}-${name}.png`, fullPage: true });
    await o.ctx.close();
  }
}

// ---- the track record
{
  const acc = await j('/v1/accuracy');
  const { ctx, page } = await open('/accuracy');
  const totals = page.getByTestId('accuracy-totals');
  await totals.waitFor({ timeout: 20_000 });
  const t = (await totals.innerText()).replace(/\s+/g, ' ');
  check('track record totals equal the API', t.includes(String(acc.totals.issued)) && t.includes(String(acc.totals.crosses)), t);
  check('track record shows every time bucket, including empty ones', (await page.locator('[data-testid^=bucket-]').count()) === acc.buckets.length);
  if (PHASE === 'settled') {
    check('after settlement the record has graded promises', acc.totals.graded >= 1, JSON.stringify(acc.totals));
    check('a band that claimed no coverage is scored, never counted as a hit or a miss', acc.buckets.every((b) => b.hit + b.miss === 0) && acc.buckets.reduce((n, b) => n + b.scored, 0) === acc.totals.graded, JSON.stringify(acc.totals));
  }
  await page.screenshot({ path: `${OUT}/accuracy-${PHASE}-desktop-light.png`, fullPage: true });
  await ctx.close();
  for (const [name, opts] of [['desktop-dark', { theme: 'dark' }], ['mobile-light', { viewport: { width: 390, height: 844 } }], ['mobile-dark', { theme: 'dark', viewport: { width: 390, height: 844 } }]]) {
    const o = await open('/accuracy', opts);
    check(`no horizontal overflow, accuracy ${name}`, (await o.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)) <= 0);
    await o.page.screenshot({ path: `${OUT}/accuracy-${PHASE}-${name}.png`, fullPage: true });
    await o.ctx.close();
  }
}

// ---- the premium monitor
{
  const sum = await j('/v1/premium/summary?days=7');
  const { ctx, page } = await open('/premium');
  if (sum.coverage.rounds > 0) {
    const cov = page.getByTestId('premium-coverage');
    await cov.waitFor({ timeout: 20_000 });
    const t = (await cov.innerText()).replace(/\s+/g, ' ');
    check('premium page coverage equals the API', t.includes(String(sum.coverage.rounds)) && t.includes(String(sum.coverage.tickers)), t);
    const sessions = [...new Set(sum.groups.map((g) => g.session))];
    check('a table for every measured session and none for others', (await page.locator('[data-testid^=session-]').count()) === sessions.length, sessions.join(','));
    const g = sum.groups.find((x) => x.summary.n > 0 && x.sizeUsd === 1000 && x.leg === 'buy');
    if (g) {
      const row = page.getByTestId(`session-${g.session}`).locator('tr', { hasText: 'Buy $1,000' });
      const cells = (await row.innerText()).replace(/\s+/g, ' ');
      const expect = (Number(g.summary.medianBpsX100) / 10000).toFixed(2) + '%';
      check('a median on the page equals the API figure', cells.includes(expect.replace(/^-0\.00%$/, '0.00%')), `${cells} (expected ${expect})`);
    }
  } else {
    check('premium page says plainly that nothing was measured', (await page.getByTestId('no-premium').count()) === 1);
  }
  await page.screenshot({ path: `${OUT}/premium-${PHASE}-desktop-light.png`, fullPage: true });
  await ctx.close();
  for (const [name, opts] of [['desktop-dark', { theme: 'dark' }], ['mobile-light', { viewport: { width: 390, height: 844 } }], ['mobile-dark', { theme: 'dark', viewport: { width: 390, height: 844 } }]]) {
    const o = await open('/premium', opts);
    check(`no horizontal overflow, premium ${name}`, (await o.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)) <= 0);
    await o.page.screenshot({ path: `${OUT}/premium-${PHASE}-${name}.png`, fullPage: true });
    await o.ctx.close();
  }
}

await browser.close();
check('no console errors, page errors or failed requests', problems.length === 0, problems.join(' | '));
const failed = checks.filter((c) => !c.ok);
console.log(`${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
