// Drives /orders and /issue in a real browser against a live API: the portfolio and claim center for an empty wallet and for wallets with history,
// and the issuer readiness checklist in its failing and passing states, in light and dark at 1440 and 390. Each page must show zero console
// errors, no failed requests, no horizontal overflow and no axe violations (WCAG 2.2 AA rules). Screenshots are written for reading.
//
//   BASE_URL=http://localhost:3400 API_URL=https://<api> BUYER_KEY=.keys/live-buyer.json OPERATOR_KEY=.keys/opening-bell-devnet.json \
//   OUT=<dir> CHROME=<chrome.exe> node e2e/orders-issuer-check.mjs
//
// Keys are Solana CLI keypair files, read only here and handed to the page as a disposable test wallet; they are never printed.
import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { AxeBuilder } from '@axe-core/playwright';
import { chromium } from '@playwright/test';

const BASE = process.env.BASE_URL ?? 'http://localhost:3400';
const OUT = process.env.OUT ?? 'e2e/screens/orders-issuer';
const BASE_MINT = process.env.BASE_MINT ?? 'HV2P22LJPewKomy7aN4CV1dTd2Dwpsi6Ta76fDAJFXQc';
const QUOTE_MINT = process.env.QUOTE_MINT ?? 'B78M2HhTHtR2wF3oxR4ikkBupc5TgtBbQbukYXwJEizm';
mkdirSync(OUT, { recursive: true });
const WALLET_JS = readFileSync(new URL('./test-wallet.js', import.meta.url), 'utf8');
const key = (p) => JSON.parse(readFileSync(p, 'utf8'));
const fresh = () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const seed = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32);
  const pub = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  return [...seed, ...pub];
};
const WALLETS = { empty: fresh(), buyer: key(process.env.BUYER_KEY), operator: key(process.env.OPERATOR_KEY) };
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const b58 = (bytes) => {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let s = '';
  while (n > 0n) { s = ALPHABET[Number(n % 58n)] + s; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; s = '1' + s; }
  return s;
};
const addr = (k) => b58(Uint8Array.from(k.slice(32)));

const browser = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
const failures = [];
const log = (ok, what) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${what}`); if (!ok) failures.push(what); };

async function open(who, theme, vp) {
  const ctx = await browser.newContext({ viewport: vp, colorScheme: theme, timezoneId: 'UTC' });
  await ctx.addInitScript(`window.__E2E_WALLET__ = ${JSON.stringify({ name: 'E2E Test Wallet', secret: WALLETS[who], chain: 'solana:devnet' })};`);
  await ctx.addInitScript(WALLET_JS);
  const page = await ctx.newPage();
  const problems = [];
  page.on('console', (m) => m.type() === 'error' && problems.push(`console: ${m.text()}`));
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('response', (r) => { if (r.status() >= 400 && !/[?&]_rsc=/.test(r.url())) problems.push(`http ${r.status()}: ${r.request().method()} ${r.url().slice(0, 100)}`); });
  page.on('requestfailed', (r) => { if (r.failure()?.errorText !== 'net::ERR_ABORTED') problems.push(`requestfailed: ${r.url()} ${r.failure()?.errorText}`); });
  return { ctx, page, problems, address: addr(WALLETS[who]) };
}
async function connect(u) {
  const option = u.page.getByRole('button', { name: /E2E Test Wallet/ });
  for (let attempt = 1; !(await option.isVisible()); attempt++) {
    if (attempt > 8) throw new Error('the wallet list never opened');
    await u.page.getByRole('button', { name: 'Connect wallet' }).click();
    await option.waitFor({ timeout: 4000 }).catch(() => undefined);
  }
  await option.click();
  await u.page.getByLabel(`Connected as ${u.address}`).waitFor();
}
async function audit(u, name) {
  const overflow = await u.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (overflow > 0) u.problems.push(`horizontal overflow: ${overflow}px`);
  const axe = await new AxeBuilder({ page: u.page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  for (const v of axe.violations) u.problems.push(`axe ${v.id}: ${v.help} (${v.nodes.length}) ${v.nodes.slice(0, 2).map((n) => n.target.join(' ')).join(' | ')}`);
  // WCAG 2.2 target size (2.5.8): a visible control smaller than 24 x 24 CSS px passes only if a 24px circle centred on it touches no other
  // control and no other undersized control's circle; links inside a sentence are exempt. The skip link is 1px until it takes focus.
  const small = await u.page.evaluate(() => {
    const all = [...document.querySelectorAll('button, input:not([type=hidden]), select, summary, a[href]')].map((e) => ({ e, r: e.getBoundingClientRect() })).filter(({ e, r }) => r.width > 1 && r.height > 1 && getComputedStyle(e).visibility !== 'hidden' && !e.closest('[hidden]') && !(e.matches('input') && e.className.includes('sr-only')));
    const under = all.filter(({ e, r }) => (r.width < 24 || r.height < 24) && !(e.matches('a') && e.closest('p, li, dd, dt') && getComputedStyle(e).display === 'inline'));
    const circle = (r) => ({ x: r.left + r.width / 2, y: r.top + r.height / 2, rad: 12 });
    const hitsRect = (c, r) => { const dx = Math.max(r.left - c.x, 0, c.x - r.right); const dy = Math.max(r.top - c.y, 0, c.y - r.bottom); return dx * dx + dy * dy < c.rad * c.rad; };
    return under.filter((t) => {
      const c = circle(t.r);
      return all.some((o) => o !== t && hitsRect(c, o.r) && !o.e.contains(t.e) && !t.e.contains(o.e)) || under.some((o) => o !== t && Math.hypot(circle(o.r).x - c.x, circle(o.r).y - c.y) < 24);
    }).map(({ e, r }) => `${e.tagName.toLowerCase()} "${(e.textContent || e.getAttribute('aria-label') || '').trim().slice(0, 30)}" ${Math.round(r.width)}x${Math.round(r.height)}`);
  });
  for (const s of small) u.problems.push(`target size < 24px: ${s}`);
  await u.page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
  log(u.problems.length === 0, `${name}`);
  for (const p of u.problems) console.log(`    ${p}`);
  u.problems.length = 0;
}

const VPS = { desktop: { width: 1440, height: 900 }, mobile: { width: 390, height: 844 } };
const COMBOS = [['light', 'desktop'], ['dark', 'mobile'], ['dark', 'desktop'], ['light', 'mobile']];

// ---------------------------------------------------------------- /orders
for (const who of ['empty', 'operator', 'buyer']) {
  for (const [theme, vp] of COMBOS) {
    const u = await open(who, theme, VPS[vp]);
    await u.page.goto(`${BASE}/orders`, { waitUntil: 'domcontentloaded' });
    await u.page.getByRole('heading', { level: 1 }).waitFor();
    await connect(u);
    await u.page.getByTestId(who === 'empty' ? 'no-orders' : 'portfolio').waitFor({ timeout: 180_000 });
    await u.page.waitForTimeout(500);
    if (who === 'empty') log((await u.page.getByTestId('no-orders').innerText()).includes('No activity yet'), `empty wallet shows the no-activity state (${theme} ${vp})`);
    else {
      const t = await u.page.getByTestId('portfolio').innerText();
      log(/Paid for fills/.test(t) && /Average price paid/.test(t) && /Better than your limits/.test(t), `${who} portfolio shows paid, average price and improvement (${theme} ${vp})`);
      log((await u.page.getByTestId('claim-center').count()) === 1, `${who} sees the claim center (${theme} ${vp})`);
    }
    await audit(u, `orders-${who}-${theme}-${vp}`);
    await u.ctx.close();
  }
}

// ---------------------------------------------------------------- /issue: the checklist failing, then passing
async function fillMints(u) {
  await u.page.getByLabel('Token being sold (base mint)').fill(BASE_MINT);
  await u.page.getByRole('button', { name: 'Check mint' }).nth(0).click();
  await u.page.getByText('6 decimals').first().waitFor({ timeout: 30_000 });
  await u.page.getByLabel('Paid in (quote mint)').fill(QUOTE_MINT);
  await u.page.getByRole('button', { name: 'Check mint' }).nth(1).click();
  await u.page.getByTestId('check-authority').waitFor({ timeout: 30_000 });
  await u.page.waitForFunction(() => document.querySelector('[data-testid="check-authority"]')?.getAttribute('data-status') !== 'wait', null, { timeout: 30_000 });
}
const status = (u, id) => u.page.getByTestId(`check-${id}`).getAttribute('data-status');
for (const [theme, vp] of [['light', 'desktop'], ['dark', 'mobile']]) {
  const u = await open('operator', theme, VPS[vp]);
  await u.page.goto(`${BASE}/issue`, { waitUntil: 'domcontentloaded' });
  await connect(u);
  await u.page.getByLabel('Token being sold (base mint)').waitFor();
  await fillMints(u);
  // The base mint has no mint authority, so minting mode must fail and Create must stay off.
  log((await status(u, 'authority')) === 'fail', `fail state: a mint with no authority fails minting mode (${theme} ${vp})`);
  log(await u.page.getByRole('button', { name: 'Create the cross' }).isDisabled(), `fail state: Create the cross is disabled (${theme} ${vp})`);
  log((await u.page.getByTestId('readiness-summary').innerText()).includes('not ready'), `fail state: the summary says what is not ready (${theme} ${vp})`);
  await audit(u, `issue-fail-${theme}-${vp}`);
  // Choose escrow supply through a preset: the authority item passes and, with SOL, quote tokens and a future window, Create turns on.
  await u.page.getByTestId('preset-reopen').click();
  await u.page.getByTestId('preset-note').waitFor();
  await u.page.waitForFunction(() => document.querySelector('[data-testid="check-authority"]')?.getAttribute('data-status') === 'pass', null, { timeout: 15_000 });
  const ids = ['authority', 'decimals', 'programs', 'rent', 'quote', 'window', 'form'];
  const statuses = Object.fromEntries(await Promise.all(ids.map(async (id) => [id, await status(u, id)])));
  log(ids.every((id) => statuses[id] === 'pass'), `pass state: every checklist item passes (${theme} ${vp}) ${JSON.stringify(statuses)}`);
  log(await u.page.getByRole('button', { name: 'Create the cross' }).isEnabled(), `pass state: Create the cross is enabled (${theme} ${vp})`);
  console.log('    cost:', (await u.page.getByTestId('create-cost').innerText()).replace(/\s+/g, ' ').slice(0, 260));
  await audit(u, `issue-pass-${theme}-${vp}`);
  await u.ctx.close();
}
// A wallet that does not hold the quote mint or SOL fails those items honestly.
{
  const u = await open('empty', 'light', VPS.desktop);
  await u.page.goto(`${BASE}/issue`, { waitUntil: 'domcontentloaded' });
  await connect(u);
  await fillMints(u);
  await u.page.getByTestId('preset-reopen').click();
  await u.page.waitForTimeout(1500);
  log((await status(u, 'rent')) === 'fail' && (await status(u, 'quote')) === 'fail', 'an empty wallet fails the SOL and quote-account items, with reasons');
  log(await u.page.getByRole('button', { name: 'Create the cross' }).isDisabled(), 'an empty wallet cannot create');
  await audit(u, 'issue-empty-wallet-light-desktop');
  await u.ctx.close();
}
await browser.close();
console.log(failures.length ? `\n${failures.length} FAILED` : '\nall passed');
process.exit(failures.length ? 1 : 0);
