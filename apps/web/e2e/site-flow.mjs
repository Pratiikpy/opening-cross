// Site-level checks that are not tied to one cross: page metadata and the files crawlers and browsers ask for, the 404
// page, keyboard use of the header (skip link, mobile menu closing, wallet dialog), and the connected-wallet menu.
//   BASE_URL=http://localhost:3000 CHROME=/path/to/chrome node e2e/site-flow.mjs
// Exits non-zero on the first failure and on any console or page error.
import { chromium } from '@playwright/test';
import { AxeBuilder } from '@axe-core/playwright';

const BASE = process.env.BASE_URL ?? 'http://localhost:3000';
const browser = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
let failed = 0;
const pass = (m) => console.log(`PASS ${m}`);
const fail = (m) => {
  failed += 1;
  console.log(`FAIL ${m}`);
};
const check = (ok, m) => (ok ? pass(m) : fail(m));

// ---- files and metadata
{
  const get = async (p) => fetch(BASE + p, { redirect: 'manual' });
  const robots = await get('/robots.txt');
  check(robots.status === 200 && /User-Agent: \*/i.test(await robots.text()), 'robots.txt is served and allows crawling');
  const sitemap = await get('/sitemap.xml');
  check(sitemap.status === 200 && (sitemap.headers.get('content-type') ?? '').includes('xml'), 'sitemap.xml is served as XML');
  const manifest = await get('/manifest.webmanifest');
  const m = manifest.status === 200 ? await manifest.json() : null;
  check(m?.name === 'Opening Bell' && Array.isArray(m.icons) && m.icons.length > 0, 'web manifest names the app and lists an icon');
  for (const [path, type] of [['/icon.svg', 'svg'], ['/apple-icon', 'png'], ['/opengraph-image', 'png']]) {
    const r = await get(path);
    check(r.status === 200 && (r.headers.get('content-type') ?? '').includes(type), `${path} is served as ${type}`);
  }
  const missing = await get('/no-such-page');
  check(missing.status === 404, 'an unknown path answers 404');
}

const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const problems = [];
page.on('console', (m) => m.type() === 'error' && !/the server responded with a status of 404/.test(m.text()) && problems.push(`console: ${m.text()}`));
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));

// ---- head tags on the pages a stranger lands on
for (const [path, title] of [['/', /Opening Bell/], ['/crosses', /^Crosses/], ['/developers', /^Developers/], ['/status', /^Status/], ['/accuracy', /^Track record/], ['/premium', /^Premium monitor/], ['/orders', /^My orders/], ['/issue', /^Open a cross/]]) {
  await page.goto(BASE + path, { waitUntil: 'domcontentloaded' });
  check(title.test(await page.title()), `${path} has a specific title (${await page.title()})`);
  const tags = await page.evaluate(() => ({
    description: document.querySelector('meta[name="description"]')?.content ?? '',
    ogTitle: document.querySelector('meta[property="og:title"]')?.content ?? '',
    ogImage: document.querySelector('meta[property="og:image"]')?.content ?? '',
    twitter: document.querySelector('meta[name="twitter:card"]')?.content ?? '',
    icon: Boolean(document.querySelector('link[rel~="icon"]')),
    lang: document.documentElement.lang,
    h1: document.querySelectorAll('h1').length,
  }));
  check(tags.description.length > 40 && tags.ogTitle && tags.ogImage && tags.twitter && tags.icon && tags.lang === 'en', `${path} has description, Open Graph, Twitter card, icon and lang`);
  check(tags.h1 === 1, `${path} has exactly one h1`);
}

// ---- 404 page
await page.goto(BASE + '/crosses/not-a-real-address', { waitUntil: 'networkidle' });
check(await page.getByRole('heading', { name: /does not exist/i }).isVisible(), 'a malformed cross address shows the designed 404 page');
check(await page.getByRole('link', { name: 'Browse crosses' }).isVisible(), 'the 404 page offers a way back');
{
  const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  check(axe.violations.length === 0, `the 404 page passes axe (${axe.violations.map((v) => v.id).join(', ') || 'clean'})`);
}

// ---- keyboard: skip link and header order
await page.goto(BASE + '/', { waitUntil: 'networkidle' });
await page.keyboard.press('Tab');
check((await page.evaluate(() => document.activeElement?.textContent?.trim())) === 'Skip to content', 'the first Tab stop is the skip link');
await page.keyboard.press('Enter');
check((await page.evaluate(() => location.hash)) === '#main', 'the skip link jumps to the main content');
{
  const labels = await page.evaluate(() => [...document.querySelectorAll('header a, header button, header summary')].map((e) => (e.getAttribute('aria-label') ?? e.textContent ?? '').trim()).filter(Boolean));
  check(JSON.stringify(labels.slice(0, 4)) === JSON.stringify(['Opening Bell home', 'Crosses', 'Open a cross', 'Developers']), `the header carries three destinations (${labels.join(' | ')})`);
}
{
  const focus = await page.evaluate(() => {
    document.querySelector('header a')?.focus();
    const el = document.activeElement;
    const s = getComputedStyle(el);
    return { outline: s.outlineStyle, width: parseFloat(s.outlineWidth) };
  });
  check(focus.outline !== 'none' && focus.width >= 2, 'a focused header link shows a focus ring');
}

// ---- wallet dialog: opens, traps Escape, closes on backdrop click
await page.getByRole('button', { name: 'Connect wallet' }).click();
check(await page.getByRole('dialog', { name: 'Connect a wallet' }).isVisible(), 'Connect wallet opens a dialog');
check(await page.getByText(/No Solana wallet/).isVisible(), 'with no wallet installed the dialog says so and names where to get one');
await page.keyboard.press('Escape');
check(!(await page.getByRole('dialog').isVisible().catch(() => false)), 'Escape closes the wallet dialog');
await page.getByRole('button', { name: 'Connect wallet' }).click();
await page.mouse.click(5, 5);
check(!(await page.getByRole('dialog').isVisible().catch(() => false)), 'a click on the backdrop closes the wallet dialog');

// ---- orders page without a wallet
await page.goto(BASE + '/orders', { waitUntil: 'domcontentloaded' });
await page.getByText(/Connect a wallet with Connect wallet/).waitFor({ timeout: 10_000 }).catch(() => undefined);
check(await page.getByText(/Connect a wallet with Connect wallet/).isVisible(), 'the orders page asks a visitor to connect');

// ---- mobile menu
const mobile = await browser.newContext({ viewport: { width: 390, height: 844 } });
const m = await mobile.newPage();
m.on('pageerror', (e) => problems.push(`pageerror(mobile): ${e.message}`));
await m.goto(BASE + '/', { waitUntil: 'networkidle' });
const menu = m.locator('header details').first();
await menu.locator('summary').click();
check(await m.getByRole('link', { name: 'Track record' }).first().isVisible(), 'the mobile menu lists the trust pages under the three main ones');
await m.keyboard.press('Escape');
check(!(await menu.evaluate((d) => d.open)), 'Escape closes the mobile menu');
await menu.locator('summary').click();
await m.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Developers' }).click();
await m.waitForURL('**/developers');
check(!(await menu.evaluate((d) => d.open)), 'the mobile menu closes after choosing a page');
await menu.locator('summary').click();
await m.mouse.click(20, 600);
check(!(await menu.evaluate((d) => d.open)), 'a click outside closes the mobile menu');
check((await m.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)) <= 0, 'no horizontal overflow on the mobile developers page');

for (const p of problems) fail(p);
await browser.close();
console.log(failed ? `${failed} FAILED` : 'ALL PASSED');
process.exit(failed ? 1 : 0);
