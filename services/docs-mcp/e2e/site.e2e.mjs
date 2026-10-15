// The documentation site in a real browser, against the real service: search, open a document, follow a link, in light and dark, on a
// desktop and on a phone, scanned against WCAG 2.2 AA, with zero console errors, page errors and failed requests.
//   DOCS_URL=http://127.0.0.1:8793 OUT=<screenshot dir> node e2e/site.e2e.mjs
import { mkdirSync } from 'node:fs';
import { chromium } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const URL_ = process.env.DOCS_URL ?? 'http://127.0.0.1:8793';
const OUT = process.env.OUT ?? 'screens';
const CHROME = process.env.CHROME ?? 'C:/Users/prate/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe';
mkdirSync(OUT, { recursive: true });
const results = [];
const check = (ok, what) => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${what}`); };

const browser = await chromium.launch({ executablePath: CHROME });
for (const [theme, size, label] of [['light', { width: 1280, height: 900 }, 'desktop'], ['dark', { width: 1280, height: 900 }, 'desktop'], ['light', { width: 390, height: 844 }, 'mobile'], ['dark', { width: 390, height: 844 }, 'mobile']]) {
  const ctx = await browser.newContext({ viewport: size, colorScheme: theme });
  const page = await ctx.newPage();
  const problems = [];
  page.on('console', (m) => m.type() === 'error' && problems.push(m.text()));
  page.on('pageerror', (e) => problems.push(e.message));
  page.on('requestfailed', (r) => problems.push(`failed ${r.url()}`));
  page.on('response', (r) => r.status() >= 400 && problems.push(`${r.status()} ${r.url()}`));
  const tag = `${label}-${theme}`;
  const scan = async (name) => {
    await page.screenshot({ path: `${OUT}/docs-${name}-${tag}.png`, fullPage: true });
    const v = (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice']).analyze()).violations;
    check(v.length === 0, `${name} ${tag}: no WCAG 2.2 AA violations${v.length ? ` ${JSON.stringify(v.map((x) => [x.id, x.nodes.slice(0, 2).map((n) => n.target.join(' '))])).slice(0, 500)}` : ''}`);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check(overflow <= 0, `${name} ${tag}: no horizontal scroll of the page (${overflow}px)`);
  };
  await page.goto(URL_);
  await page.getByRole('search').waitFor();
  await scan('home');
  await page.getByLabel('Search the documentation').fill('how is the clearing price chosen');
  await page.getByRole('button', { name: 'Search' }).click();
  await page.getByText(/results?$/).first().waitFor();
  check((await page.locator('.hit').count()) > 0, `search ${tag}: results with a file and line each`);
  await scan('search');
  await page.locator('.hit a').first().click();
  await page.locator('article').waitFor();
  check((await page.locator('h1, article :is(h2,h3,h4)').count()) > 0, `document ${tag}: opens as a rendered page with headings`);
  await scan('document');
  await page.goto(`${URL_}/doc?path=${encodeURIComponent('docs/CONFIGURATION.md')}`);
  await page.locator('table').first().waitFor();
  await scan('reference-table');
  check(problems.length === 0, `${tag}: zero console errors, page errors, failed requests and HTTP errors${problems.length ? ` ${problems.slice(0, 3).join(' | ')}` : ''}`);
  await ctx.close();
}
await browser.close();
console.log(`\n${results.filter(Boolean).length}/${results.length} checks passed`);
process.exit(results.every(Boolean) ? 0 : 1);
