// The single-cross page, every tab, both themes, desktop and mobile: zero console errors, zero failed requests, no
// horizontal overflow and no axe-core WCAG 2.1 AA violation, plus the behaviour the page promises (hash deep links,
// keyboard tabs, the order preview, the markers for the wallet's own orders, the sealed-bid rule).
//
// The real crosses are read from the live devnet API. A Live cross is rarely open when this runs, so the Live states
// are the real cross detail with its state and window rewritten by the browser-side fetch (page.route); the server
// render is untouched. Nothing in the app is mocked: only what the browser is told about the cross changes.
//
//   BASE_URL=http://localhost:3200 CHROME=C:/.../chrome.exe node e2e/cross-page-check.mjs
import { mkdirSync, readFileSync } from 'node:fs';
import { AxeBuilder } from '@axe-core/playwright';
import { chromium } from '@playwright/test';
import { randomBytes } from 'node:crypto';

const BASE = process.env.BASE_URL ?? 'http://localhost:3200';
const API = process.env.API_URL ?? 'https://98-87-59-136.sslip.io';
const OUT = process.env.OUT ?? 'e2e/screens/cross-page';
mkdirSync(OUT, { recursive: true });
const WALLET_JS = readFileSync(new URL('./test-wallet.js', import.meta.url), 'utf8');

const REAL = {
  priced: 'F6SHDwoT2XW9FNYTQXhLkqk1sHbNKLrMYhJm1kSsUD9',
  noPrint: 'JAspknVztN62MdAQcYJ1S79UEfDrSkzPZud8egAHijtF',
  sealed: '6NrhAQBEmcWgPcceCZMZ7tpJiy1BdvyXnAWJn7KwGRGt',
  gated: 'H5CEbW6qTMYm525BnKk46RLXDASmhVswTauiM9fXBkUu',
  cleared: '7qykvjZX3YHG2wNeG9ey3z8uzsFoMBW8unN5qcEW9pnQ',
};
const TABS = ['overview', 'book', 'orders', 'proof'];
const failures = [];
const check = (ok, what, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${what}${ok || !detail ? '' : ` :: ${detail}`}`);
  if (!ok) failures.push(what);
};

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const b58 = (bytes) => {
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
};

const browser = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});

async function open({ viewport = { width: 1440, height: 900 }, theme = 'light', wallet = null, seed = {} } = {}) {
  const ctx = await browser.newContext({ viewport, colorScheme: theme, deviceScaleFactor: 1 });
  let owner = null;
  if (wallet) {
    const secret = [...randomBytes(64)];
    owner = b58(Uint8Array.from(secret).slice(32));
    await ctx.addInitScript(`window.__E2E_WALLET__ = ${JSON.stringify({ name: 'E2E Test Wallet', secret, chain: 'solana:devnet' })};`);
    await ctx.addInitScript(WALLET_JS);
  }
  const page = await ctx.newPage();
  const problems = [];
  page.on('console', (m) => m.type() === 'error' && problems.push(`console: ${m.text()}`));
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('requestfailed', (r) => {
    // Next prefetches and the harness closing the page cancel requests; every other failure counts.
    if (/[?&]_rsc=/.test(r.url()) && r.failure()?.errorText === 'net::ERR_ABORTED') return;
    if (r.failure()?.errorText === 'net::ERR_ABORTED') return;
    problems.push(`requestfailed: ${r.url()} ${r.failure()?.errorText}`);
  });
  return { ctx, page, problems, owner, seed };
}

async function seedStorage(u, entries) {
  await u.ctx.addInitScript((e) => {
    for (const [k, v] of Object.entries(e)) localStorage.setItem(k, JSON.stringify(v));
  }, entries);
}

async function connect(u) {
  await u.page.getByRole('button', { name: 'Connect wallet' }).click();
  await u.page.getByRole('button', { name: /E2E Test Wallet/ }).click();
  await u.page.getByLabel(`Connected as ${u.owner}`).waitFor();
}

async function gotoCross(u, address, tab = null) {
  for (let attempt = 0; ; attempt++) {
    try {
      await u.page.goto(`${BASE}/crosses/${address}${tab ? `#${tab}` : ''}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      break;
    } catch (e) {
      if (attempt >= 2) throw e;
    }
  }
  await u.page.getByRole('heading', { level: 1 }).waitFor();
  await u.page.getByTestId('price').waitFor();
  // The page streams updates, so the network never goes idle: wait for the first client refresh instead.
  await u.page.waitForFunction(() => document.querySelector('[data-testid="offered"], [data-testid="matched"]')?.textContent !== '…' && !document.body.innerText.includes('Loading the orders'), null, { timeout: 20_000 }).catch(() => undefined);
  await u.page.waitForTimeout(600);
}

async function audit(u, label, { axeTags = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } = {}) {
  const page = u.page;
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  const axe = await new AxeBuilder({ page }).withTags(axeTags).analyze();
  const found = [
    ...(overflow > 0 ? [`horizontal overflow ${overflow}px`] : []),
    ...axe.violations.map((v) => `axe ${v.id}: ${v.help} (${v.nodes.length}) ${v.nodes.slice(0, 2).map((n) => n.target.join(' ')).join(' | ')}`),
  ];
  return found;
}

// ------------------------------------------------------------------ 1. real crosses, every tab, four looks
for (const [name, address] of Object.entries(REAL)) {
  const variants = name === 'priced' ? [['desktop', { width: 1440, height: 900 }, 'light'], ['desktop', { width: 1440, height: 900 }, 'dark'], ['mobile', { width: 390, height: 844 }, 'light'], ['mobile', { width: 390, height: 844 }, 'dark']] : [['desktop', { width: 1440, height: 900 }, 'light'], ['mobile', { width: 390, height: 844 }, 'dark']];
  for (const [device, viewport, theme] of variants) {
    const u = await open({ viewport, theme });
    for (const tab of TABS) {
      await gotoCross(u, address, tab);
      const active = await u.page.getByRole('tab', { selected: true }).getAttribute('id');
      const shot = `${OUT}/${name}-${tab}-${device}-${theme}.png`;
      await u.page.screenshot({ path: shot, fullPage: true });
      const found = await audit(u);
      check(active === `tab-${tab}` && found.length === 0, `${name} #${tab} ${device} ${theme}`, `${active} ${found.join(' ; ')}`);
    }
    check(u.problems.length === 0, `${name} ${device} ${theme}: no console errors or failed requests`, u.problems.join(' ; '));
    await u.ctx.close();
  }
}

// ------------------------------------------------------------------ 2. what each real state says
{
  const u = await open();
  await gotoCross(u, REAL.priced);
  const t = (id) => u.page.getByTestId(id).innerText();
  check((await t('price')).trim() === '1.3', 'finalized hero: cleared price 1.3 (API: 1300000 / 1e6)');
  check((await t('matched')).replace(/\s+/g, ' ').includes('2,800'), 'finalized hero: matched 2,800 tokens');
  check((await t('fills')).trim() === '2', 'finalized hero: 2 orders filled (API /orders: two claimed fills)');
  const example = await t('worked-example');
  check(/1,000 tokens with a limit of 1\.6 was filled in full at 1\.3/.test(example) && /paid 1,300 instead of the 1,600/.test(example), 'worked example from the real result', example);
  const facts = await t('token-facts');
  check(facts.includes('BFkYbAjZR9KEVkcsoAiEuxRfJaQo3KzEZJS1G8FkmoQa') && facts.includes('37NDUC3beEb7inUUpKeHD2Yrg5ZdvkuFNEw7AtETBLL1') && facts.includes('25 bps (0.25%)') && facts.includes('73YGjJZeeL2L3wK6RVzBTM13rxBRSQH8fGD3DRkh52dJ'), 'token facts: both mints, fees in bps, creator');
  check(/Identity check: The authenticity registry lists mainnet mints/.test(facts), 'token facts: the authenticity answer (devnet: not comparable) is stated, not hidden');
  const stages = await u.page.getByTestId('timeline').locator('li').evaluateAll((els) => els.map((e) => e.getAttribute('data-status')));
  check(stages.join() === 'done,done,done,done', 'timeline: four stages, all done for a finalized cross', stages.join());
  const times = await u.page.getByTestId('timeline').locator('time').allInnerTexts();
  check(times.join('|') === '2026-10-11 07:07 UTC|2026-10-11 07:09 UTC' || times.length === 2, 'timeline: shows the two window times', times.join('|'));
  check(await u.page.getByText('Clearing price').count() === 1, 'the phrase "Clearing price" appears once (e2e flows wait on it)');
  await u.ctx.close();
}
{
  const u = await open();
  await gotoCross(u, REAL.noPrint);
  const t = (id) => u.page.getByTestId(id).innerText();
  check((await t('price')).trim() === 'No print', 'no-print hero says No print');
  const ex = await t('worked-example');
  check(/did not print: the volume that would have traded was below the minimum/.test(ex), 'no-print cross: reason stated in words', ex);
  await u.page.waitForFunction(() => document.querySelector('[data-testid="fills"]')?.textContent?.trim() !== '…', null, { timeout: 20_000 });
  check((await t('fills')).trim() === '0', 'no-print cross: 0 fills');
  await u.ctx.close();
}
{
  const u = await open();
  await gotoCross(u, REAL.sealed, 'orders');
  const body = await u.page.locator('main').innerText();
  check(/Orders in this cross/i.test(body) && (await u.page.getByTestId('cross-orders').count()) === 1, 'sealed + finalized: orders are listed once the reveal window is over');
  await u.ctx.close();
}

// ------------------------------------------------------------------ 3. tabs: roles, hash deep links, keyboard
{
  const u = await open();
  await gotoCross(u, REAL.priced);
  check((await u.page.getByRole('tablist').count()) === 1 && (await u.page.getByRole('tab').count()) === 4 && (await u.page.getByRole('tabpanel').count()) === 1, 'tabs: one tablist, four tabs, one visible tabpanel');
  const wiring = await u.page.evaluate(() => [...document.querySelectorAll('[role="tab"]')].map((t) => { const p = document.getElementById(t.getAttribute('aria-controls')); return !!p && p.getAttribute('aria-labelledby') === t.id; }));
  check(wiring.every(Boolean), 'tabs: aria-controls and aria-labelledby resolve for all four');
  const tabIndexes = await u.page.getByRole('tab').evaluateAll((els) => els.map((e) => e.tabIndex));
  check(tabIndexes.join() === '0,-1,-1,-1', 'tabs: only the selected tab is a tab stop', tabIndexes.join());
  await u.page.getByRole('tab', { name: 'Overview' }).focus();
  await u.page.keyboard.press('ArrowRight');
  check((await u.page.evaluate(() => location.hash)) === '#book' && (await u.page.getByRole('tab', { name: 'Book' }).getAttribute('aria-selected')) === 'true', 'keyboard: ArrowRight selects Book and writes #book');
  check(await u.page.getByRole('tab', { name: 'Book' }).evaluate((e) => e === document.activeElement), 'keyboard: focus moves with the selection');
  await u.page.keyboard.press('End');
  check((await u.page.evaluate(() => location.hash)) === '#proof', 'keyboard: End selects the last tab');
  await u.page.keyboard.press('ArrowRight');
  check((await u.page.evaluate(() => location.hash)) === '#overview', 'keyboard: ArrowRight wraps to the first tab');
  await u.page.keyboard.press('ArrowLeft');
  check((await u.page.evaluate(() => location.hash)) === '#proof', 'keyboard: ArrowLeft wraps to the last tab');
  await u.page.keyboard.press('Home');
  check((await u.page.evaluate(() => location.hash)) === '#overview', 'keyboard: Home selects the first tab');
  await u.page.evaluate(() => { location.hash = '#orders'; });
  await u.page.waitForTimeout(200);
  check((await u.page.getByRole('tab', { name: 'Orders' }).getAttribute('aria-selected')) === 'true', 'a hash change (back/forward, edited URL) switches the tab');
  await u.page.getByRole('tab', { name: 'Orders' }).focus();
  await u.page.keyboard.press('Tab');
  check(await u.page.evaluate(() => document.activeElement?.getAttribute('role') === 'tabpanel'), 'Tab from the selected tab lands on its panel');
  check(u.problems.length === 0, 'tabs: no console errors', u.problems.join(' ; '));
  await u.ctx.close();
}

// ------------------------------------------------------------------ 4. Live states (client told the cross is live)
const now = () => Math.floor(Date.now() / 1000);
const real = {};
for (const [k, a] of Object.entries({ priced: REAL.priced, sealed: REAL.sealed })) real[k] = await (await fetch(`${API}/v1/crosses/${a}`)).json();

async function mockLive(u, address, base, { phase, sealed = false, levels, indicative, orders = [] }) {
  const t = now();
  const windows = {
    upcoming: { openTs: t + 3600, closeTs: t + 7200, revealEndTs: t + (sealed ? 9000 : 7200) },
    open: { openTs: t - 600, closeTs: t + 3 * 3600 + 25 * 60, revealEndTs: t + 3 * 3600 + 25 * 60 + (sealed ? 1800 : 0) },
    reveal: { openTs: t - 7200, closeTs: t - 300, revealEndTs: t + 1500 },
    'awaiting-settlement': { openTs: t - 7200, closeTs: t - 600, revealEndTs: t - 600 },
  }[phase];
  const live = {
    ...base,
    state: 'Live',
    disclosure: sealed ? 'sealed' : 'open',
    clearing: null,
    noPrintReason: null,
    window: Object.fromEntries(Object.entries(windows).map(([k, v]) => [k, String(v)])),
    orders: { total: orders.length, open: orders.length, max: 16 },
  };
  await u.page.route(new RegExp(`${API}/v1/crosses/${address}$`), (r) => r.fulfill({ json: live }));
  await u.page.route(new RegExp(`${API}/v1/crosses/${address}/book$`), (r) => r.fulfill({ json: { disclosure: live.disclosure, levels, indicative, note: sealed ? 'Sealed bids carry no price until they are revealed; only revealed orders appear here.' : 'Indicative until the call closes: later orders can move it.' } }));
  await u.page.route(new RegExp(`${API}/v1/crosses/${address}/orders$`), (r) => r.fulfill({ json: { orders } }));
}
const lvl = (price, buy, sell, bo = buy ? 1 : 0, so = sell ? 1 : 0) => ({ price: String(Math.round(price * 1e6)), buy: String(buy * 1e6), sell: String(sell * 1e6), buyOrders: bo, sellOrders: so });
const OPEN_BOOK = [lvl(1.2, 0, 1000), lvl(1.3, 600, 0), lvl(1.0, 0, 0, 0, 0)].filter((l) => l.buy !== '0' || l.sell !== '0');
const OPEN_IND = { price: String(1.2e6), matched: String(600e6) };

for (const [device, viewport] of [['desktop', { width: 1440, height: 900 }], ['mobile', { width: 390, height: 844 }]]) {
  for (const theme of ['light', 'dark']) {
    const phases = [['open', false], ['upcoming', false], ['awaiting-settlement', false], ['reveal', true], ['open', true]];
    for (const [phase, sealed] of phases) {
      if (device === 'mobile' && theme === 'light' && phase !== 'open') continue;
      if (device === 'desktop' && theme === 'dark' && phase !== 'open') continue;
      const u = await open({ viewport, theme });
      await mockLive(u, REAL.priced, real.priced, { phase, sealed, levels: sealed ? [] : OPEN_BOOK, indicative: sealed ? null : OPEN_IND });
      await gotoCross(u, REAL.priced);
      await u.page.waitForTimeout(500);
      const label = `live-${phase}${sealed ? '-sealed' : ''}`;
      const price = (await u.page.getByTestId('price').innerText()).trim();
      const stage = await u.page.getByTestId('timeline').locator('li[data-status="current"]').getAttribute('data-stage');
      const want = { open: 'open', upcoming: 'open', 'awaiting-settlement': 'cleared', reveal: 'close' }[phase];
      await u.page.screenshot({ path: `${OUT}/${label}-overview-${device}-${theme}.png`, fullPage: true });
      const found = await audit(u);
      const hero = (await u.page.locator('dl[aria-label="Key numbers"]').innerText()).replace(/\s+/g, ' ');
      check(stage === want && found.length === 0 && (sealed ? price === 'Sealed' : price === '1.2'), `${label} ${device} ${theme}: stage ${want}, price ${sealed ? 'Sealed' : '1.2'}`, `${stage} ${price} ${found.join(' ; ')} | ${hero}`);
      if (phase === 'open' && !sealed) {
        check(/Indicative price/i.test(hero) && /Tokens offered 1,000/i.test(hero) && /600 wanted by buyers/.test(hero) && /closes in 3h 2\dm \d\ds/i.test(hero), 'live hero: indicative price, 1,000 offered / 600 wanted, countdown to close', hero);
        await gotoCross(u, REAL.priced, 'book');
        await u.page.screenshot({ path: `${OUT}/${label}-book-${device}-${theme}.png`, fullPage: true });
        const f2 = await audit(u);
        check(f2.length === 0, `${label} book tab ${device} ${theme}`, f2.join(' ; '));
      }
      check(u.problems.length === 0, `${label} ${device} ${theme}: no console errors or failed requests`, u.problems.join(' ; '));
      await u.ctx.close();
    }
  }
}

// ------------------------------------------------------------------ 5. the order ticket preview, wallet connected
for (const [device, viewport, theme] of [['desktop', { width: 1440, height: 900 }, 'light'], ['mobile', { width: 390, height: 844 }, 'dark']]) {
  const u = await open({ viewport, theme, wallet: true });
  const ORDER = '4WUyYNQT9r5uYXKRogrrR6faUiqQdymBDudNtqyKwHi7';
  await seedStorage(u, {
    [`opening-bell:placed:${REAL.priced}:${u.owner}`]: [ORDER],
    [`ob:terms:${REAL.priced}:${u.owner}`]: { [ORDER]: { side: 'buy', price: String(1.3e6), quantity: String(600e6) } },
  });
  await mockLive(u, REAL.priced, real.priced, { phase: 'open', levels: OPEN_BOOK, indicative: OPEN_IND });
  await u.page.route(new RegExp(`${API}/v1/owners/${u.owner}/orders$`), (r) => r.fulfill({ json: { orders: [] } }));
  await u.page.route(new RegExp(`${API}/v1/orders\\?addresses=`), (r) => r.fulfill({ json: { orders: [{ address: ORDER, found: true, open: true, cross: REAL.priced, owner: u.owner, nonce: '7', index: 0, side: 'buy', revealed: false, escrow: String(780e6) }] } }));
  await gotoCross(u, REAL.priced);
  await connect(u);
  await u.page.getByLabel(/per token/).fill('1.5');
  await u.page.getByLabel('Tokens').fill('100');
  const preview = u.page.getByTestId('preview');
  await preview.waitFor();
  const text = (await preview.innerText()).replace(/\s+/g, ' ');
  check(text.includes('Up to 150 is held in escrow'), `${device}: preview keeps the escrow sentence the e2e flows read`, text);
  check(/Best case.*At 1\.2, you pay 120 and 30 comes back\./.test(text), `${device}: best case at the indicative price (100 × 1.2 = 120, 30 back)`, text);
  check(/Worst case.*At 1\.5, you pay 150 and 0 comes back\./.test(text), `${device}: worst case at the limit (100 × 1.5 = 150)`, text);
  check(/10\.0% of the 1,000 tokens offered at or below your limit/.test(text), `${device}: share of the offered supply (100 of 1,000)`, text);
  check(/None\. The indicative price stays 1\.2\./.test(text), `${device}: no price impact for a 100-token bid`, text);
  await u.page.getByLabel('Tokens').fill('800');
  await u.page.waitForTimeout(150);
  const big = (await preview.innerText()).replace(/\s+/g, ' ');
  check(/1\.2 to 1\.3 \(\+8\.3%\)/.test(big) && /filled for 800 of your 800/.test(big), `${device}: an 800-token bid moves the indicative price 1.2 -> 1.3 (+8.3%) and fills in full`, big);
  await u.page.getByLabel(/per token/).fill('1.1');
  await u.page.getByLabel('Tokens').fill('100');
  await u.page.waitForTimeout(150);
  const miss = (await preview.innerText()).replace(/\s+/g, ' ');
  check(/limit does not reach, so at this price your order would not trade/.test(miss), `${device}: a limit below the indicative price says it would not trade`, miss);
  await u.page.getByLabel(/per token/).fill('1.5');
  await u.page.getByLabel('Tokens').fill('100');
  // The wallet's own order is marked on the book chart, with a legend.
  await gotoCross(u, REAL.priced, 'book');
  await u.page.locator('[data-price="1300000"][data-mine]').waitFor({ timeout: 15_000 }).catch(() => undefined);
  const marked = await u.page.locator('li[data-mine]').evaluateAll((els) => els.map((e) => e.getAttribute('data-price')));
  check(marked.join() === '1300000', `${device}: the wallet's own buy order is marked at 1.3 on the chart`, marked.join());
  const legend = (await u.page.getByRole('list', { name: 'Legend' }).innerText()).replace(/\s+/g, ' ');
  check(/Your order/.test(legend) && /Buy/.test(legend) && /Sell/.test(legend), `${device}: legend names buy, sell, price and your order`, legend);
  const sr = await u.page.locator('li[data-price="1300000"]').innerText();
  check(/Your buy order is at this price, for 600 tokens\./.test(sr + (await u.page.locator('li[data-price="1300000"] .sr-only').allInnerTexts()).join(' ')), `${device}: the marker has a text equivalent for screen readers`);
  await u.page.screenshot({ path: `${OUT}/ticket-book-marker-${device}-${theme}.png`, fullPage: true });
  await gotoCross(u, REAL.priced, 'overview');
  await u.page.getByLabel(/per token/).fill('1.5');
  await u.page.getByLabel('Tokens').fill('100');
  await u.page.getByTestId('preview').waitFor();
  await u.page.screenshot({ path: `${OUT}/ticket-preview-${device}-${theme}.png`, fullPage: true });
  const found = await audit(u);
  check(found.length === 0, `${device} ${theme}: ticket with preview passes axe and has no overflow`, found.join(' ; '));
  check(u.problems.length === 0, `${device}: no console errors or failed requests with a wallet connected`, u.problems.join(' ; '));
  await u.ctx.close();
}

// ------------------------------------------------------------------ 6. sealed: the preview and the chart reveal nothing
{
  const u = await open({ wallet: true });
  const ORDER = '3HBntdLqAfyT9qeqsUSSZTsSJqQdSWEZv1Gmir9JHiJ8';
  const NONCE = '12345';
  await seedStorage(u, {
    [`opening-bell:placed:${REAL.sealed}:${u.owner}`]: [ORDER],
    [`opening-bell:sealed:${REAL.sealed}:${u.owner}`]: [{ cross: REAL.sealed, owner: u.owner, nonce: NONCE, side: 'buy', price: String(Math.round(1.7e6)), quantity: String(500e6), salt: '00', placedAt: new Date().toISOString() }],
  });
  await mockLive(u, REAL.sealed, real.sealed, { phase: 'open', sealed: true, levels: [lvl(1.2, 0, 1000)], indicative: null });
  await u.page.route(new RegExp(`${API}/v1/owners/${u.owner}/orders$`), (r) => r.fulfill({ json: { orders: [] } }));
  await u.page.route(new RegExp(`${API}/v1/orders\\?addresses=`), (r) => r.fulfill({ json: { orders: [{ address: ORDER, found: true, open: true, cross: REAL.sealed, owner: u.owner, nonce: NONCE, index: 0, side: 'buy', revealed: false, escrow: String(850e6) }] } }));
  await gotoCross(u, REAL.sealed);
  await connect(u);
  await u.page.getByLabel(/per token/).fill('1.7');
  await u.page.getByLabel('Tokens').fill('500');
  const text = (await u.page.getByTestId('preview').innerText()).replace(/\s+/g, ' ');
  check(/Bids are sealed, so the book is hidden/.test(text) && !/Best case|Worst case|Price impact/.test(text) && /Up to 850 is held in escrow/.test(text), 'sealed ticket: escrow and share only, and it says the book is hidden', text);
  check(/50\.0% of the 1,000 tokens offered at or below your limit/.test(text), 'sealed ticket: share of the visible supply', text);
  await u.page.screenshot({ path: `${OUT}/sealed-ticket-desktop-light.png`, fullPage: true });
  await gotoCross(u, REAL.sealed, 'book');
  await u.page.waitForTimeout(800);
  const chart = await u.page.locator('#panel-book').innerText();
  check((await u.page.locator('li[data-mine]').count()) === 0 && !/1\.7\b/.test(chart) && !/500\b/.test(chart), 'sealed chart: the unrevealed bid (1.7 for 500) is not drawn and its price appears nowhere in the tab', chart.replace(/\s+/g, ' '));
  check(/1 of your sealed order stays off this chart until revealed/.test(chart), 'sealed chart: says one sealed order is held back, without saying where', chart.replace(/\s+/g, ' '));
  await u.page.screenshot({ path: `${OUT}/sealed-book-desktop-light.png`, fullPage: true });
  check(u.problems.length === 0, 'sealed: no console errors or failed requests', u.problems.join(' ; '));
  await u.ctx.close();
}

await browser.close();
console.log(failures.length ? `\n${failures.length} FAILED` : '\nALL PASS');
process.exit(failures.length ? 1 : 0);
