// Shared helpers for the holder-side browser runs: one isolated context per person with a disposable devnet wallet injected the way a
// real wallet extension registers, listeners that fail a page on any console error, page error, failed request or HTTP error, screenshots,
// and an accessibility scan against WCAG 2.2 AA.
import { mkdirSync, readFileSync } from 'node:fs';
import { chromium } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

export const CHROME = process.env.CHROME ?? 'C:/Users/prate/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe';
export const BASE = process.env.BASE_URL ?? 'http://localhost:3411';
export const OUT = process.env.OUT ?? 'C:/Users/prate/col/docs/evidence/screens/w2c';
mkdirSync(OUT, { recursive: true });
const WALLET_JS = readFileSync(new URL('./holder-wallet.js', import.meta.url), 'utf8');

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const keyFile = (name) => JSON.parse(readFileSync(`C:/Users/prate/col/.keys/${name}`, 'utf8'));

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function b58(bytes) {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let s = '';
  while (n > 0n) {
    s = ALPHABET[Number(n % 58n)] + s;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    s = '1' + s;
  }
  return s;
}
export const addressOf = (secret) => b58(Uint8Array.from(secret.slice(32)));

export async function launch(extra = {}) {
  return chromium.launch({ executablePath: CHROME, ...extra });
}

/** One person: own context, own storage, own wallet. `ignore` lists console/HTTP noise a page is allowed to produce (matched against the message). */
/** Chrome has no Push API in incognito, and a Playwright context is incognito: the push run needs a real profile directory. */
export async function persistentPerson({ name, secret, executablePath, dir, viewport = { width: 1440, height: 900 }, theme = 'light', ignore = [] }) {
  const context = await chromium.launchPersistentContext(dir, { executablePath, headless: false, viewport, colorScheme: theme, timezoneId: 'UTC', args: ['--no-first-run', '--no-default-browser-check'] });
  await context.grantPermissions(['notifications'], { origin: BASE });
  await context.addInitScript(`window.__E2E_WALLET__ = ${JSON.stringify({ name: 'E2E Test Wallet', secret, chain: 'solana:devnet' })};`);
  await context.addInitScript(WALLET_JS);
  const page = context.pages()[0] ?? (await context.newPage());
  const problems = [];
  const skip = (text) => ignore.some((i) => text.includes(i));
  page.on('console', (m) => m.type() === 'error' && !skip(m.text()) && problems.push(`console: ${m.text().slice(0, 300)}`));
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message.slice(0, 300)}`));
  return { name, context, page, problems, address: addressOf(secret), theme, viewport };
}

export async function person(browser, { name, secret = null, theme = 'light', viewport = { width: 1440, height: 900 }, permissions = [], ignore = [] }) {
  const context = await browser.newContext({ viewport, colorScheme: theme, timezoneId: 'UTC', deviceScaleFactor: 1, permissions });
  if (secret) {
    await context.addInitScript(`window.__E2E_WALLET__ = ${JSON.stringify({ name: 'E2E Test Wallet', secret, chain: 'solana:devnet' })};`);
    await context.addInitScript(WALLET_JS);
  }
  const page = await context.newPage();
  const problems = [];
  const skip = (text) => ignore.some((i) => text.includes(i));
  page.on('console', (m) => m.type() === 'error' && !skip(m.text()) && problems.push(`console: ${m.text().slice(0, 300)}`));
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message.slice(0, 300)}`));
  page.on('response', (r) => {
    if (r.status() >= 400 && !/[?&]_rsc=/.test(r.url()) && !skip(`${r.status()} ${r.url()}`)) problems.push(`http ${r.status()}: ${r.request().method()} ${r.url().slice(0, 140)}`);
  });
  page.on('requestfailed', (r) => {
    if (r.failure()?.errorText === 'net::ERR_ABORTED') return;
    problems.push(`requestfailed: ${r.url().slice(0, 140)} ${r.failure()?.errorText}`);
  });
  const address = secret ? addressOf(secret) : null;
  return { name, context, page, problems, address, theme, viewport };
}

export async function connect(u) {
  // A click that lands before the page has hydrated (or while a development server is still compiling) does nothing, as for a person:
  // wait for the page, then click again until the wallet list opens.
  await u.page.waitForLoadState('load');
  // A wallet approved earlier in this context reconnects silently on the next page.
  if (await u.page.getByLabel(`Connected as ${u.address}`).waitFor({ timeout: 2500 }).then(() => true, () => false)) return;
  const option = u.page.getByRole('button', { name: /E2E Test Wallet/ });
  for (let attempt = 1; !(await option.isVisible()); attempt++) {
    if (attempt > 12) throw new Error('the wallet list never opened');
    await u.page.getByRole('button', { name: 'Connect wallet' }).click({ timeout: 5000 }).catch(() => undefined);
    await option.waitFor({ timeout: 3000 }).catch(() => undefined);
  }
  await option.click();
  await u.page.getByLabel(`Connected as ${u.address}`).waitFor();
}

export const shot = (u, name) => u.page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });

/** axe-core with the WCAG 2.0 to 2.2 A and AA rule sets (2.2 adds target size and focus-not-obscured checks). Returns the violations. */
export async function axe(u, include = null) {
  let b = new AxeBuilder({ page: u.page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice']);
  if (include) b = b.include(include);
  const r = await b.analyze();
  return r.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.slice(0, 4).map((n) => ({ target: n.target.join(' '), summary: n.failureSummary?.split('\n')[1]?.trim() })) }));
}

export const results = [];
export function check(ok, what) {
  results.push({ ok, what });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${what}`);
  return ok;
}
export function report(u) {
  const ok = u.problems.length === 0;
  check(ok, `${u.name}: zero console errors, page errors, failed requests and HTTP errors${ok ? '' : ` (${u.problems.length}): ${u.problems.slice(0, 5).join(' | ')}`}`);
}

/** A click before the page has hydrated does nothing, as for a person: press again until the expected result appears. */
export async function clickUntil(page, button, result, { tries = 8, each = 4000 } = {}) {
  for (let i = 0; i < tries; i++) {
    await button.click({ timeout: 5000 }).catch(() => undefined);
    if (await result.waitFor({ timeout: each }).then(() => true, () => false)) return true;
  }
  return false;
}
